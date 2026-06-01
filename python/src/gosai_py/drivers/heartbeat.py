"""Heartbeat driver - emits a tick event at a steady cadence.

Useful for verifying the bridge -> driver -> server -> client pipeline end to
end. Real CV/ML drivers ship in later phases.
"""

from __future__ import annotations

import time
from typing import Any

from gosai_py.driver import BaseDriver


class HeartbeatDriver(BaseDriver):
    name = "heartbeat"
    description = "Emits a periodic tick event for plumbing tests."
    events = ("tick",)
    actions = ("echo",)
    dependencies = ()
    loop_interval_s = 0.5
    shared = True

    def __init__(self, context: Any) -> None:
        super().__init__(context)
        self._counter = 0

    def loop(self) -> None:
        self._counter += 1
        self.emit("tick", {"count": self._counter, "now": time.time()})

    def execute(self, action: str, data: Any) -> Any:
        if action == "echo":
            return {"echoed": data, "count": self._counter}
        return super().execute(action, data)
