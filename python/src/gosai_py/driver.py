"""Base classes for GOSAI drivers.

Drivers run inside the bridge process. Each driver is a long-lived thread that:
- Declares the events it publishes and the actions it accepts.
- Optionally subscribes to events from other drivers.
- Implements `pre_run`, optionally `loop`, optionally `on_event`, and
  `cleanup` lifecycle hooks.

The bridge wires drivers to a publish/subscribe in-process bus and handles
serialization for the Node-side server. Drivers should never touch sockets or
stdio directly; they call `self.emit(event, data)` and `self.log(...)`.
"""

from __future__ import annotations

import threading
import time
import traceback
from collections.abc import Callable
from typing import Any, ClassVar


class DriverContext:
    """Interface the bridge gives to each driver."""

    def emit(self, event: str, data: Any) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def log(self, level: str, message: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def record_performance(self, metric: str, value: float) -> None:  # pragma: no cover
        raise NotImplementedError

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:  # pragma: no cover
        raise NotImplementedError

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:  # pragma: no cover
        raise NotImplementedError

    def get_event_data(self, driver: str, event: str) -> Any:  # pragma: no cover
        raise NotImplementedError


class BaseDriver:
    """Base class for drivers.

    Subclasses declare class-level metadata:

    - `name`: stable identifier matching the registration key.
    - `events`: tuple of event names the driver publishes.
    - `actions`: tuple of action names the driver accepts via `execute`.
    - `dependencies`: tuple of driver names this driver depends on.
    - `loop_interval_s`: how often `loop()` is called (0 == as fast as possible,
      `None` == no loop, callback-only).
    """

    name: ClassVar[str] = ""
    description: ClassVar[str] = ""
    events: ClassVar[tuple[str, ...]] = ()
    actions: ClassVar[tuple[str, ...]] = ()
    dependencies: ClassVar[tuple[str, ...]] = ()
    loop_interval_s: ClassVar[float | None] = 0.01
    # Sharing policy. False (default) => exclusive: each app binding gets its own
    # device-bound instance. True => the driver may be shared across apps (e.g.
    # audio output, device-less utilities). A driver that depends on an exclusive
    # driver is treated as exclusive regardless of this flag.
    shared: ClassVar[bool] = False

    def __init__(self, context: DriverContext) -> None:
        self._context = context
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_event_data: dict[str, Any] = {}
        self._event_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle hooks (override in subclasses).
    # ------------------------------------------------------------------

    def pre_run(self) -> None:
        """Called once before the loop starts. Acquire resources here."""

    def loop(self) -> None:
        """One iteration of the driver. Called at `loop_interval_s` cadence."""

    def cleanup(self) -> None:
        """Called when the driver is stopping. Release resources here."""

    def execute(self, action: str, data: Any) -> Any:
        """Handle an action invocation from an app or another driver."""
        self.log("warn", f"unhandled action {action!r}")
        return None

    # ------------------------------------------------------------------
    # API for subclasses to use inside their hooks.
    # ------------------------------------------------------------------

    def emit(self, event: str, data: Any) -> None:
        if event not in self.events:
            self.log("warn", f"emit on undeclared event {event!r}")
        with self._event_lock:
            self._last_event_data[event] = data
        self._context.emit(event, data)

    def log(self, level: str, message: str) -> None:
        self._context.log(level, message)

    def record(self, metric: str, value: float) -> None:
        self._context.record_performance(metric, value)

    def get_event_data(self, event: str) -> Any:
        with self._event_lock:
            return self._last_event_data.get(event)

    def stop_requested(self) -> bool:
        return self._stop.is_set()

    # ------------------------------------------------------------------
    # Bridge-only API. Apps must not call these directly.
    # ------------------------------------------------------------------

    def _bridge_start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._paused.clear()
        self._thread = threading.Thread(target=self._run, name=f"driver:{self.name}", daemon=True)
        self._thread.start()

    def _bridge_stop(self, timeout: float = 5.0) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout)
        self._thread = None

    def _run(self) -> None:
        try:
            self.pre_run()
        except Exception as exc:
            self.log("error", f"pre_run failed: {exc!r}\n{traceback.format_exc()}")
            return

        interval = self.loop_interval_s
        if interval is None:
            self._stop.wait()
            self._cleanup_quietly()
            return

        while not self._stop.is_set():
            start = time.perf_counter()
            try:
                self.loop()
            except Exception as exc:
                self.log("error", f"loop failed: {exc!r}\n{traceback.format_exc()}")
                # Avoid tight-spinning on a broken loop.
                time.sleep(0.5)
                continue
            elapsed = time.perf_counter() - start
            self.record("loop_ms", elapsed * 1000.0)
            if interval > 0:
                remaining = interval - elapsed
                if remaining > 0:
                    self._stop.wait(remaining)

        self._cleanup_quietly()

    def _cleanup_quietly(self) -> None:
        try:
            self.cleanup()
        except Exception as exc:
            self.log("error", f"cleanup failed: {exc!r}")
