"""Heartbeat driver: emits a tick at a steady cadence, for testing the pipeline end to end."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any, ClassVar

import msgspec

from gosai_py.driver import BaseDriver, DriverContext, Event, action


class TickPayload(msgspec.Struct, kw_only=True):
    count: int
    now: float


class EchoResult(msgspec.Struct, kw_only=True):
    echoed: Any
    count: int


class HeartbeatDriver(BaseDriver):
    name = "heartbeat"
    description = "Emits a periodic tick event for plumbing tests."
    events: ClassVar[Mapping[str, Event]] = {
        "tick": Event(TickPayload, "Every half second, with a running count."),
    }
    loop_interval_s = 0.5
    shared = True

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._counter = 0

    def loop(self) -> None:
        self._counter += 1
        self.emit("tick", {"count": self._counter, "now": time.time()})

    @action("Return the data unchanged, with the current tick count.")
    def echo(self, data: Any) -> EchoResult:
        return EchoResult(echoed=data, count=self._counter)
