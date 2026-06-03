"""Body-pose driver.

Wraps the MediaPipe **Tasks** ``HolisticLandmarker`` to provide face mesh, body
pose, hand landmarks, and body world coordinates. Subscribes to `camera.color`
and emits `raw_data`.

MediaPipe removed the legacy ``mp.solutions`` API in 0.10.31; this driver uses
the current Tasks vision API (``mediapipe.tasks.python.vision``). The model
bundle (``holistic_landmarker.task``) is downloaded once into ``~/.gosai/models``
on first launch. The emitted output schema is unchanged so apps stay portable.
"""

from __future__ import annotations

import os
import time
import urllib.request
from pathlib import Path
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.serialization import jpeg_base64_to_frame

MODEL_FILENAME = "holistic_landmarker.task"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
    "holistic_landmarker/float16/latest/holistic_landmarker.task"
)


def _models_dir() -> Path:
    override = os.environ.get("GOSAI_HOME")
    home = Path(override).expanduser().resolve() if override else Path.home() / ".gosai"
    d = home / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _ensure_model(log_fn: Any) -> Path | None:
    """Return the cached model path, downloading the bundle if missing."""
    path = _models_dir() / MODEL_FILENAME
    if path.exists() and path.stat().st_size > 0:
        return path
    try:
        log_fn("info", f"pose: downloading {MODEL_FILENAME}")
        tmp = path.with_suffix(path.suffix + ".part")
        with urllib.request.urlopen(MODEL_URL, timeout=120) as resp, tmp.open("wb") as fp:
            while chunk := resp.read(64 * 1024):
                fp.write(chunk)
        tmp.replace(path)
        log_fn("info", f"pose: download complete ({MODEL_FILENAME})")
        return path
    except Exception as exc:
        log_fn("error", f"pose: model download failed: {exc!r}")
        return None


def _visibility(landmark: Any) -> float:
    vis = getattr(landmark, "visibility", None)
    return round(float(vis), 2) if vis is not None else 1.0


class PoseDriver(BaseProcessor):
    name: ClassVar[str] = "pose"
    description: ClassVar[str] = "Body, face and hand landmarks (MediaPipe Holistic Landmarker)."
    events: ClassVar[tuple[str, ...]] = ("raw_data",)
    actions: ClassVar[tuple[str, ...]] = ("set_flip", "set_window")
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._landmarker: Any = None
        self._mp: Any = None
        self._flip = False
        self._window = 1.0
        self._last_ts_ms = 0

    def pre_run(self) -> None:
        super().pre_run()
        try:
            import mediapipe as mp  # type: ignore[import-not-found]
            from mediapipe.tasks.python import vision  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"mediapipe not available: {exc}")
            return

        model_path = _ensure_model(self.log)
        if model_path is None:
            return

        options = vision.HolisticLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.VIDEO,
        )
        self._landmarker = vision.HolisticLandmarker.create_from_options(options)
        self._mp = mp
        self.log("info", "MediaPipe Holistic Landmarker initialized")

    def cleanup(self) -> None:
        super().cleanup()
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception as exc:
                self.log("warn", f"holistic.close failed: {exc!r}")
            self._landmarker = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_flip":
            self._flip = bool(data)
            return {"flip": self._flip}
        if action == "set_window":
            self._window = max(min(float(data), 1.0), 0.05)
            return {"window": self._window}
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._landmarker is None or not isinstance(data, dict):
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        frame = jpeg_base64_to_frame(encoded)
        if frame is None:
            return
        if self._flip:
            frame = cv2.flip(frame, 1)

        w_full = frame.shape[1]
        if self._window < 1.0:
            half = self._window / 2.0
            x0 = int((0.5 - half) * w_full)
            x1 = int((0.5 + half) * w_full)
            cropped = frame[:, x0:x1]
        else:
            x0 = 0
            cropped = frame

        rgb = np.ascontiguousarray(cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB))
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)

        # VIDEO mode requires strictly increasing timestamps (ms).
        ts_ms = max(self._last_ts_ms + 1, int(time.perf_counter() * 1000))
        self._last_ts_ms = ts_ms

        start = time.perf_counter()
        result = self._landmarker.detect_for_video(mp_image, ts_ms)
        inference_ms = (time.perf_counter() - start) * 1000.0

        h_crop, w_crop = cropped.shape[:2]

        def to_xyv(landmarks: Any) -> list[list[float]]:
            return [
                [float(x0 + lm.x * w_crop), float(lm.y * h_crop), _visibility(lm)]
                for lm in landmarks
            ]

        def to_xyzv(landmarks: Any) -> list[list[float]]:
            return [[float(lm.x), float(lm.y), float(lm.z), _visibility(lm)] for lm in landmarks]

        payload = {
            "face_mesh": to_xyv(result.face_landmarks),
            "body_pose": to_xyv(result.pose_landmarks),
            "left_hand_pose": to_xyv(result.left_hand_landmarks),
            "right_hand_pose": to_xyv(result.right_hand_landmarks),
            "body_world_pose": to_xyzv(result.pose_world_landmarks),
            # Landmark x/y are in the (full) camera frame's pixel space; report
            # the frame size so downstream projection is resolution-aware.
            "frame_width": float(w_full),
            "frame_height": float(cropped.shape[0]),
            "ts": time.time(),
            "inference_ms": inference_ms,
        }
        self.record("inference_ms", inference_ms)
        self.emit("raw_data", payload)
