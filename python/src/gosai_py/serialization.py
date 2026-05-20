"""Serialization helpers for driver payloads.

The JSON-line bridge protocol carries small, structured data well. Bulky
numpy arrays (frames, audio buffers) should be encoded for transport.

- `frame_to_jpeg_base64(frame)`: encode an HxWx3 BGR frame to a base64 JPEG.
- `frame_to_png_base64(frame)`: encode to PNG (lossless).
- `to_msgpack(value)`: pack a structure into a MessagePack bytes object.
- `from_msgpack(bytes_value)`: unpack the inverse.

Frame encoding requires `opencv-python` (install with `[cv]` extra).
"""

from __future__ import annotations

import base64
from typing import Any

import msgpack  # type: ignore[import-not-found]


def to_msgpack(value: Any) -> bytes:
    """Pack a value using MessagePack."""
    return msgpack.packb(value, use_bin_type=True)


def from_msgpack(data: bytes) -> Any:
    """Unpack a MessagePack-encoded payload."""
    return msgpack.unpackb(data, raw=False)


def frame_to_jpeg_base64(frame: Any, quality: int = 75) -> str:
    """Encode an OpenCV BGR frame as a base64 JPEG data string.

    Returns a value suitable for embedding in JSON; the JS side can decode it
    by setting `img.src = "data:image/jpeg;base64," + value`.
    """
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError("opencv-python is required for frame encoding") from exc
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def frame_to_png_base64(frame: Any) -> str:
    """Lossless PNG variant of `frame_to_jpeg_base64`."""
    try:
        import cv2  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError("opencv-python is required for frame encoding") from exc
    ok, buf = cv2.imencode(".png", frame)
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")


def jpeg_base64_to_frame(encoded: str) -> Any:
    """Decode a base64 JPEG string back to an OpenCV BGR ndarray.

    Returns `None` if decoding fails. Useful for drivers that subscribe to the
    camera driver's `color` event and need to run further OpenCV processing.
    """
    try:
        import cv2  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - optional dep
        raise RuntimeError("opencv-python is required for frame decoding") from exc
    raw = base64.b64decode(encoded)
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)
