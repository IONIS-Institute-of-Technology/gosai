"""Hand-sign driver.

Classifies the gesture for each hand in `hand_pose.raw_data` using a
geometric heuristic over MediaPipe landmark positions. This avoids shipping a
binary ONNX model.

Recognized labels (matching the legacy driver where applicable):

- `OPEN_HAND`, `FIST`, `THUMB_UP`, `THUMB_DOWN`, `INDEX`, `TWO`, `THREE`,
  `OK`, `PINCH`, `UNKNOWN`.

Output payload (matches legacy):

```json
{
  "sign": [["OK", 0.95], ["FIST", 0.92]],
  "ts": 1716200000.123
}
```
"""

from __future__ import annotations

import math
import time
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

Point = tuple[float, float]


class HandSignDriver(BaseProcessor):
    name: ClassVar[str] = "hand_sign"
    description: ClassVar[str] = "Hand gesture classification (geometric)."
    events: ClassVar[tuple[str, ...]] = ("sign",)
    actions: ClassVar[tuple[str, ...]] = ()
    dependencies: ClassVar[tuple[str, ...]] = ("hand_pose",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("hand_pose", "raw_data"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        hands = data.get("hands_landmarks") or []
        if not isinstance(hands, list):
            return
        results: list[list[Any]] = []
        for hand in hands:
            if not isinstance(hand, list) or len(hand) < 21:
                results.append(["UNKNOWN", 0.0])
                continue
            label, score = _classify_hand([(float(p[0]), float(p[1])) for p in hand])
            results.append([label, score])
        self.emit("sign", {"sign": results, "ts": time.time()})


# Indices in MediaPipe hand landmarks
WRIST = 0
THUMB_TIP, THUMB_IP, THUMB_MCP = 4, 3, 2
INDEX_TIP, INDEX_PIP, INDEX_MCP = 8, 6, 5
MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP = 12, 10, 9
RING_TIP, RING_PIP, RING_MCP = 16, 14, 13
PINKY_TIP, PINKY_PIP, PINKY_MCP = 20, 18, 17


def _dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _finger_extended(landmarks: list[Point], tip: int, pip: int, mcp: int) -> bool:
    """Heuristic: the finger is extended if the tip is farther from the
    wrist than both the PIP and MCP joints (relative ordering along the
    finger direction)."""
    wrist = landmarks[WRIST]
    return _dist(landmarks[tip], wrist) > _dist(landmarks[pip], wrist) > _dist(landmarks[mcp], wrist) * 0.9


def _thumb_extended(landmarks: list[Point]) -> bool:
    """Thumb is extended when the tip is far from the index MCP."""
    return _dist(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) > _dist(
        landmarks[THUMB_IP], landmarks[INDEX_MCP]
    )


def _classify_hand(landmarks: list[Point]) -> tuple[str, float]:
    """Geometric classification of a single hand. Returns (label, confidence).

    The confidence is a coarse score in [0, 1] derived from how cleanly the
    landmarks satisfy the rule rather than a real probability.
    """
    if len(landmarks) < 21:
        return ("UNKNOWN", 0.0)

    fingers = [
        _finger_extended(landmarks, INDEX_TIP, INDEX_PIP, INDEX_MCP),
        _finger_extended(landmarks, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP),
        _finger_extended(landmarks, RING_TIP, RING_PIP, RING_MCP),
        _finger_extended(landmarks, PINKY_TIP, PINKY_PIP, PINKY_MCP),
    ]
    thumb = _thumb_extended(landmarks)
    extended_count = sum(fingers) + (1 if thumb else 0)

    # Fist: nothing extended. Check this first since fist hands also have
    # close thumb/index tips and would otherwise be misclassified as PINCH.
    if extended_count == 0:
        return ("FIST", 0.95)

    # Pinch family: thumb and index tips close together.
    pinch_dist = _dist(landmarks[THUMB_TIP], landmarks[INDEX_TIP])
    palm_size = max(_dist(landmarks[WRIST], landmarks[MIDDLE_MCP]), 1e-3)
    pinch_ratio = pinch_dist / palm_size

    if pinch_ratio < 0.3 and fingers[1] and fingers[2] and fingers[3]:
        return ("OK", 1.0 - pinch_ratio)
    # Real pinch posture has at least the middle finger extended.
    if pinch_ratio < 0.25 and any(fingers[1:]):
        return ("PINCH", 1.0 - pinch_ratio)
    # Open hand: everything extended.
    if all(fingers) and thumb:
        return ("OPEN_HAND", 0.95)

    # Thumbs-up: only thumb extended. Direction determines up/down.
    if thumb and not any(fingers):
        # In MediaPipe normalized coordinates, y grows downward.
        if landmarks[THUMB_TIP][1] < landmarks[WRIST][1]:
            return ("THUMB_UP", 0.9)
        return ("THUMB_DOWN", 0.9)

    # Index pointing: only index extended.
    if fingers[0] and not (fingers[1] or fingers[2] or fingers[3]):
        return ("INDEX", 0.9)

    # Two: index + middle extended.
    if fingers[0] and fingers[1] and not (fingers[2] or fingers[3]):
        return ("TWO", 0.85)

    # Three: index + middle + ring extended.
    if fingers[0] and fingers[1] and fingers[2] and not fingers[3]:
        return ("THREE", 0.85)

    return ("UNKNOWN", float(extended_count) / 5.0)
