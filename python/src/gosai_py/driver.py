"""Base class for GOSAI drivers.

Drivers run inside the bridge process. Each driver instance has its own thread
that:
- Declares the events it publishes and the actions it accepts.
- Optionally subscribes to events from other drivers (`subscribed`, or
  `subscribe()` at runtime). Each subscription is delivered to `on_data` on its
  own latest-value worker thread.
- Implements `pre_run`, optionally `loop`, optionally `on_data`, and `cleanup`
  lifecycle hooks.

The bridge wires drivers to an in-process publish/subscribe bus and handles
serialization for the Node-side server. Drivers should never touch sockets or
stdio directly; they call `self.emit(event, data)` and `self.log(...)`.

Actions report failures by raising. The bridge turns the exception into an
error reply.
"""

from __future__ import annotations

import threading
import time
import traceback
from collections.abc import Callable, Mapping
from typing import Any, ClassVar

from gosai_py.workers import BoundedQueueWorker, LatestValueWorker


class DriverContext:
    """Interface the bridge gives to each driver."""

    def emit(self, event: str, data: Any) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def log(self, level: str, message: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def record_performance(self, metric: str, value: float) -> None:  # pragma: no cover
        raise NotImplementedError

    def set_state(
        self,
        state: str,
        runtime_info: dict[str, Any] | None = None,
    ) -> None:  # pragma: no cover
        raise NotImplementedError

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:  # pragma: no cover
        """Register a callback for another driver's event.

        The bridge calls `callback` on the emitting thread, so it must not block.
        Drivers should use `BaseDriver.subscribe`, which adds a worker thread.
        """
        raise NotImplementedError

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:  # pragma: no cover
        raise NotImplementedError

    def get_event_data(self, driver: str, event: str) -> Any:  # pragma: no cover
        raise NotImplementedError

    def has_subscribers(self, event: str) -> bool:  # pragma: no cover
        raise NotImplementedError


class BaseDriver:
    """Base class for drivers.

    Subclasses declare class-level metadata:

    - `name`: stable identifier matching the registration key.
    - `events`: tuple of event names the driver publishes.
    - `actions`: tuple of action names the driver accepts via `execute`.
    - `dependencies`: tuple of driver names this driver depends on. The server
      starts them first, in the same instance namespace.
    - `stream_events`: high-rate events (frames, per-frame results) where only
      the newest value matters. When Node reads slower than the driver emits,
      the bridge sends only the latest value of these. Every other event is
      delivered in order.
    - `subscribed`: `(driver, event)` pairs delivered to `on_data` once
      `pre_run` succeeds.
    - `subscription_queue_size`: how `subscribed` events are delivered. None
      (default) keeps only the latest value, right for camera frames. A number
      queues that many values in order, for consumers that need every input,
      such as audio blocks or frame sequences.
    - `loop_interval_s`: how often `loop()` is called (0 == as fast as possible,
      `None` == no loop, callback-only).
    """

    name: ClassVar[str] = ""
    description: ClassVar[str] = ""
    events: ClassVar[tuple[str, ...]] = ()
    actions: ClassVar[tuple[str, ...]] = ()
    dependencies: ClassVar[tuple[str, ...]] = ()
    stream_events: ClassVar[tuple[str, ...]] = ()
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = ()
    subscription_queue_size: ClassVar[int | None] = None
    loop_interval_s: ClassVar[float | None] = 0.01
    # Sharing policy. False (default) => exclusive: each app binding gets its own
    # device-bound instance. True => the driver may be shared across apps (e.g.
    # audio output, device-less utilities). A driver that depends on an exclusive
    # driver is treated as exclusive regardless of this flag.
    shared: ClassVar[bool] = False

    def __init__(self, context: DriverContext) -> None:
        self._context = context
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_event_data: dict[str, Any] = {}
        self._event_lock = threading.Lock()
        self._runtime_info: dict[str, Any] | None = None
        self._subscriptions: dict[tuple[str, str], LatestValueWorker] = {}
        self._retired_workers: list[LatestValueWorker] = []
        self._subscriptions_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Lifecycle hooks (override in subclasses).
    # ------------------------------------------------------------------

    def pre_run(self) -> None:
        """Called once before the loop starts. Acquire resources here.

        Raising fails the start: the bridge reports the error and discards the
        instance.
        """

    def loop(self) -> bool | None:
        """One iteration of the driver. Called at `loop_interval_s` cadence.

        Return False when the iteration had nothing to do, so it is left out of
        the `loop_ms` metric.
        """
        return None

    def on_data(self, driver: str, event: str, data: Any) -> None:
        """Handle an event from a subscribed driver. Runs on a worker thread."""

    def cleanup(self) -> None:
        """Called when the driver is stopping. Release resources here."""

    def execute(self, action: str, data: Any) -> Any:
        """Handle an action invocation. Raise to report a failure."""
        raise NotImplementedError(f"{self.name}: action {action!r} is not implemented")

    def apply_config(self, cfg: dict[str, Any]) -> None:
        """Apply startup configuration supplied by the server."""

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

    def set_runtime_info(self, info: Mapping[str, Any] | None) -> None:
        self._runtime_info = dict(info) if info is not None else None

    def runtime_info(self) -> dict[str, Any] | None:
        return dict(self._runtime_info) if self._runtime_info is not None else None

    def publish_state(self, state: str) -> None:
        self._context.set_state(state, self.runtime_info())

    def get_event_data(self, event: str) -> Any:
        with self._event_lock:
            return self._last_event_data.get(event)

    def stop_requested(self) -> bool:
        return self._stop.is_set()

    def subscribe(self, driver: str, event: str, *, queue_size: int | None = None) -> None:
        """Deliver `driver.event` to `on_data` on a dedicated worker thread.

        With `queue_size=None` the worker keeps only the latest value. With a
        number it delivers every value in order and, when that many are
        pending, drops the oldest and reports it through a warning and the
        `subscription_dropped` metric.
        """
        key = (driver, event)
        with self._subscriptions_lock:
            if key in self._subscriptions:
                return

            def deliver(data: Any) -> None:
                if not self._stop.is_set():
                    self.on_data(driver, event, data)

            def on_error(exc: BaseException) -> None:
                self.log(
                    "error",
                    f"on_data({driver}.{event}) failed: {exc!r}\n"
                    + "".join(traceback.format_exception(exc)),
                )

            name = f"driver:{self.name}:{driver}.{event}"
            worker: LatestValueWorker
            if queue_size is None:
                worker = LatestValueWorker(deliver, name=name, on_error=on_error)
            else:
                worker = BoundedQueueWorker(
                    deliver,
                    name=name,
                    maxsize=queue_size,
                    on_error=on_error,
                    on_drop=self._drop_reporter(driver, event, queue_size),
                )
            self._subscriptions[key] = worker
        self._context.subscribe(driver, event, worker.offer)

    def _drop_reporter(self, driver: str, event: str, queue_size: int) -> Callable[[], None]:
        last_warning = 0.0
        dropped_since_warning = 0
        lock = threading.Lock()

        def report() -> None:
            nonlocal last_warning, dropped_since_warning
            self.record("subscription_dropped", 1.0)
            with lock:
                dropped_since_warning += 1
                now = time.monotonic()
                if now - last_warning < 5.0:
                    return
                count, dropped_since_warning, last_warning = dropped_since_warning, 0, now
            self.log(
                "warn",
                f"{driver}.{event} queue is full ({queue_size}); dropped {count} oldest value(s)",
            )

        return report

    def unsubscribe(self, driver: str, event: str) -> None:
        """Stop delivering `driver.event`. The worker exits after its current call."""
        with self._subscriptions_lock:
            worker = self._subscriptions.pop((driver, event), None)
        if worker is None:
            return
        self._context.unsubscribe(driver, event, worker.offer)
        worker.close()
        with self._subscriptions_lock:
            self._retired_workers.append(worker)

    # ------------------------------------------------------------------
    # Bridge-only API. Apps must not call these directly.
    # ------------------------------------------------------------------

    def _bridge_start(self) -> None:
        """Start the driver thread and wait for `pre_run` to finish.

        Raises whatever `pre_run` raised. The thread has exited by then.
        """
        if self._thread is not None:
            raise RuntimeError(f"{self.name} is already started")
        self._stop.clear()
        started = threading.Event()
        failure: list[Exception] = []
        thread = threading.Thread(
            target=self._run, args=(started, failure), name=f"driver:{self.name}", daemon=True
        )
        self._thread = thread
        thread.start()
        started.wait()
        if failure:
            thread.join()
            self._thread = None
            raise failure[0]

    def _bridge_stop(self, timeout: float = 5.0) -> bool:
        """Stop subscriptions, then the driver thread, waiting up to `timeout` seconds.

        Subscription workers finish before `cleanup` runs, so `on_data` never
        races the release of resources. Returns True once every thread has
        exited; False means something is still running and a later call can
        wait again.
        """
        deadline = time.monotonic() + timeout
        with self._subscriptions_lock:
            keys = list(self._subscriptions)
        for driver, event in keys:
            self.unsubscribe(driver, event)
        with self._subscriptions_lock:
            workers = list(self._retired_workers)
        for worker in workers:
            if worker.join(max(deadline - time.monotonic(), 0.0)):
                with self._subscriptions_lock:
                    self._retired_workers.remove(worker)
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(max(deadline - time.monotonic(), 0.0))
            if thread.is_alive():
                return False
            self._thread = None
        with self._subscriptions_lock:
            return not self._retired_workers

    def _run(self, started: threading.Event, failure: list[Exception]) -> None:
        try:
            self.pre_run()
            for driver, event in self.subscribed:
                self.subscribe(driver, event, queue_size=self.subscription_queue_size)
        except Exception as exc:
            self.log("error", f"pre_run failed: {exc!r}\n{traceback.format_exc()}")
            failure.append(exc)
            self._stop.set()
            self._stop_subscriptions_quietly()
            self._cleanup_quietly()
            started.set()
            return
        started.set()

        interval = self.loop_interval_s
        if interval is None:
            self._stop.wait()
            self._cleanup_quietly()
            return

        while not self._stop.is_set():
            start = time.perf_counter()
            try:
                busy = self.loop()
            except Exception as exc:
                self.log("error", f"loop failed: {exc!r}\n{traceback.format_exc()}")
                # Avoid tight-spinning on a broken loop.
                self._stop.wait(0.5)
                continue
            elapsed = time.perf_counter() - start
            if busy is not False:
                self.record("loop_ms", elapsed * 1000.0)
            if interval > 0:
                remaining = interval - elapsed
                if remaining > 0:
                    self._stop.wait(remaining)

        self._cleanup_quietly()

    def _stop_subscriptions_quietly(self) -> None:
        with self._subscriptions_lock:
            keys = list(self._subscriptions)
        for driver, event in keys:
            try:
                self.unsubscribe(driver, event)
            except Exception as exc:
                self.log("warn", f"unsubscribe {driver}.{event} failed: {exc!r}")
        with self._subscriptions_lock:
            workers = list(self._retired_workers)
            self._retired_workers.clear()
        for worker in workers:
            if not worker.join(5.0):
                self.log("warn", "subscription worker did not stop within 5s")

    def _cleanup_quietly(self) -> None:
        try:
            self.cleanup()
        except Exception as exc:
            self.log("error", f"cleanup failed: {exc!r}")
