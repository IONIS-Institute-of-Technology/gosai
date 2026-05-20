"""Body-pose driver.

Wraps MediaPipe Holistic to provide face mesh, body pose, hand landmarks, and
body world coordinates. Subscribes to `camera.color` and emits `raw_data`.

The output schema mirrors the legacy driver to keep apps portable.
"""

from __future__ import annotations

import time
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.serialization import jpeg_base64_to_frame


class PoseDriver(BaseProcessor):
    name: ClassVar[str] = "pose"
    description: ClassVar[str] = "Body, face and hand landmarks (MediaPipe Holistic)."
    events: ClassVar[tuple[str, ...]] = ("raw_data",)
    actions: ClassVar[tuple[str, ...]] = ("set_flip", "set_window")
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._holistic: Any = None
        self._flip = False
        self._window = 1.0

    def pre_run(self) -> None:
        super().pre_run()
        try:
            import mediapipe as mp  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"mediapipe not available: {exc}")
            return
        self._holistic = mp.solutions.holistic.Holistic(  # type: ignore[attr-defined]
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5,
            smooth_landmarks=True,
            model_complexity=0,
            refine_face_landmarks=True,
        )
        self.log("info", "MediaPipe Holistic initialized")

    def cleanup(self) -> None:
        super().cleanup()
        if self._holistic is not None:
            try:
                self._holistic.close()
            except Exception as exc:
                self.log("warn", f"holistic.close failed: {exc!r}")
            self._holistic = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_flip":
            self._flip = bool(data)
            return {"flip": self._flip}
        if action == "set_window":
            self._window = max(min(float(data), 1.0), 0.05)
            return {"window": self._window}
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._holistic is None or not isinstance(data, dict):
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv required: {exc}")
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
        rgb = cv2.cvtColor(cropped, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False

        start = time.perf_counter()
        results = self._holistic.process(rgb)
        inference_ms = (time.perf_counter() - start) * 1000.0

        h_crop, w_crop = cropped.shape[:2]

        def to_xyv(landmarks: Any) -> list[list[float]]:
            return [
                [
                    float(x0 + lm.x * w_crop),
                    float(lm.y * h_crop),
                    round(float(lm.visibility), 2) if hasattr(lm, "visibility") else 1.0,
                ]
                for lm in landmarks
            ]

        def to_xyzv(landmarks: Any) -> list[list[float]]:
            return [
                [
                    float(lm.x),
                    float(lm.y),
                    float(lm.z),
                    round(float(lm.visibility), 2) if hasattr(lm, "visibility") else 1.0,
                ]
                for lm in landmarks
            ]

        payload = {
            "face_mesh": to_xyv(results.face_landmarks.landmark) if results.face_landmarks else [],
            "body_pose": to_xyv(results.pose_landmarks.landmark) if results.pose_landmarks else [],
            "left_hand_pose": to_xyv(results.left_hand_landmarks.landmark)
            if results.left_hand_landmarks
            else [],
            "right_hand_pose": to_xyv(results.right_hand_landmarks.landmark)
            if results.right_hand_landmarks
            else [],
            "body_world_pose": to_xyzv(results.pose_world_landmarks.landmark)
            if results.pose_world_landmarks
            else [],
            "ts": time.time(),
            "inference_ms": inference_ms,
        }
        self.record("inference_ms", inference_ms)
        self.emit("raw_data", payload)
