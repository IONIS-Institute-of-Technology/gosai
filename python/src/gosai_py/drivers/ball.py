"""Ball detector using YOLOv8 object detection.

Uses a lightweight YOLOv8n model pre-trained on COCO to detect balls in the
camera feed.  Unlike background subtraction, an ML detector inherently
distinguishes balls from hands, reflections, and other artifacts -- it only
fires on objects that actually *look* like balls.

The model auto-downloads on first use (~6 MB) into ``~/.gosai/models/``.

Events:
- ``balls``: list of ``{x, y, r}`` positions in display pixels.
- ``fps``: rolling FPS estimate over the most recent 50 frames.

Actions:
- ``set_homography(matrix9)``       — row-major 3×3 flattened
- ``set_output_size({width, height})``
- ``set_confidence(0..1)``          — minimum detection confidence
- ``set_background(jpeg_base64)``   — accepted but unused (backward compat)
"""

from __future__ import annotations

import io
import logging
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
SPORTS_BALL_CLASS = 32


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
    """Temporarily redirect stdout/stderr to devnull.

    Ultralytics prints progress bars, settings banners, and version info
    directly to stdout.  The bridge process uses stdout as its JSON-RPC
    channel, so any stray print corrupts the protocol.
    """
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


class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "YOLO-based ball detector."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_background",
        "set_homography",
        "set_output_size",
        "set_confidence",
        "set_classes",
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
        self._confidence = 0.25
        self._classes: list[int] = [SPORTS_BALL_CLASS]
        self._frame_times: deque[float] = deque(maxlen=50)

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
        if action == "set_classes":
            if isinstance(data, list):
                self._classes = [int(c) for c in data]
            return {"classes": self._classes}
        # Legacy actions that no longer apply -- accept silently.
        if action in ("set_min_area", "set_threshold", "set_max_area",
                       "set_min_circularity", "set_hand_landmarks",
                       "set_hand_radius", "set_persistence"):
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
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        from gosai_py.serialization import jpeg_base64_to_frame

        frame = jpeg_base64_to_frame(encoded)
        if frame is None:
            return

        start = time.perf_counter()

        with _suppress_stdout():
            results = self._model(
                frame,
                classes=self._classes,
                conf=self._confidence,
                verbose=False,
            )

        detections = results[0].boxes
        raw_balls: list[dict[str, float]] = []
        for box in detections:
            cx, cy, w, h = box.xywh[0].tolist()
            conf = float(box.conf[0])
            r = (w + h) / 4.0
            raw_balls.append({"x": cx, "y": cy, "r": r, "conf": conf})

        # Warp centroids through the homography into display coordinates.
        if self._homography is not None and raw_balls:
            pts = np.array(
                [[[b["x"], b["y"]] for b in raw_balls]], dtype=np.float32
            )
            warped = cv2.perspectiveTransform(pts, self._homography)[0]

            sx = self._output_size[0] / max(frame.shape[1], 1)
            sy = self._output_size[1] / max(frame.shape[0], 1)
            scale = (sx + sy) / 2.0

            balls: list[dict[str, Any]] = []
            for i, b in enumerate(raw_balls):
                balls.append({
                    "x": int(warped[i][0]),
                    "y": int(warped[i][1]),
                    "r": round(b["r"] * scale * 2, 1),
                })
        elif raw_balls:
            balls = [
                {"x": int(b["x"]), "y": int(b["y"]), "r": round(b["r"] * 2, 1)}
                for b in raw_balls
            ]
        else:
            balls = []

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
