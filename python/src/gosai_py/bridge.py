"""GOSAI Python bridge.

Owns the registry of driver classes, runs driver instances on request, and
pumps events to the Node-side server over stdio newline-delimited JSON.

The Node side owns the desired state: which instances should run and which
events it wants. The bridge runs what it is asked to run and reports what
actually happens through replies and `driver-state` messages. It never starts
dependencies on its own; Node starts them first.

Multi-instance / bindings
--------------------------
The same driver *class* can run as several independent instances, one per
"instance" namespace. The Node side decides the namespace (an app slug for
exclusive drivers like the camera, or `shared`/`shared:dev<n>` for shareable
drivers like the speaker) and passes it as `instance` on every request. Drivers,
subscriptions, and emitted events are all keyed by `(instance, name)` so two
apps can each bind their own camera without interfering.

Threading
---------
- The main loop reads stdin. It answers `ping`, `shutdown`, `subscribe`,
  `unsubscribe`, `get-data` and `list-instances` itself, since those only touch
  in-memory state.
- `start-driver`, `stop-driver` and `execute` run on a serial queue per
  instance, so a slow model load or action never blocks the main loop or other
  instances. `list-drivers` and device listing run on their own queues.
- One writer thread owns stdout. Replies, logs, state changes and ordinary
  events are written in order and never dropped. For the events a driver
  declares in `stream_events`, only the latest value per
  `(instance, driver, event)` is kept while the writer is busy.
"""

from __future__ import annotations

import os
import pkgutil
import signal
import sys
import threading
import time
import traceback
from collections import deque
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from importlib import import_module
from types import FrameType, ModuleType
from typing import Any

import msgspec

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.version import __version__
from gosai_py.workers import SerialQueue

JsonDict = dict[str, Any]
Sink = Callable[[memoryview], int]

# Bumped whenever the stdio message shapes change. Node refuses to talk to a
# bridge with a different version.
PROTOCOL_VERSION = 2

DEFAULT_INSTANCE = "system"
DEFAULT_STOP_TIMEOUT_S = 5.0
METRICS_INTERVAL_S = 1.0
# Total time `close()` may take. Node waits 10 s for the process to exit after
# `shutdown` before it sends SIGKILL (DEFAULT_EXIT_TIMEOUT_MS in
# packages/server/src/drivers/bridge.ts), so this stays below that.
CLOSE_BUDGET_S = 8.0
# Longest wait for requests already running, at most a quarter of the budget.
CLOSE_REQUESTS_BUDGET_S = 2.0
# Part of the budget kept for flushing output after drivers stop.
CLOSE_FLUSH_RESERVE_S = 0.5


def now_ms() -> float:
    return time.time() * 1000.0


def public_payload(value: Any) -> Any:
    """Drop top-level keys starting with `_` from a dict payload.

    Drivers put in-process objects such as OpenCV frames under `_` keys. Those
    are for Python subscribers and must never cross the bridge.
    """
    if isinstance(value, Mapping):
        return {k: v for k, v in value.items() if not (isinstance(k, str) and k.startswith("_"))}
    return value


def _enc_hook(value: Any) -> Any:
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return tolist()
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, Iterable) and not isinstance(value, str | bytes):
        return list(value)
    raise NotImplementedError(f"cannot encode {type(value).__name__}")


def write_all(sink: Sink, data: bytes) -> None:
    """Call `sink` until every byte of `data` is written."""
    view = memoryview(data)
    while view:
        written = sink(view)
        view = view[written:]


def fd_sink(fd: int) -> Sink:
    return lambda chunk: os.write(fd, chunk)


def describe_error(exc: BaseException) -> str:
    return str(exc) or type(exc).__name__


