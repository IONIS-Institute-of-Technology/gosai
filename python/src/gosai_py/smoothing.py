"""Temporal smoothing shared by drivers."""

from __future__ import annotations

from typing import Any


def lerp[T: Any](previous: T, current: T, t: Any) -> T:
    """Move `previous` toward `current` by `t`. Works on numbers and numpy arrays.

    `t = 1` returns `current`; a small `t` smooths heavily. Used as an
    exponential moving average when applied once per sample.
    """
    return previous + (current - previous) * t
