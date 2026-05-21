"""Ball detector using YOLOv8 object detection.

Uses a lightweight YOLOv8n model pre-trained on COCO to detect pool balls.
The camera frame is warped into display space (via the calibration homography)
*before* YOLO inference, so detections are directly in the 1920x1080
reference coordinate system with no further mapping needed.

Rather than relying on COCO's "sports ball" class, detection runs across all
classes and filters by bounding-box geometry: only small, roughly-square
detections pass (pool balls are the only small round objects on a felt
surface).  An exponential moving average (EMA) tracker smooths positions
across frames and suppresses single-frame noise.

The model auto-downloads on first use (~6 MB) into ``~/.gosai/models/``.

Events:
- ``balls``: list of ``{x, y, r}`` positions in display pixels.
- ``fps``: rolling FPS estimate over the most recent 50 frames.

Actions:
- ``set_homography(matrix9)``       — row-major 3x3 flattened
- ``set_output_size({width, height})``
- ``set_confidence(0..1)``          — minimum YOLO confidence
- ``set_max_ball_px(px)``           — max bounding-box side in display pixels
- ``set_min_ball_px(px)``           — min bounding-box side in display pixels
- ``set_smoothing(0..1)``           — EMA alpha (0 = no smoothing, 1 = full)
- ``set_background(jpeg_base64)``   — accepted but unused (backward compat)
"""

from __future__ import annotations

import io
import logging
import math
import os
import sys
import time
import urllib.request
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from typing import Any, ClassVar, Generator

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

YOLO_MODEL_FILENAME = "yolov8n.pt"
YOLO_MODEL_URL = (
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt"
)


