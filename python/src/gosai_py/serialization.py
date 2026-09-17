"""Frame encoding for payloads that cross the bridge."""

from __future__ import annotations

import base64
from typing import Any

import cv2


def frame_to_jpeg_base64(frame: Any, quality: int = 75) -> str:
    """Encode a BGR frame as base64 JPEG, for `img.src = "data:image/jpeg;base64," + value`."""
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(buf.tobytes()).decode("ascii")