class _Metrics:
    """Aggregates driver metrics between flushes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._samples: dict[tuple[str, str, str], list[float]] = {}

    def add(self, instance: str, driver: str, metric: str, value: float) -> None:
        key = (instance, driver, metric)
        with self._lock:
            stats = self._samples.get(key)
            if stats is None:
                self._samples[key] = [1.0, value, value]
            else:
                stats[0] += 1.0
                stats[1] += value
                stats[2] = max(stats[2], value)

    def drain(self) -> list[JsonDict]:
        with self._lock:
            samples, self._samples = self._samples, {}
        ts = now_ms()
        return [
            {
                "type": "performance",
                "instance": instance,
                "source": driver,
                "metric": metric,
                "value": total / count,
                "max": peak,
                "count": int(count),
                "ts": ts,
            }
            for (instance, driver, metric), (count, total, peak) in samples.items()
        ]


class _Writer:
    """The only writer of stdout.

    Ordered messages (replies, logs, state) are never dropped. Stream events
    are coalesced so only the latest value per key waits for the pipe.
    """

    def __init__(self, sink: Sink, metrics: _Metrics) -> None:
        self._sink = sink
        self._metrics = metrics
        self._encoder = msgspec.json.Encoder(enc_hook=_enc_hook)
        self._cond = threading.Condition()
        self._ordered: deque[JsonDict] = deque()
        self._latest: dict[tuple[str, str, str], JsonDict] = {}
        self._closed = False
        self._broken = False
        self._thread: threading.Thread | None = None
        self._failed_event_keys: set[tuple[str, str, str]] = set()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="bridge:writer", daemon=True)
        self._thread.start()

    def post(self, message: JsonDict) -> None:
        with self._cond:
            self._ordered.append(message)
            self._cond.notify()

    def post_latest(self, key: tuple[str, str, str], message: JsonDict) -> None:
        with self._cond:
            self._latest.pop(key, None)
            self._latest[key] = message
            self._cond.notify()

    def close(self, timeout: float | None = None) -> None:
        """Write everything still queued, then stop the thread."""
        with self._cond:
            self._closed = True
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None
        else:
            self._drain_once()

    def _run(self) -> None:
        next_flush = time.monotonic() + METRICS_INTERVAL_S
        while True:
            with self._cond:
                while not self._ordered and not self._latest and not self._closed:
                    remaining = next_flush - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cond.wait(remaining)
                closed = self._closed
            if closed or time.monotonic() >= next_flush:
                self.post_many(self._metrics.drain())
                next_flush = time.monotonic() + METRICS_INTERVAL_S
            wrote = self._drain_once()
            if closed and not wrote:
                return

    def post_many(self, messages: list[JsonDict]) -> None:
        if not messages:
            return
        with self._cond:
            self._ordered.extend(messages)

    def _drain_once(self) -> bool:
        with self._cond:
            ordered = list(self._ordered)
            self._ordered.clear()
            latest = list(self._latest.items())
            self._latest.clear()
        if not ordered and not latest:
            return False
        chunks: list[bytes] = [self._encode_ordered(message) for message in ordered]
        for key, message in latest:
            encoded = self._encode_event(key, message)
            if encoded is not None:
                chunks.append(encoded)
        self._write(b"".join(chunks))
        return True

    def _encode_ordered(self, message: JsonDict) -> bytes:
        try:
            return self._encoder.encode(message) + b"\n"
        except Exception as exc:
            if message.get("type") == "result":
                fallback: JsonDict = {
                    "type": "result",
                    "id": message.get("id", ""),
                    "ok": False,
                    "error": f"reply is not serializable: {describe_error(exc)}",
                }
            else:
                fallback = {
                    "type": "log",
                    "level": "error",
                    "source": "bridge",
                    "message": f"dropped unserializable {message.get('type')} message: {exc!r}",
                    "ts": now_ms(),
                }
            return self._encoder.encode(fallback) + b"\n"

    def _encode_event(self, key: tuple[str, str, str], message: JsonDict) -> bytes | None:
        try:
            encoded = self._encoder.encode(message) + b"\n"
        except Exception as exc:
            if key in self._failed_event_keys:
                return None
            self._failed_event_keys.add(key)
            instance, driver, event = key
            return self._encode_ordered(
                {
                    "type": "log",
                    "level": "error",
                    "source": driver,
                    "instance": instance,
                    "message": f"event {event!r} is not serializable: {exc!r}",
                    "ts": now_ms(),
                }
            )
        self._failed_event_keys.discard(key)
        return encoded

    def _write(self, data: bytes) -> None:
        if self._broken:
            return
        try:
            write_all(self._sink, data)
        except OSError as exc:
            # Node is gone. Keep draining so producers never block; stdin EOF
            # ends the main loop.
            self._broken = True
            print(f"gosai-bridge: stdout closed: {exc!r}", file=sys.stderr)


class _BridgeContext(DriverContext):
    """The I/O surface a driver instance sees, bound to one `(instance, driver)`."""

    def __init__(self, bridge: Bridge, driver_name: str, instance: str) -> None:
        self._bridge = bridge
        self._driver = driver_name
        self._instance = instance

    def emit(self, event: str, data: Any) -> None:
        self._bridge._emit_event(self._instance, self._driver, event, data)

    def log(self, level: str, message: str) -> None:
        self._bridge._emit_log(level, self._driver, message, self._instance)

    def record_performance(self, metric: str, value: float) -> None:
        self._bridge._metrics.add(self._instance, self._driver, metric, value)

    def set_state(self, state: str, runtime_info: dict[str, Any] | None = None) -> None:
        self._bridge._driver_published_state(self._instance, self._driver, state, runtime_info)

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._subscribe_internal(self._instance, driver, event, callback)

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        self._bridge._unsubscribe_internal(self._instance, driver, event, callback)

    def get_event_data(self, driver: str, event: str) -> Any:
        return self._bridge._get_event_data(self._instance, driver, event)

    def has_subscribers(self, event: str) -> bool:
        return self._bridge._has_subscribers(self._instance, self._driver, event)


@dataclass
class _Instance:
    driver: BaseDriver
    state: str


class _TerminateError(BaseException):
    """Raised from the SIGTERM handler to leave the stdin loop."""


class Bridge:
    """Runs drivers and shuttles JSON between Node and Python."""

    def __init__(
        self,
        sink: Sink | None = None,
        *,
        drivers: Iterable[type[BaseDriver]] | None = None,
        stop_timeout_s: float = DEFAULT_STOP_TIMEOUT_S,
    ) -> None:
        self._metrics = _Metrics()
        self._writer = _Writer(sink or fd_sink(1), self._metrics)
        self._stop_timeout_s = stop_timeout_s
        self._lock = threading.RLock()
        self._driver_classes: dict[str, type[BaseDriver]] = {}
        self._instances: dict[tuple[str, str], _Instance] = {}
        self._runtime_info: dict[tuple[str, str], JsonDict] = {}
        self._internal_subscribers: dict[tuple[str, str, str], list[Callable[[Any], None]]] = {}
        self._external_subscriptions: set[tuple[str, str, str]] = set()
        self._queues: dict[str, SerialQueue] = {}
        self._discovered = threading.Event()
        self._discovery_thread: threading.Thread | None = None
        self._shutdown_requested = False
        self._closed = False
        if drivers is not None:
            for cls in drivers:
                self._driver_classes[cls.name] = cls
            self._discovered.set()

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
                with self._lock:
                    self._driver_classes[attr.name] = attr

    def discover_builtin(self) -> None:
        """Walk `gosai_py.drivers` and register every driver module found."""
        try:
            pkg = import_module("gosai_py.drivers")
        except ImportError as exc:
            self._emit_log("error", "bridge", f"failed to import gosai_py.drivers: {exc!r}")
            return
        for module_info in pkgutil.iter_modules(pkg.__path__):
            try:
                module = import_module(f"gosai_py.drivers.{module_info.name}")
            except Exception as exc:
                self._emit_log("warn", "bridge", f"failed to load drivers.{module_info.name}: {exc!r}")
                continue
            self.register_module(module)

    def start_discovery(self) -> None:
        """Import the built-in drivers on a background thread."""

        def discover() -> None:
            try:
                self.discover_builtin()
            finally:
                self._discovered.set()

        self._discovery_thread = threading.Thread(target=discover, name="bridge:discovery", daemon=True)
        self._discovery_thread.start()

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the writer thread. Messages posted earlier are written then."""
        self._writer.start()

    def _post(self, message: JsonDict) -> None:
        self._writer.post(message)

    def _emit_event(self, instance: str, driver: str, event: str, data: Any) -> None:
        if self._has_external(instance, driver, event):
            message: JsonDict = {
                "type": "event",
                "instance": instance,
                "driver": driver,
                "event": event,
                "data": public_payload(data),
                "ts": now_ms(),
            }
            cls = self._driver_classes.get(driver)
            if cls is not None and event in cls.stream_events:
                self._writer.post_latest((instance, driver, event), message)
            else:
                self._post(message)
        with self._lock:
            callbacks = list(self._internal_subscribers.get((instance, driver, event), ()))
        for callback in callbacks:
            try:
                callback(data)
            except Exception as exc:
                self._emit_log("warn", driver, f"subscriber of {event!r} failed: {exc!r}", instance)

    def _emit_log(self, level: str, source: str, message: str, instance: str | None = None) -> None:
        payload: JsonDict = {"type": "log", "level": level, "source": source, "message": message, "ts": now_ms()}
        if instance is not None:
            payload["instance"] = instance
        self._post(payload)

    def _emit_driver_state(self, instance: str, driver: str, state: str) -> None:
        payload: JsonDict = {"type": "driver-state", "instance": instance, "driver": driver, "state": state}
        with self._lock:
            runtime = self._runtime_info.get((instance, driver))
        if runtime is not None:
            payload["runtime"] = runtime
        self._post(payload)

    def _driver_published_state(
        self, instance: str, driver: str, state: str, runtime_info: JsonDict | None
    ) -> None:
        key = (instance, driver)
        with self._lock:
            record = self._instances.get(key)
            if runtime_info is not None:
                self._runtime_info[key] = dict(runtime_info)
            # Only a running instance's own reports change its state; the
            # bridge owns the starting and stopping transitions.
            if record is None or record.state != "running":
                return
            record.state = state
        self._emit_driver_state(instance, driver, state)

    def _respond(self, req_id: str, data: Any = None) -> None:
        self._post({"type": "result", "id": req_id, "ok": True, "data": public_payload(data)})

    def _respond_error(self, req_id: str, error: str) -> None:
        self._post({"type": "result", "id": req_id, "ok": False, "error": error})

    # ------------------------------------------------------------------
    # Driver lifecycle
    # ------------------------------------------------------------------

    def _start_driver(self, instance: str, name: str, config: JsonDict | None) -> JsonDict:
        self._discovered.wait()
        key = (instance, name)
        obj = self._create_instance(instance, name)
        if obj is None:
            # A repeated start still reports the state, so Node never waits on a
            # transition that already happened.
            self._emit_driver_state(instance, name, "running")
            return {"driver": name, "state": "running"}

        self._emit_driver_state(instance, name, "starting")
        try:
            if config:
                obj.apply_config(config)
            obj._bridge_start()
        except Exception:
            with self._lock:
                self._instances.pop(key, None)
                self._runtime_info.pop(key, None)
                self._drop_external(instance, name)
            raise
        with self._lock:
            self._instances[key].state = "running"
            runtime = obj.runtime_info()
            if runtime is not None:
                self._runtime_info[key] = runtime
        self._emit_driver_state(instance, name, "running")
        return {"driver": name, "state": "running"}

    def _create_instance(self, instance: str, name: str) -> BaseDriver | None:
        """Register a new `starting` instance, or return None if it already runs."""
        with self._lock:
            if self._closed:
                raise RuntimeError("bridge is shutting down")
            existing = self._instances.get((instance, name))
            if existing is not None:
                if existing.state == "running":
                    return None
                raise RuntimeError(f"driver {name!r} in {instance!r} is {existing.state}")
            cls = self._driver_classes.get(name)
            if cls is None:
                raise LookupError(f"unknown driver: {name}")
            missing = [
                dep
                for dep in cls.dependencies
                if getattr(self._instances.get((instance, dep)), "state", None) != "running"
            ]
            if missing:
                raise RuntimeError(
                    f"driver {name!r} in {instance!r} needs {', '.join(missing)} running first"
                )
            obj = cls(_BridgeContext(self, name, instance))
            self._instances[(instance, name)] = _Instance(obj, "starting")
            return obj

    def _stop_driver(self, instance: str, name: str, timeout: float | None = None) -> JsonDict:
        timeout = self._stop_timeout_s if timeout is None else min(timeout, self._stop_timeout_s)
        key = (instance, name)
        with self._lock:
            record = self._instances.get(key)
            if record is None:
                return {"driver": name, "state": "available"}
            record.state = "stopping"
        self._emit_driver_state(instance, name, "stopping")
        if not record.driver._bridge_stop(timeout):
            with self._lock:
                record.state = "errored"
            self._emit_driver_state(instance, name, "errored")
            raise TimeoutError(f"driver {name!r} in {instance!r} did not stop within {timeout:g}s")
        with self._lock:
            self._instances.pop(key, None)
            self._runtime_info.pop(key, None)
            self._drop_external(instance, name)
        self._emit_driver_state(instance, name, "available")
        return {"driver": name, "state": "available"}

    def _stop_all(self, deadline: float) -> None:
        """Stop every instance before `deadline`, dependents before their dependencies.

        Instances with no running dependents stop in parallel. One that does
        not stop in time is abandoned so its dependencies can still stop.
        """
        while True:
            with self._lock:
                keys = list(self._instances)
                needed = {
                    (instance, dep)
                    for instance, name in keys
                    for dep in type(self._instances[(instance, name)].driver).dependencies
                }
            if not keys:
                return
            leaves = [key for key in keys if key not in needed] or keys

            def stop(instance: str, name: str) -> None:
                try:
                    self._stop_driver(instance, name, max(deadline - time.monotonic(), 0.0))
                except Exception as exc:
                    self._emit_log("warn", "bridge", f"failed to stop {name} in {instance}: {exc!r}")
                    with self._lock:
                        self._instances.pop((instance, name), None)

            threads = [
                threading.Thread(target=stop, args=key, name=f"bridge:stop:{key[0]}:{key[1]}", daemon=True)
                for key in leaves
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(max(deadline - time.monotonic(), 0.0) + 0.1)
            if any(thread.is_alive() for thread in threads):
                return

    def _list_drivers(self) -> JsonDict:
        self._discovered.wait()
        with self._lock:
            classes = list(self._driver_classes.values())
        return {
            "drivers": [
                {
                    "name": cls.name,
                    "description": cls.description,
                    "events": list(cls.events),
                    "actions": list(cls.actions),
                    "dependencies": list(cls.dependencies),
                    "shared": bool(cls.shared),
                }
                for cls in classes
            ]
        }

    def _list_instances(self) -> JsonDict:
        with self._lock:
            return {
                "instances": [
                    {
                        "instance": instance,
                        "driver": name,
                        "state": record.state,
                        "subscriptions": sorted(
                            event
                            for sub_instance, sub_driver, event in self._external_subscriptions
                            if (sub_instance, sub_driver) == (instance, name)
                        ),
                    }
                    for (instance, name), record in self._instances.items()
                ]
            }

    def _list_cameras(self) -> JsonDict:
        from gosai_py.drivers.camera import CameraDriver

        return {"devices": CameraDriver.probe_devices()}

    def _list_audio_devices(self) -> JsonDict:
        import sounddevice as sd  # type: ignore[import-not-found]

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
        with self._lock:
            record = self._instances.get((instance, driver))
        if record is None:
            return None
        return record.driver.get_event_data(event)

    def _execute(self, instance: str, driver: str, action: str, data: Any) -> Any:
        if driver == "camera" and action == "list_formats":
            from gosai_py.drivers.camera import CameraDriver

            device = 0
            if isinstance(data, dict) and "device" in data:
                device = int(data["device"])
            result = CameraDriver.probe_formats(device)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or f"cannot list formats for device {device}")
            return result

        with self._lock:
            record = self._instances.get((instance, driver))
        if record is None or record.state != "running":
            state = record.state if record is not None else "not running"
            raise RuntimeError(f"driver {driver!r} in {instance!r} is {state}")
        if action not in record.driver.actions:
            raise ValueError(f"driver {driver!r} does not support action {action!r}")
        return record.driver.execute(action, data)

    # ------------------------------------------------------------------
    # Subscriptions
    # ------------------------------------------------------------------

    def _has_external(self, instance: str, driver: str, event: str) -> bool:
        subs = self._external_subscriptions
        return (instance, driver, event) in subs or (instance, driver, "*") in subs

    def _drop_external(self, instance: str, driver: str) -> None:
        self._external_subscriptions = {
            sub for sub in self._external_subscriptions if (sub[0], sub[1]) != (instance, driver)
        }

    def _subscribe_internal(
        self, instance: str, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        with self._lock:
            self._internal_subscribers.setdefault((instance, driver, event), []).append(callback)

    def _unsubscribe_internal(
        self, instance: str, driver: str, event: str, callback: Callable[[Any], None]
    ) -> None:
        key = (instance, driver, event)
        with self._lock:
            callbacks = self._internal_subscribers.get(key)
            if not callbacks or callback not in callbacks:
                return
            callbacks.remove(callback)
            if not callbacks:
                del self._internal_subscribers[key]

    def _has_subscribers(self, instance: str, driver: str, event: str) -> bool:
        if self._has_external(instance, driver, event):
            return True
        with self._lock:
            return bool(self._internal_subscribers.get((instance, driver, event)))

    # ------------------------------------------------------------------
    # Request dispatch
    # ------------------------------------------------------------------

    def handle(self, request: JsonDict) -> None:
        req_type = request.get("type")
        req_id = str(request.get("id", ""))
        instance = request.get("instance")
        if not isinstance(instance, str) or not instance:
            instance = DEFAULT_INSTANCE
        driver = request.get("driver")

        if req_type == "ping":
            self._post({"type": "pong", "id": req_id, "ts": now_ms()})
        elif req_type == "shutdown":
            self._shutdown_requested = True
            self._respond(req_id)
        elif req_type == "list-instances":
            self._respond(req_id, self._list_instances())
        elif req_type == "list-drivers":
            self._run_queued("catalog", req_id, self._list_drivers)
        elif req_type == "list-cameras":
            self._run_queued("devices", req_id, self._list_cameras)
        elif req_type == "list-audio-devices":
            self._run_queued("devices", req_id, self._list_audio_devices)
        elif req_type in ("subscribe", "unsubscribe", "get-data"):
            event = request.get("event")
            if not isinstance(driver, str) or not isinstance(event, str):
                self._respond_error(req_id, "driver and event are required")
            elif req_type == "subscribe":
                with self._lock:
                    self._external_subscriptions.add((instance, driver, event))
                self._respond(req_id)
            elif req_type == "unsubscribe":
                with self._lock:
                    self._external_subscriptions.discard((instance, driver, event))
                self._respond(req_id)
            else:
                self._respond(req_id, self._get_event_data(instance, driver, event))
        elif req_type in ("start-driver", "stop-driver", "execute"):
            if not isinstance(driver, str):
                self._respond_error(req_id, "driver is required")
                return
            queue = f"instance:{instance}:{driver}"
            if req_type == "start-driver":
                config = request.get("config")
                cfg = config if isinstance(config, dict) else None
                self._run_queued(queue, req_id, lambda: self._start_driver(instance, driver, cfg))
            elif req_type == "stop-driver":
                self._run_queued(queue, req_id, lambda: self._stop_driver(instance, driver))
            else:
                action = request.get("action")
                if not isinstance(action, str):
                    self._respond_error(req_id, "action is required")
                    return
                data = request.get("data")
                self._run_queued(queue, req_id, lambda: self._execute(instance, driver, action, data))
        else:
            self._respond_error(req_id, f"unknown request type: {req_type!r}")

    def _run_queued(self, queue_name: str, req_id: str, work: Callable[[], Any]) -> None:
        def task() -> None:
            try:
                result = work()
            except Exception as exc:
                self._respond_error(req_id, describe_error(exc))
                return
            self._respond(req_id, result)

        with self._lock:
            if self._closed:
                self._respond_error(req_id, "bridge is shutting down")
                return
            queue = self._queues.get(queue_name)
            if queue is None:
                queue = SerialQueue(f"bridge:{queue_name}")
                self._queues[queue_name] = queue
        try:
            queue.submit(task, lambda: self._respond_error(req_id, "bridge is shutting down"))
        except RuntimeError as exc:
            self._respond_error(req_id, describe_error(exc))

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    def close(self, timeout: float = CLOSE_BUDGET_S) -> None:
        """Stop every driver and flush output within `timeout` seconds.

        Requests already running get a short grace period; queued requests
        that have not started get an error reply and never run.
        """
        start = time.monotonic()
        deadline = start + timeout
        with self._lock:
            if self._closed:
                return
            self._closed = True
            queues = list(self._queues.values())
        for queue in queues:
            queue.close(0.0)
        requests_deadline = start + min(CLOSE_REQUESTS_BUDGET_S, timeout / 4)
        for queue in queues:
            if not queue.join(max(requests_deadline - time.monotonic(), 0.0)):
                self._emit_log("warn", "bridge", "a request was still running at shutdown")
        self._stop_all(deadline - CLOSE_FLUSH_RESERVE_S)
        self._writer.close(max(deadline - time.monotonic(), CLOSE_FLUSH_RESERVE_S))

    def run(self, stdin: Iterable[bytes] | None = None) -> int:
        self.start()
        self._post({"type": "ready", "version": __version__, "protocol": PROTOCOL_VERSION})
        if not self._discovered.is_set():
            self.start_discovery()
        lines = stdin if stdin is not None else sys.stdin.buffer
        previous_handler = _install_sigterm_handler()
        try:
            for raw_line in lines:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    request = msgspec.json.decode(line)
                except msgspec.DecodeError as exc:
                    self._emit_log("error", "bridge", f"invalid JSON request: {exc}")
                    continue
                if not isinstance(request, dict):
                    self._emit_log("error", "bridge", "request must be a JSON object")
                    continue
                try:
                    self.handle(request)
                except Exception as exc:
                    self._emit_log("error", "bridge", f"unhandled error: {exc!r}\n{traceback.format_exc()}")
                if self._shutdown_requested:
                    break
        except (_TerminateError, KeyboardInterrupt):
            pass
        finally:
            # A second SIGTERM must not interrupt cleanup; Node escalates to SIGKILL.
            if previous_handler is not None:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            self.close()
            if previous_handler is not None:
                signal.signal(signal.SIGTERM, previous_handler)
        return 0


def _install_sigterm_handler() -> Callable[[int, FrameType | None], Any] | int | None:
    if threading.current_thread() is not threading.main_thread():
        return None

    def terminate(_signum: int, _frame: FrameType | None) -> None:
        raise _TerminateError

    return signal.signal(signal.SIGTERM, terminate)


def main() -> int:
    # Driver code sometimes writes to fd 1 (native libraries, stray prints).
    # Keep a private copy of the real stdout for the protocol and point fd 1 at
    # stderr so that noise cannot corrupt it.
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    return Bridge(fd_sink(protocol_fd)).run()


if __name__ == "__main__":
    sys.exit(main())
