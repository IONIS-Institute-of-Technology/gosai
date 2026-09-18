"""msgspec types several drivers share in their schemas."""

from __future__ import annotations

from typing import Annotated

import msgspec
import numpy as np
from msgspec import Meta

PositiveInt = Annotated[int, Meta(gt=0)]
# Timestamps from `gosai_py.clock.now_ms()`.
EpochMs = Annotated[float, Meta(description="Milliseconds since the Unix epoch.")]
CaptureMs = Annotated[
    float,
    Meta(description="When the camera captured the frame, in milliseconds since the Unix epoch."),
]
# A 3x3 matrix flattened row by row.
Matrix3x3 = Annotated[list[float], Meta(min_length=9, max_length=9)]
# Audio samples in [-1, 1]: a mono list, or rows of channels (the first is used).
AudioSamples = list[float | list[float]]


class Size(msgspec.Struct, kw_only=True):
    width: PositiveInt
    height: PositiveInt


class SizeResult(msgspec.Struct, kw_only=True):
    width: int
    height: int


class Point(msgspec.Struct, kw_only=True):
    x: float
    y: float


class FpsPayload(msgspec.Struct, kw_only=True):
    fps: float


class FlipResult(msgspec.Struct, kw_only=True):
    flip: bool


class WindowResult(msgspec.Struct, kw_only=True):
    window: float


def mono_samples(samples: AudioSamples) -> np.ndarray:
    """Float32 mono samples, taking the first column of rows."""
    return np.asarray(
        [row[0] if isinstance(row, list) else row for row in samples], dtype=np.float32
    )
