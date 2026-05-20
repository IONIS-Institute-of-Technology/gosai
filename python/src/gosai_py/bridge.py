"""GOSAI Python bridge.

Owns the registry of driver classes, instantiates them on demand, manages
their lifecycle, and pumps events to the Node-side server over stdio
newline-delimited JSON.

Drivers are discovered from:
- The `gosai_py.drivers` namespace (built-in drivers).
- Any modules listed via `register_drivers()` (used by app-shipped drivers).
"""

from __future__ import annotations

import json
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


class _BridgeContext(DriverContext):
    """Bridge-internal helper that exposes the I/O surface to drivers."""

    def __init__(self, bridge: Bridge, driver_name: str) -> None:
        self._bridge = bridge
        self._driver = driver_name

    def emit(self, event: str, data: Any) -> None:
        self._bridge._emit_event(self._driver, event, data)

    def log(self, level: str, message: str) -> None:
        self._bridge._emit_log(level, self._driver, message)

    def record_performance(self, metric: str, value: float) -> None:
        self._bridge._emit_performance(self._driver, metric, value)

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._subscribe_internal(driver, event, callback)

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._unsubscribe_internal(driver, event, callback)

    def get_event_data(self, driver: str, event: str) -> Any:
        return self._bridge._get_event_data(driver, event)


class Bridge:
    """Owns drivers and shuttles JSON between Node and Python."""

    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        self._running = False
        self._driver_classes: dict[str, type[BaseDriver]] = {}
        self._driver_instances: dict[str, BaseDriver] = {}
        self._internal_subscribers: dict[
            tuple[str, str], list[Callable[[Any], None]]
        ] = {}
        self._external_subscribers: dict[tuple[str, str], int] = {}
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
        line = json.dumps(message, separators=(",", ":"), default=_json_default)
        with self._write_lock:
            sys.stdout.write(line)
            sys.stdout.write("\n")
            sys.stdout.flush()

    def _emit_event(self, driver: str, event: str, data: Any) -> None:
        # External (Node-side) subscribers
        if self._external_subscribers.get((driver, event), 0) > 0 or self._external_subscribers.get(
            (driver, "*"), 0
        ) > 0:
            self._write(
                {
                    "type": "event",
                    "driver": driver,
                    "event": event,
                    "data": data,
                    "ts": time.time(),
                }
            )
        # Internal (other Python drivers) subscribers
        callbacks = self._internal_subscribers.get((driver, event), [])
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

    def _emit_driver_state(self, driver: str, state: str) -> None:
        self._write({"type": "driver-state", "driver": driver, "state": state})

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

    def _start_driver(self, name: str) -> None:
        with self._lock:
            if name in self._driver_instances:
                return
            cls = self._driver_classes.get(name)
            if cls is None:
                raise KeyError(f"unknown driver: {name}")
            # Resolve dependencies first.
            for dep in cls.dependencies:
                if dep not in self._driver_instances:
                    self._start_driver(dep)
            instance = cls(_BridgeContext(self, cls.name))
            self._driver_instances[name] = instance
        self._emit_driver_state(name, "starting")
        try:
            instance._bridge_start()
            self._emit_driver_state(name, "running")
        except Exception:
            self._emit_driver_state(name, "errored")
            raise

    def _stop_driver(self, name: str) -> None:
        with self._lock:
            instance = self._driver_instances.pop(name, None)
        if instance is None:
            return
        self._emit_driver_state(name, "stopping")
        try:
            instance._bridge_stop()
        finally:
            self._emit_driver_state(name, "available")

    def _list_drivers(self) -> JsonDict:
        return {
            "drivers": [
                {
                    "name": cls.name,
                    "description": cls.description,
                    "events": list(cls.events),
                    "actions": list(cls.actions),
                    "dependencies": list(cls.dependencies),
                }
                for cls in self._driver_classes.values()
            ]
        }

    def _get_event_data(self, driver: str, event: str) -> Any:
        instance = self._driver_instances.get(driver)
        if instance is None:
            return None
        return instance.get_event_data(event)

    def _execute(self, driver: str, action: str, data: Any) -> Any:
        instance = self._driver_instances.get(driver)
        if instance is None:
            raise KeyError(f"driver {driver!r} not running")
        if action not in instance.actions:
            raise ValueError(f"driver {driver!r} does not support action {action!r}")
        return instance.execute(action, data)

    # ------------------------------------------------------------------
    # Subscriptions
    # ------------------------------------------------------------------

    def _subscribe_external(self, driver: str, event: str) -> None:
        key = (driver, event)
        with self._lock:
            self._external_subscribers[key] = self._external_subscribers.get(key, 0) + 1

    def _unsubscribe_external(self, driver: str, event: str) -> None:
        key = (driver, event)
        with self._lock:
            count = self._external_subscribers.get(key, 0) - 1
            if count <= 0:
                self._external_subscribers.pop(key, None)
            else:
                self._external_subscribers[key] = count

    def _subscribe_internal(
        self, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        key = (driver, event)
        with self._lock:
            self._internal_subscribers.setdefault(key, []).append(callback)

    def _unsubscribe_internal(
        self, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        key = (driver, event)
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

        if req_type == "ping":
            self._write({"type": "pong", "id": req_id, "ts": time.time()})
            return

        if req_type == "list-drivers":
            self._respond(req_id, True, self._list_drivers())
            return

        if req_type == "start-driver":
            driver = request.get("driver")
            if not isinstance(driver, str):
                self._respond(req_id, False, error="driver name missing")
                return
            try:
                self._start_driver(driver)
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
                self._stop_driver(driver)
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
            self._subscribe_external(driver, event)
            self._respond(req_id, True)
            return

        if req_type == "unsubscribe":
            driver = request.get("driver")
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond(req_id, False, error="driver/event required")
                return
            self._unsubscribe_external(driver, event)
            self._respond(req_id, True)
            return

        if req_type == "get-data":
            driver = request.get("driver")
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond(req_id, False, error="driver/event required")
                return
            self._respond(req_id, True, self._get_event_data(driver, event))
            return

        if req_type == "execute":
            driver = request.get("driver")
            action = request.get("action")
            data = request.get("data")
            if not isinstance(driver, str) or not isinstance(action, str):
                self._respond(req_id, False, error="driver/action required")
                return
            try:
                result = self._execute(driver, action, data)
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
            names = list(self._driver_instances.keys())
        for name in names:
            try:
                self._stop_driver(name)
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
