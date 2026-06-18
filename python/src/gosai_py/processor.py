"""BaseProcessor - Python-side companion to JS experiences.

Use when an app needs Python processing alongside its experience (e.g. running
a custom ML model whose output is sent to the JS frontend). Processors live in
the bridge process just like drivers and have full access to driver events.

The bridge auto-instantiates a processor when an experience referencing it
starts; the processor's lifecycle is tied to that experience.
"""

from __future__ import annotations

import threading
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext


class BaseProcessor(BaseDriver):
    """A processor is just a driver with a different role and naming convention.

    Subclasses should set:
    - `name` (recommended pattern: `<app-slug>:<experience-slug>:processor`)
    - `subscribed`: tuple of `(driver_name, event_name)` to auto-subscribe.
    - Override `on_data(driver, event, data)` to handle inputs.
    - Override `emit_*(...)` helpers to publish results back to the SDK.
    """

    subscribed: ClassVar[tuple[tuple[str, str], ...]] = ()
    events: ClassVar[tuple[str, ...]] = ("output",)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._subscriptions: list[tuple[str, str, Any]] = []
        self._latest_condition = threading.Condition()
        self._latest_item: tuple[str, str, Any] | None = None
        self._latest_worker: threading.Thread | None = None
        self._latest_worker_stop = threading.Event()

    def pre_run(self) -> None:
        for driver, event in self.subscribed:
            cb = self._wrap_callback(driver, event)
            self._subscriptions.append((driver, event, cb))
            self._context.subscribe(driver, event, cb)

    def _bridge_stop(self, timeout: float = 5.0) -> None:
        # Tear down subscriptions before signalling stop so upstream drivers
        # (e.g. camera) cannot invoke on_data while this thread is joining or
        # native resources are being released.
        self._teardown_subscriptions()
        super()._bridge_stop(timeout)

    def _teardown_subscriptions(self) -> None:
        for driver, event, cb in self._subscriptions:
            try:
                self._context.unsubscribe(driver, event, cb)
            except Exception as exc:
                self.log("warn", f"unsubscribe {driver}.{event} failed: {exc!r}")
        self._subscriptions.clear()

    def cleanup(self) -> None:
        # Subscriptions are cleared in _bridge_stop; keep cleanup for subclasses
        # that release native handles after the worker thread has exited.
        pass

    def on_data(self, driver: str, event: str, data: Any) -> None:
        """Override to react to subscribed events."""

    def queue_latest_data(self, driver: str, event: str, data: Any) -> None:
        """Queue input for latest-frame processing.

        If a previous input is still waiting, it is replaced. This is the right
        behaviour for camera-driven CV: slow inference should reduce output FPS,
        not increase end-to-end latency by processing stale frames.
        """
        if self.stop_requested() or self._latest_worker_stop.is_set():
            return
        with self._latest_condition:
            self._latest_item = (driver, event, data)
            self._latest_condition.notify()

    def process_latest_data(self, driver: str, event: str, data: Any) -> None:
        """Override when using ``queue_latest_data``."""

    def start_latest_worker(self) -> None:
        if self._latest_worker is not None:
            return
        self._latest_worker_stop.clear()
        self._latest_worker = threading.Thread(
            target=self._latest_worker_loop,
            name=f"processor:{self.name}:latest",
            daemon=True,
        )
        self._latest_worker.start()

    def stop_latest_worker(self, timeout: float = 2.0) -> None:
        worker = self._latest_worker
        if worker is None:
            return
        self._latest_worker_stop.set()
        with self._latest_condition:
            self._latest_item = None
            self._latest_condition.notify_all()
        worker.join(timeout)
        if worker.is_alive():
            self.log("warn", "latest-frame worker did not stop before timeout")
        else:
            self._latest_worker = None

    def _latest_worker_loop(self) -> None:
        while not self._latest_worker_stop.is_set():
            with self._latest_condition:
                while self._latest_item is None and not self._latest_worker_stop.is_set():
                    self._latest_condition.wait()
                if self._latest_worker_stop.is_set():
                    return
                item = self._latest_item
                self._latest_item = None
            if item is None:
                continue
            try:
                self.process_latest_data(*item)
            except Exception as exc:
                self.log("error", f"process_latest_data raised: {exc!r}")

    def _wrap_callback(self, driver: str, event: str):
        def _cb(data: Any) -> None:
            try:
                self.on_data(driver, event, data)
            except Exception as exc:
                self.log("error", f"on_data({driver}.{event}) raised: {exc!r}")

        return _cb
