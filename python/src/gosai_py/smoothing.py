"""Temporal smoothing shared by drivers."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from numpy.typing import NDArray

type Array = NDArray[np.float64]

# Timestamps arrive from the camera, so a dt outside this range is either a
# duplicated frame or a hiccup, and neither should drive the filter.
MIN_DT_S = 0.001
MAX_DT_S = 0.2
# Past this the previous value says nothing about the current one.
RESET_GAP_S = 0.5


def lerp[T: Any](previous: T, current: T, t: Any) -> T:
    """Move `previous` toward `current` by `t`. Works on numbers and numpy arrays.

    `t = 1` returns `current`; a small `t` smooths heavily. Used as an
    exponential moving average when applied once per sample.
    """
    return previous + (current - previous) * t


def _alpha(cutoff_hz: Any, dt_s: float) -> Any:
    """Exponential smoothing factor of a first-order low pass at `cutoff_hz`."""
    tau = 1.0 / (2.0 * math.pi * cutoff_hz)
    return 1.0 / (1.0 + tau / dt_s)


def _speed(rate: Array) -> Array:
    """Magnitude of the derivative: one per row of a 2D array, else one per element.

    A landmark's x and y then share a cutoff, so a moving point stays a point
    instead of stretching along the axis that happens to move faster.
    """
    if rate.ndim == 2:
        return np.linalg.norm(rate, axis=1, keepdims=True)
    return np.abs(rate)


class OneEuro:
    """One Euro filter (Casiez et al., https://gery.casiez.net/1euro/), time aware.

    A low pass whose cutoff rises with the observed speed: heavy smoothing
    while still, little lag while moving. `min_cutoff_hz` sets the smoothing at
    rest and `beta` how fast the filter gives way to motion. Both are in the
    units of the filtered values per second.

    The state is an array of any shape, filtered element by element, and the
    timestamps carry milliseconds, so an irregular frame rate changes the
    smoothing rather than the amount of lag. A gap over half a second or a shape
    change restarts the filter. A timestamp that does not advance holds the output.
    """

    def __init__(self, min_cutoff_hz: float, beta: float, d_cutoff_hz: float = 1.0) -> None:
        self.min_cutoff_hz = float(min_cutoff_hz)
        self.beta = float(beta)
        self.d_cutoff_hz = float(d_cutoff_hz)
        self._value: Array | None = None
        self._rate: Array | None = None
        self._t_ms: float | None = None

    def reset(self) -> None:
        """Forget the state. The next call returns its input unchanged."""
        self._value = None
        self._rate = None
        self._t_ms = None

    def __call__(self, value: Array, t_ms: float) -> Array:
        """The filtered `value` observed at `t_ms` milliseconds.

        NaN elements pass through as NaN and leave the state alone, so a
        landmark that disappears for a frame does not drag the others.
        """
        current = np.asarray(value, dtype=np.float64)
        previous, rate, last_t = self._value, self._rate, self._t_ms
        if previous is None or rate is None or last_t is None:
            return self._restart(current, t_ms)
        gap_s = (t_ms - last_t) / 1000.0
        if previous.shape != current.shape or abs(gap_s) > RESET_GAP_S:
            return self._restart(current, t_ms)
        if gap_s <= 0.0:
            # A repeated or late frame carries no new time. Restarting here
            # would pass its jitter straight through, so hold the output.
            return np.where(np.isnan(current), np.nan, previous)

        dt_s = min(max(gap_s, MIN_DT_S), MAX_DT_S)
        missing = np.isnan(current)
        # An element whose state is NaN has never been seen; it starts here.
        fresh = np.isnan(previous) & ~missing

        with np.errstate(invalid="ignore"):
            stepped = rate + _alpha(self.d_cutoff_hz, dt_s) * ((current - previous) / dt_s - rate)
        rate = np.where(missing, rate, np.where(fresh, 0.0, stepped))
        cutoff = self.min_cutoff_hz + self.beta * _speed(rate)
        with np.errstate(invalid="ignore"):
            smoothed = previous + _alpha(cutoff, dt_s) * (current - previous)
        state = np.where(missing, previous, np.where(fresh, current, smoothed))

        self._value, self._rate, self._t_ms = state, rate, float(t_ms)
        return np.where(missing, np.nan, state)

    def _restart(self, current: Array, t_ms: float) -> Array:
        self._value = current.copy()
        self._rate = np.zeros_like(current)
        self._t_ms = float(t_ms)
        return current
