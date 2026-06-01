"""GOSAI Python bridge.

Owns the registry of driver classes, instantiates them on demand, manages
their lifecycle, and pumps events to the Node-side server over stdio
newline-delimited JSON.

Drivers are discovered from:
- The `gosai_py.drivers` namespace (built-in drivers).
- Any modules listed via `register_drivers()` (used by app-shipped drivers).

Multi-instance / bindings
--------------------------
The same driver *class* can run as several independent instances, one per
"instance" namespace. The Node side decides the namespace (an app slug for
exclusive drivers like the camera, or `shared`/`shared:dev<n>` for shareable
drivers like the speaker) and passes it as `instance` on every request. Drivers,
subscriptions, and emitted events are all keyed by `(instance, name)` so two
apps can each bind their own camera without interfering.
"""

from __future__ import annotations

import json
import os
import pkgutil
import sys
import threading
import time
import traceback
from collections.abc import Callable
from importlib import import_module
from types import ModuleType
from typing import Any

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.version import __version__

JsonDict = dict[str, Any]

DEFAULT_INSTANCE = "system"


class _BridgeContext(DriverContext):
    """Bridge-internal helper that exposes the I/O surface to drivers.

    Bound to a single `(instance, driver)` so emits and internal subscriptions
    stay within the driver's instance namespace.
    """

    def __init__(self, bridge: Bridge, driver_name: str, instance: str) -> None:
        self._bridge = bridge
        self._driver = driver_name
        self._instance = instance

    def emit(self, event: str, data: Any) -> None:
        self._bridge._emit_event(self._instance, self._driver, event, data)

    def log(self, level: str, message: str) -> None:
        self._bridge._emit_log(level, self._driver, message)

    def record_performance(self, metric: str, value: float) -> None:
        self._bridge._emit_performance(self._driver, metric, value)

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._subscribe_internal(self._instance, driver, event, callback)

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._unsubscribe_internal(self._instance, driver, event, callback)

    def get_event_data(self, driver: str, event: str) -> Any:
        return self._bridge._get_event_data(self._instance, driver, event)


