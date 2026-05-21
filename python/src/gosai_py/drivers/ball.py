"""Ball detector via background subtraction with shape & temporal filtering.

Detects pool balls by subtracting a reference background image from each
camera frame, then filtering candidates by circularity, bounded size, and
temporal persistence.  Hand-exclusion zones can be fed in from the hand_pose
driver so that hands touching the table are never mistaken for balls.

Events:
- ``balls``: list of ``{x, y, r}`` positions in display pixels.
- ``fps``: rolling FPS estimate over the most recent 50 frames.

Actions:
- ``set_background(jpeg_base64)``
- ``set_homography(matrix9)``       — row-major 3×3 flattened
- ``set_output_size({width, height})``
- ``set_min_area(px)`` / ``set_max_area(px)``
- ``set_threshold(value)``
- ``set_min_circularity(0..1)``
- ``set_hand_landmarks(hands)``     — list of 21-landmark hands (pixel coords)
- ``set_hand_radius(px)``           — exclusion radius around each landmark
- ``set_persistence(frames)``       — how many consecutive frames before emitting
"""

from __future__ import annotations

import base64
import math
import time
from collections import deque
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

_TWO_PI = 2.0 * math.pi
_FOUR_PI = 4.0 * math.pi


class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "Background-subtraction ball detector."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_background",
        "set_homography",
        "set_output_size",
        "set_min_area",
        "set_max_area",
        "set_threshold",
        "set_min_circularity",
        "set_hand_landmarks",
        "set_hand_radius",
        "set_persistence",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    DEFAULT_OUTPUT_SIZE: ClassVar[tuple[int, int]] = (1920, 1080)

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._bkg: Any = None
        self._homography: Any = None
        self._output_size = self.DEFAULT_OUTPUT_SIZE
        self._min_area = 700.0
        self._max_area = 12_000.0
        self._threshold = 100
        self._min_circularity = 0.45
        self._frame_times: deque[float] = deque(maxlen=50)

        # Hand exclusion: list of (x, y) pixel positions in warped/output space.
        self._hand_points: list[tuple[float, float]] = []
        self._hand_radius = 60.0

        # Temporal persistence tracker.  Keys are (grid_x, grid_y) bucket IDs;
        # values are the number of consecutive frames the bucket has been seen.
        self._persistence_required = 2
        self._track_buckets: dict[tuple[int, int], int] = {}
        self._bucket_size = 40

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_background":
            return self._set_background(data)
        if action == "set_homography":
            return self._set_homography(data)
        if action == "set_output_size":
            return self._set_output_size(data)
        if action == "set_min_area":
            self._min_area = float(data)
            return {"min_area": self._min_area}
        if action == "set_max_area":
            self._max_area = float(data)
            return {"max_area": self._max_area}
        if action == "set_threshold":
            self._threshold = int(data)
            return {"threshold": self._threshold}
        if action == "set_min_circularity":
            self._min_circularity = max(0.0, min(1.0, float(data)))
            return {"min_circularity": self._min_circularity}
        if action == "set_hand_landmarks":
            return self._set_hand_landmarks(data)
        if action == "set_hand_radius":
            self._hand_radius = max(0.0, float(data))
            return {"hand_radius": self._hand_radius}
        if action == "set_persistence":
            self._persistence_required = max(1, int(data))
            return {"persistence": self._persistence_required}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Main detection pipeline
    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return
        if self._bkg is None or self._homography is None:
            return
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        raw = base64.b64decode(encoded)
        arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        start = time.perf_counter()
        bkg = self._bkg
        if bkg.shape != frame.shape:
            bkg = cv2.resize(bkg, (frame.shape[1], frame.shape[0]))
            self._bkg = bkg

        diff = cv2.absdiff(bkg, frame)
        gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)

        warped = cv2.warpPerspective(
            gray, self._homography, self._output_size, flags=cv2.INTER_LINEAR
        )

        warped = cv2.GaussianBlur(warped, (7, 7), 0)

        if self._hand_points:
            hand_mask = np.zeros(warped.shape[:2], dtype=np.uint8)
            r = int(self._hand_radius)
            for hx, hy in self._hand_points:
                cv2.circle(hand_mask, (int(hx), int(hy)), r, 255, -1)
            warped[hand_mask > 0] = 0

        _, mask = cv2.threshold(warped, self._threshold, 255, cv2.THRESH_BINARY)

        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)

        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )

        candidates: list[dict[str, float]] = []
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < self._min_area or area > self._max_area:
                continue

            perimeter = cv2.arcLength(contour, True)
            if perimeter <= 0:
                continue
            circularity = _FOUR_PI * area / (perimeter * perimeter)
            if circularity < self._min_circularity:
                continue

            m = cv2.moments(contour)
            if m["m00"] <= 0:
                continue
            cx = m["m10"] / m["m00"]
            cy = m["m01"] / m["m00"]
            r = math.sqrt(area / math.pi)
            candidates.append({"x": cx, "y": cy, "r": r})

        # --- Temporal persistence filtering ---
        seen_buckets: dict[tuple[int, int], dict[str, float]] = {}
        for ball in candidates:
            bkt = (
                int(ball["x"]) // self._bucket_size,
                int(ball["y"]) // self._bucket_size,
            )
            seen_buckets[bkt] = ball

        new_track: dict[tuple[int, int], int] = {}
        for bkt, ball in seen_buckets.items():
            prev = self._track_buckets.get(bkt, 0)
            # Also count adjacent buckets so slight jitter doesn't reset the counter.
            if prev == 0:
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nbr = (bkt[0] + dx, bkt[1] + dy)
                        prev = max(prev, self._track_buckets.get(nbr, 0))
            new_track[bkt] = prev + 1

        self._track_buckets = new_track

        balls: list[dict[str, Any]] = []
        for bkt, ball in seen_buckets.items():
            if new_track.get(bkt, 0) >= self._persistence_required:
                balls.append({
                    "x": int(ball["x"]),
                    "y": int(ball["y"]),
                    "r": round(ball["r"] * 2, 1),
                })

        now = time.perf_counter()
        self._frame_times.append(now)
        if len(self._frame_times) >= 2:
            span = self._frame_times[-1] - self._frame_times[0]
            fps = (len(self._frame_times) - 1) / span if span > 0 else 0.0
            self.emit("fps", {"fps": round(fps, 2)})
        self.record("loop_ms", (now - start) * 1000.0)

        self.emit("balls", {"balls": balls, "count": len(balls), "ts": time.time()})

    # ------------------------------------------------------------------
    # Hand exclusion
    # ------------------------------------------------------------------

    def _set_hand_landmarks(self, data: Any) -> dict[str, Any]:
        """Accept hand landmark positions in output-space pixels.

        ``data`` should be a list of hands, where each hand is a list of
        ``[x, y]`` pairs in the warped/output coordinate system. Typically
        only the palm and fingertip landmarks (0, 4, 8, 12, 16, 20) are
        needed, but we accept all 21 for simplicity.
        """
        if not isinstance(data, list):
            self._hand_points = []
            return {"ok": True, "points": 0}
        points: list[tuple[float, float]] = []
        for hand in data:
            if not isinstance(hand, list):
                continue
            for lm in hand:
                if isinstance(lm, (list, tuple)) and len(lm) >= 2:
                    points.append((float(lm[0]), float(lm[1])))
        self._hand_points = points
        return {"ok": True, "points": len(points)}

    # ------------------------------------------------------------------
    # Setters
    # ------------------------------------------------------------------

    def _set_background(self, data: Any) -> dict[str, Any]:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}
        if not isinstance(data, str):
            return {"ok": False, "error": "background must be a base64 jpeg string"}
        raw = base64.b64decode(data)
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return {"ok": False, "error": "failed to decode background"}
        self._bkg = img
        return {"ok": True, "width": int(img.shape[1]), "height": int(img.shape[0])}

    def _set_homography(self, data: Any) -> dict[str, Any]:
        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"numpy required: {exc}"}
        if not isinstance(data, list) or len(data) != 9:
            return {"ok": False, "error": "homography must be a length-9 list"}
        self._homography = np.asarray(data, dtype=np.float32).reshape(3, 3)
        return {"ok": True}

    def _set_output_size(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {"ok": False, "error": "output size must be { width, height }"}
        width = int(data.get("width", self._output_size[0]))
        height = int(data.get("height", self._output_size[1]))
        self._output_size = (width, height)
        return {"ok": True, "width": width, "height": height}