def _gosai_home() -> Path:
    override = os.environ.get("GOSAI_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".gosai"


def _ensure_model(log_fn: Any) -> Path | None:
    target = _gosai_home() / "models" / YOLO_MODEL_FILENAME
    if target.exists() and target.stat().st_size > 0:
        return target
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        log_fn("info", f"ball: downloading {YOLO_MODEL_FILENAME} to {target}")
        tmp = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(YOLO_MODEL_URL, timeout=60) as resp, tmp.open("wb") as fp:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                fp.write(chunk)
        tmp.replace(target)
        log_fn("info", "ball: model download complete")
        return target
    except Exception as exc:
        log_fn("error", f"ball: failed to download model: {exc!r}")
        return None


@contextmanager
def _suppress_stdout() -> Generator[None, None, None]:
    """Redirect stdout/stderr so ultralytics can't corrupt the bridge protocol."""
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    try:
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        yield
    finally:
        sys.stdout = real_stdout
        sys.stderr = real_stderr


def _silence_ultralytics_logging() -> None:
    os.environ["YOLO_VERBOSE"] = "False"
    for name in ("ultralytics", "ultralytics.utils", "ultralytics.engine",
                 "ultralytics.nn", "ultralytics.data"):
        logging.getLogger(name).setLevel(logging.CRITICAL)


# ── EMA ball tracker ─────────────────────────────────────────────────────

class _TrackedBall:
    __slots__ = ("x", "y", "r", "age", "missed")

    def __init__(self, x: float, y: float, r: float) -> None:
        self.x = x
        self.y = y
        self.r = r
        self.age = 1
        self.missed = 0

    def update(self, x: float, y: float, r: float, alpha: float) -> None:
        self.x += alpha * (x - self.x)
        self.y += alpha * (y - self.y)
        self.r += alpha * (r - self.r)
        self.age += 1
        self.missed = 0


class _BallTracker:
    """Nearest-neighbour tracker with EMA smoothing."""

    def __init__(self, alpha: float = 0.45, max_miss: int = 3,
                 match_radius: float = 80.0, min_age: int = 2) -> None:
        self.alpha = alpha
        self.max_miss = max_miss
        self.match_radius = match_radius
        self.min_age = min_age
        self.tracks: list[_TrackedBall] = []

    def update(self, detections: list[tuple[float, float, float]]) -> list[_TrackedBall]:
        used_det: set[int] = set()
        used_trk: set[int] = set()

        # Greedy nearest-neighbour matching.
        pairs: list[tuple[float, int, int]] = []
        for ti, trk in enumerate(self.tracks):
            for di, (dx, dy, _dr) in enumerate(detections):
                dist = math.hypot(dx - trk.x, dy - trk.y)
                if dist < self.match_radius:
                    pairs.append((dist, ti, di))
        pairs.sort()
        for dist, ti, di in pairs:
            if ti in used_trk or di in used_det:
                continue
            dx, dy, dr = detections[di]
            self.tracks[ti].update(dx, dy, dr, self.alpha)
            used_trk.add(ti)
            used_det.add(di)

        # Spawn new tracks for unmatched detections.
        for di, (dx, dy, dr) in enumerate(detections):
            if di not in used_det:
                self.tracks.append(_TrackedBall(dx, dy, dr))

        # Age unmatched tracks and cull stale ones.
        for ti, trk in enumerate(self.tracks):
            if ti not in used_trk:
                trk.missed += 1
        self.tracks = [t for t in self.tracks if t.missed <= self.max_miss]

        return [t for t in self.tracks if t.age >= self.min_age]


# ── Driver ───────────────────────────────────────────────────────────────

class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "YOLO-based ball detector."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_background",
        "set_homography",
        "set_output_size",
        "set_confidence",
        "set_max_ball_px",
        "set_min_ball_px",
        "set_smoothing",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    DEFAULT_OUTPUT_SIZE: ClassVar[tuple[int, int]] = (1920, 1080)

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._model: Any = None
        self._homography: Any = None
        self._output_size = self.DEFAULT_OUTPUT_SIZE
        self._confidence = 0.15
        self._min_ball_px = 10.0
        self._max_ball_px = 80.0
        self._max_aspect = 1.8
        self._frame_times: deque[float] = deque(maxlen=50)
        self._tracker = _BallTracker(alpha=0.45, max_miss=3, min_age=2)

    def pre_run(self) -> None:
        super().pre_run()
        _silence_ultralytics_logging()

        model_path = _ensure_model(self.log)
        if model_path is None:
            self.log("error", "ball: model unavailable, driver inactive")
            return

        try:
            with _suppress_stdout():
                from ultralytics import YOLO  # type: ignore[import-not-found]
                self._model = YOLO(str(model_path))
            self.log("info", f"YOLO model loaded ({model_path.name})")
        except ImportError as exc:
            self.log("error", f"ultralytics not installed: {exc}")
        except Exception as exc:
            self.log("error", f"failed to load YOLO model: {exc!r}")
            self._model = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_background":
            return {"ok": True, "note": "background not used by YOLO detector"}
        if action == "set_homography":
            return self._set_homography(data)
        if action == "set_output_size":
            return self._set_output_size(data)
        if action == "set_confidence":
            self._confidence = max(0.01, min(1.0, float(data)))
            return {"confidence": self._confidence}
        if action == "set_max_ball_px":
            self._max_ball_px = float(data)
            return {"max_ball_px": self._max_ball_px}
        if action == "set_min_ball_px":
            self._min_ball_px = float(data)
            return {"min_ball_px": self._min_ball_px}
        if action == "set_smoothing":
            self._tracker.alpha = max(0.0, min(1.0, float(data)))
            return {"smoothing": self._tracker.alpha}
        # Legacy actions -- accept silently.
        if action in ("set_min_area", "set_threshold", "set_max_area",
                       "set_min_circularity", "set_hand_landmarks",
                       "set_hand_radius", "set_persistence", "set_classes"):
            return {"ok": True, "note": f"{action} not used by YOLO detector"}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Main detection pipeline
    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict) or self._model is None:
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return

        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv required: {exc}")
            return

        from gosai_py.serialization import jpeg_base64_to_frame

        frame = jpeg_base64_to_frame(encoded)
        if frame is None:
            return

        start = time.perf_counter()

        # Warp the camera frame into display space BEFORE detection so that
        # YOLO coordinates are directly in the 1920x1080 reference system.
        if self._homography is not None:
            frame = cv2.warpPerspective(
                frame, self._homography, self._output_size, flags=cv2.INTER_LINEAR,
            )

        with _suppress_stdout():
            results = self._model(
                frame,
                conf=self._confidence,
                verbose=False,
            )

        # Filter detections by bounding-box geometry: only small, roughly
        # square boxes qualify as pool balls.
        detections: list[tuple[float, float, float]] = []
        for box in results[0].boxes:
            cx, cy, w, h = box.xywh[0].tolist()
            side = max(w, h)
            if side < self._min_ball_px or side > self._max_ball_px:
                continue
            aspect = max(w, h) / max(min(w, h), 1.0)
            if aspect > self._max_aspect:
                continue
            r = (w + h) / 4.0
            detections.append((cx, cy, r))

        # Smooth with the EMA tracker.
        stable = self._tracker.update(detections)
        balls: list[dict[str, Any]] = [
            {"x": int(t.x), "y": int(t.y), "r": round(t.r * 2, 1)}
            for t in stable
        ]

        now = time.perf_counter()
        self._frame_times.append(now)
        if len(self._frame_times) >= 2:
            span = self._frame_times[-1] - self._frame_times[0]
            fps = (len(self._frame_times) - 1) / span if span > 0 else 0.0
            self.emit("fps", {"fps": round(fps, 2)})
        self.record("loop_ms", (now - start) * 1000.0)

        self.emit("balls", {"balls": balls, "count": len(balls), "ts": time.time()})

    # ------------------------------------------------------------------
    # Setters
    # ------------------------------------------------------------------

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
