"""An example app driver: counts up once a second and can be reset."""

from __future__ import annotations

from collections.abc import Mapping
from typing import ClassVar

import msgspec

from gosai_py import BaseDriver, DriverContext, Event, action


class Count(msgspec.Struct, kw_only=True):
    count: int


class CounterDriver(BaseDriver):
    # Apps see this driver as `hello-gosai/counter`.
    name = "counter"
    description = "Counts up once a second."
    events: ClassVar[Mapping[str, Event]] = {
        "count": Event(Count, "Every second, with the current count."),
    }
    loop_interval_s = 1.0

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._count = 0

    def loop(self) -> None:
        self._count += 1
        self.emit("count", Count(count=self._count))

    @action("Start counting again from `start`.")
    def reset(self, start: int) -> Count:
        self._count = start
        return Count(count=start)
