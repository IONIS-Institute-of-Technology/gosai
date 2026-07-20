"""Annotated-preview rendering shared by `autolabel` and `mine`."""

from __future__ import annotations

from typing import Any


def draw_detections(img: Any, boxes: list[tuple[float, float, float, float, float]]) -> Any:
    """Draw ``(x1, y1, x2, y2, conf)`` boxes on a BGR image (in place)."""
    import cv2  # type: ignore[import-not-found]

    for x1, y1, x2, y2, conf in boxes:
        p1, p2 = (int(x1), int(y1)), (int(x2), int(y2))
        cv2.rectangle(img, p1, p2, (0, 255, 0), 2)
        cv2.putText(
            img, f"{conf:.2f}", (p1[0], max(12, p1[1] - 4)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA,
        )
    return img
