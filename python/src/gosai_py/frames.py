"""Helpers for drivers that consume `camera.frame`."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray

from gosai_py.clock import now_ms


def clamp_window(value: float) -> float:
    """Keep a horizontal crop fraction within [0.05, 1]."""
    return max(min(float(value), 1.0), 0.05)


def capture_timing(payload: Mapping[str, Any]) -> tuple[float, float]:
    """The frame's capture time and its age, both in milliseconds."""
    raw = payload.get("capture_ts")
    now = now_ms()
    capture_ts = float(raw) if isinstance(raw, int | float) else now
    return capture_ts, now - capture_ts


def latency_ms(capture_ts: float) -> float:
    """Milliseconds since `capture_ts`, itself in milliseconds since the epoch."""
    return now_ms() - capture_ts


def flip_and_crop(frame: NDArray[Any], flip: bool, window: float) -> tuple[NDArray[Any], int]:
    """Mirror the frame horizontally if asked, then keep a centered horizontal window.

    Returns the cropped view and its left offset in the full frame.
    """
    if flip:
        frame = cv2.flip(frame, 1)
    if window >= 1.0:
        return frame, 0
    width = frame.shape[1]
    x0 = int((0.5 - window / 2.0) * width)
    x1 = int((0.5 + window / 2.0) * width)
    return frame[:, x0:x1], x0


def contiguous(image: NDArray[Any]) -> NDArray[Any]:
    return image if image.flags["C_CONTIGUOUS"] else np.ascontiguousarray(image)
