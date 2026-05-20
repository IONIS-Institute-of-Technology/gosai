"""BaseProcessor - Python-side companion to JS experiences.

Use when an app needs Python processing alongside its experience (e.g. running
a custom ML model whose output is sent to the JS frontend). Processors live in
the bridge process just like drivers and have full access to driver events.

The bridge auto-instantiates a processor when an experience referencing it
starts; the processor's lifecycle is tied to that experience.
"""

from __future__ import annotations

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

    def pre_run(self) -> None:
        for driver, event in self.subscribed:
            cb = self._wrap_callback(driver, event)
            self._subscriptions.append((driver, event, cb))
            self._context.subscribe(driver, event, cb)

    def cleanup(self) -> None:
        for driver, event, cb in self._subscriptions:
            try:
                self._context.unsubscribe(driver, event, cb)
            except Exception as exc:
                self.log("warn", f"cleanup unsubscribe {driver}.{event} failed: {exc!r}")
        self._subscriptions.clear()

    def on_data(self, driver: str, event: str, data: Any) -> None:
        """Override to react to subscribed events."""

    def _wrap_callback(self, driver: str, event: str):
        def _cb(data: Any) -> None:
            try:
                self.on_data(driver, event, data)
            except Exception as exc:
                self.log("error", f"on_data({driver}.{event}) raised: {exc!r}")

        return _cb
