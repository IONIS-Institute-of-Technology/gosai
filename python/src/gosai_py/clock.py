"""Wall-clock time in the unit every GOSAI timestamp uses.

The bridge stamps its messages with `now_ms()` and drivers stamp their
payloads with it, so every `ts` that reaches Node is milliseconds since the
Unix epoch, like JavaScript's `Date.now()`. Durations measured inside a driver
use `time.perf_counter()` or `time.monotonic()` instead.
"""

from __future__ import annotations

import time


def now_ms() -> float:
    """Milliseconds since the Unix epoch."""
    return time.time() * 1000.0