class Bridge:
    """Owns drivers and shuttles JSON between Node and Python."""

    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        # Dup the real stdout fd so driver code that redirects fd 1 (e.g. during
        # YOLO import) cannot corrupt the newline-delimited JSON protocol.
        self._stdout_fd = os.dup(1)
        self._running = False
        self._driver_classes: dict[str, type[BaseDriver]] = {}
        # Keyed by (instance, driver name).
        self._driver_instances: dict[tuple[str, str], BaseDriver] = {}
        # Keyed by (instance, driver, event).
        self._internal_subscribers: dict[
            tuple[str, str, str], list[Callable[[Any], None]]
        ] = {}
        self._external_subscribers: dict[tuple[str, str, str], int] = {}
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Driver registration
    # ------------------------------------------------------------------

    def register_module(self, module: ModuleType) -> None:
        """Register every BaseDriver subclass found in `module`."""
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if (
                isinstance(attr, type)
                and issubclass(attr, BaseDriver)
                and attr is not BaseDriver
                and attr.name
            ):
                self._driver_classes[attr.name] = attr

    def discover_builtin(self) -> None:
        """Walk `gosai_py.drivers` and register every driver module found."""
        try:
            pkg = import_module("gosai_py.drivers")
        except ImportError:
            return
        if not hasattr(pkg, "__path__"):
            return
        for module_info in pkgutil.iter_modules(pkg.__path__):
            try:
                module = import_module(f"gosai_py.drivers.{module_info.name}")
            except Exception as exc:
                self._emit_log("warn", "bridge", f"failed to load drivers.{module_info.name}: {exc!r}")
                continue
            self.register_module(module)

    # ------------------------------------------------------------------
    # I/O
    # ------------------------------------------------------------------

    def _write(self, message: JsonDict) -> None:
        line = json.dumps(message, separators=(",", ":"), default=_json_default) + "\n"
        data = line.encode("utf-8")
        with self._write_lock:
            os.write(self._stdout_fd, data)

    def _emit_event(self, instance: str, driver: str, event: str, data: Any) -> None:
        # External (Node-side) subscribers
        if (
            self._external_subscribers.get((instance, driver, event), 0) > 0
            or self._external_subscribers.get((instance, driver, "*"), 0) > 0
        ):
            self._write(
                {
                    "type": "event",
                    "instance": instance,
                    "driver": driver,
                    "event": event,
                    "data": data,
                    "ts": time.time(),
                }
            )
        # Internal (other Python drivers) subscribers
        callbacks = self._internal_subscribers.get((instance, driver, event), [])
        for cb in list(callbacks):
            try:
                cb(data)
            except Exception as exc:
                self._emit_log("warn", "bridge", f"subscriber failed: {exc!r}")

    def _emit_log(self, level: str, source: str, message: str) -> None:
        self._write(
            {
                "type": "log",
                "level": level,
                "source": source,
                "message": message,
                "ts": time.time(),
            }
        )

    def _emit_performance(self, source: str, metric: str, value: float) -> None:
        self._write(
            {
                "type": "performance",
                "source": source,
                "metric": metric,
                "value": value,
                "ts": time.time(),
            }
        )

    def _emit_driver_state(self, instance: str, driver: str, state: str) -> None:
        self._write(
            {"type": "driver-state", "instance": instance, "driver": driver, "state": state}
        )

    def _respond(self, req_id: str, ok: bool, data: Any = None, error: str | None = None) -> None:
        msg: JsonDict = {"type": "result", "id": req_id, "ok": ok}
        if ok:
            msg["data"] = data
        else:
            msg["error"] = error or "unknown error"
        self._write(msg)

    # ------------------------------------------------------------------
    # Driver lifecycle
    # ------------------------------------------------------------------

    def _start_driver(
        self, instance: str, name: str, config: JsonDict | None = None
    ) -> None:
        with self._lock:
            if (instance, name) in self._driver_instances:
                return
            cls = self._driver_classes.get(name)
            if cls is None:
                raise KeyError(f"unknown driver: {name}")
            # Resolve dependencies first, within the same instance namespace.
            for dep in cls.dependencies:
                if (instance, dep) not in self._driver_instances:
                    self._start_driver(instance, dep)
            obj = cls(_BridgeContext(self, cls.name, instance))
            if config and hasattr(obj, "apply_config"):
                obj.apply_config(config)
            self._driver_instances[(instance, name)] = obj
        self._emit_driver_state(instance, name, "starting")
        try:
            obj._bridge_start()
            self._emit_driver_state(instance, name, "running")
        except Exception:
            self._emit_driver_state(instance, name, "errored")
            raise

    def _stop_driver(self, instance: str, name: str) -> None:
        with self._lock:
            obj = self._driver_instances.pop((instance, name), None)
        if obj is None:
            return
        self._emit_driver_state(instance, name, "stopping")
        try:
            obj._bridge_stop()
        finally:
            self._emit_driver_state(instance, name, "available")

    def _list_drivers(self) -> JsonDict:
        return {
            "drivers": [
                {
                    "name": cls.name,
                    "description": cls.description,
                    "events": list(cls.events),
                    "actions": list(cls.actions),
                    "dependencies": list(cls.dependencies),
                    "shared": bool(getattr(cls, "shared", False)),
                }
                for cls in self._driver_classes.values()
            ]
        }

    def _list_cameras(self) -> JsonDict:
        from gosai_py.drivers.camera import CameraDriver

        return {"devices": CameraDriver.probe_devices()}

    def _list_audio_devices(self) -> JsonDict:
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"sounddevice not available: {exc}"}
        devices = sd.query_devices()
        defaults = sd.default.device
        default_in = defaults[0] if isinstance(defaults, (list, tuple)) else defaults
        default_out = defaults[1] if isinstance(defaults, (list, tuple)) else defaults
        microphones = [
            {
                "index": idx,
                "label": d.get("name") or f"Input {idx}",
                "is_default": idx == default_in,
            }
            for idx, d in enumerate(devices)
            if d.get("max_input_channels", 0) > 0
        ]
        speakers = [
            {
                "index": idx,
                "label": d.get("name") or f"Output {idx}",
                "is_default": idx == default_out,
            }
            for idx, d in enumerate(devices)
            if d.get("max_output_channels", 0) > 0
        ]
        return {"ok": True, "microphones": microphones, "speakers": speakers}

    def _get_event_data(self, instance: str, driver: str, event: str) -> Any:
        obj = self._driver_instances.get((instance, driver))
        if obj is None:
            return None
        return obj.get_event_data(event)

    def _execute(self, instance: str, driver: str, action: str, data: Any) -> Any:
        if driver == "camera" and action == "list_formats":
            from gosai_py.drivers.camera import CameraDriver

            device = 0
            if isinstance(data, dict) and "device" in data:
                device = int(data["device"])
            return CameraDriver.probe_formats(device)

        obj = self._driver_instances.get((instance, driver))
        if obj is None:
            raise KeyError(f"driver {driver!r} not running for instance {instance!r}")
        if action not in obj.actions:
            raise ValueError(f"driver {driver!r} does not support action {action!r}")
        return obj.execute(action, data)

    # ------------------------------------------------------------------
    # Subscriptions
    # ------------------------------------------------------------------

    def _subscribe_external(self, instance: str, driver: str, event: str) -> None:
        key = (instance, driver, event)
        with self._lock:
            self._external_subscribers[key] = self._external_subscribers.get(key, 0) + 1

    def _unsubscribe_external(self, instance: str, driver: str, event: str) -> None:
        key = (instance, driver, event)
        with self._lock:
            count = self._external_subscribers.get(key, 0) - 1
            if count <= 0:
                self._external_subscribers.pop(key, None)
            else:
                self._external_subscribers[key] = count

    def _subscribe_internal(
        self, instance: str, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        key = (instance, driver, event)
        with self._lock:
            self._internal_subscribers.setdefault(key, []).append(callback)

    def _unsubscribe_internal(
        self, instance: str, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        key = (instance, driver, event)
        with self._lock:
            callbacks = self._internal_subscribers.get(key)
            if not callbacks:
                return
            try:
                callbacks.remove(callback)
            except ValueError:
                return
            if not callbacks:
                self._internal_subscribers.pop(key, None)

    # ------------------------------------------------------------------
    # Request dispatch
    # ------------------------------------------------------------------

    def handle(self, request: JsonDict) -> None:
        req_type = request.get("type")
        req_id = request.get("id", "")
        instance = request.get("instance")
        if not isinstance(instance, str) or not instance:
            instance = DEFAULT_INSTANCE

        if req_type == "ping":
            self._write({"type": "pong", "id": req_id, "ts": time.time()})
            return

        if req_type == "list-drivers":
            self._respond(req_id, True, self._list_drivers())
            return

        if req_type == "list-cameras":
            try:
                self._respond(req_id, True, self._list_cameras())
            except Exception as exc:
                self._respond(req_id, False, error=f"{exc!r}")
            return

        if req_type == "list-audio-devices":
            try:
                self._respond(req_id, True, self._list_audio_devices())
            except Exception as exc:
                self._respond(req_id, False, error=f"{exc!r}")
            return

        if req_type == "start-driver":
            driver = request.get("driver")
            if not isinstance(driver, str):
                self._respond(req_id, False, error="driver name missing")
                return
            config = request.get("config")
            driver_config = config if isinstance(config, dict) else None
            try:
                self._start_driver(instance, driver, driver_config)
                self._respond(req_id, True, {"driver": driver, "state": "running"})
            except Exception as exc:
                self._respond(req_id, False, error=f"{exc!r}")
            return

        if req_type == "stop-driver":
            driver = request.get("driver")
            if not isinstance(driver, str):
                self._respond(req_id, False, error="driver name missing")
                return
            try:
                self._stop_driver(instance, driver)
                self._respond(req_id, True, {"driver": driver, "state": "available"})
            except Exception as exc:
                self._respond(req_id, False, error=f"{exc!r}")
            return

        if req_type == "subscribe":
            driver = request.get("driver")
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond(req_id, False, error="driver/event required")
                return
            self._subscribe_external(instance, driver, event)
            self._respond(req_id, True)
            return

        if req_type == "unsubscribe":
            driver = request.get("driver")
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond(req_id, False, error="driver/event required")
                return
            self._unsubscribe_external(instance, driver, event)
            self._respond(req_id, True)
            return

        if req_type == "get-data":
            driver = request.get("driver")
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond(req_id, False, error="driver/event required")
                return
            self._respond(req_id, True, self._get_event_data(instance, driver, event))
            return

        if req_type == "execute":
            driver = request.get("driver")
            action = request.get("action")
            data = request.get("data")
            if not isinstance(driver, str) or not isinstance(action, str):
                self._respond(req_id, False, error="driver/action required")
                return
            try:
                result = self._execute(instance, driver, action, data)
                self._respond(req_id, True, result)
            except Exception as exc:
                self._respond(req_id, False, error=f"{exc!r}")
            return

        if req_type == "shutdown":
            self._respond(req_id, True)
            self._running = False
            return

        self._respond(req_id, False, error=f"unknown request type: {req_type!r}")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def run(self) -> int:
        self._running = True
        self.discover_builtin()
        self._write({"type": "ready", "version": __version__})

        try:
            for raw_line in sys.stdin:
                if not self._running:
                    break
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    request = json.loads(line)
                except json.JSONDecodeError as exc:
                    self._emit_log("error", "bridge", f"invalid JSON request: {exc}")
                    continue
                try:
                    self.handle(request)
                except Exception as exc:
                    self._emit_log(
                        "error", "bridge", f"unhandled error: {exc!r}\n{traceback.format_exc()}"
                    )
        except KeyboardInterrupt:
            pass

        with self._lock:
            keys = list(self._driver_instances.keys())
        for inst, name in keys:
            try:
                self._stop_driver(inst, name)
            except Exception as exc:
                self._emit_log("warn", "bridge", f"failed to stop {name}: {exc!r}")
        return 0


def _json_default(value: Any) -> Any:
    """Fallback serializer for numpy arrays and other common cases."""
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "__iter__"):
        return list(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def main() -> int:
    return Bridge().run()


if __name__ == "__main__":
    sys.exit(main())
