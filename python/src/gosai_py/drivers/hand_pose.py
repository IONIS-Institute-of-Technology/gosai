"""Hand-pose driver.

Runs the MediaPipe Tasks `HandLandmarker` on `camera.frame` and emits
`raw_data`:

    {"hands_landmarks": [[[x, y], ... 21]], "hands_handedness": [[index, "Left"|"Right", score]]}

Landmarks are normalised to 0..1 over the camera frame. Once `set_homography`
receives a camera->surface matrix (from the `calibration` driver), they are
warped and normalised over the surface instead (`set_surface_size`, 1920x1080
by default), so hands line up with the physical surface whatever the camera
angle. The warp denormalises with `set_frame_size` when given, else with the
size of each frame.

The `hand_landmarker.task` model is downloaded into `~/.gosai/models` on first
use.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from typing import Any, ClassVar

import cv2
import mediapipe as mp
import msgspec
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import capture_timing, clamp_window, contiguous, flip_and_crop, latency_ms
from gosai_py.geometry import homography
from gosai_py.payloads import (
    CaptureMs,
    EpochMs,
    FlipResult,
    Matrix3x3,
    Size,
    SizeResult,
    WindowResult,
)
from gosai_py.runtime import mediapipe_base_options
from gosai_py.runtime.models import Model, resolve_model

MODEL = Model.download(
    "hand_landmarker.task",
    url=(
        "https://storage.googleapis.com/mediapipe-models/"
        "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
    ),
    sha256="fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
)

DETECT_WARNING_INTERVAL_S = 5.0


class HandPosePayload(msgspec.Struct, kw_only=True):
    hands_landmarks: list[list[list[float]]]
    hands_handedness: list[tuple[int, str, float]]
    ts: EpochMs
    capture_ts: CaptureMs
    inference_ms: float
    frame_age_ms: float
    latency_ms: float


class HomographyResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    cleared: bool = False


class HandPoseDriver(BaseDriver):
    name = "hand_pose"
    description = "Hand landmark detection (MediaPipe Hands)."
    events: ClassVar[Mapping[str, Event]] = {
        "raw_data": Event(HandPosePayload, "Hand landmarks for the latest camera frame."),
    }
    stream_events = ("raw_data",)
    dependencies = ("camera",)
    subscribed = (("camera", "frame"),)
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._detector_lock = threading.Lock()
        self._detector: Any = None
        self._uses_rgba = False
        self._flip = False
        self._window = 1.0
        self._homography: homography.Matrix | None = None
        # Pinned camera frame size for the warp; None follows the live frames.
        self._frame_size: tuple[int, int] | None = None
        self._surface_size: tuple[int, int] = (1920, 1080)
        self._last_ts_ms = 0
        self._detect_failures = 0
        self._last_failure_warning = -DETECT_WARNING_INTERVAL_S

    def pre_run(self) -> None:
        model_path = resolve_model(MODEL, self.log)
        base_options, info = mediapipe_base_options(BaseOptions, model_path=model_path)
        options = vision.HandLandmarkerOptions(
            base_options=base_options,
            num_hands=2,
            min_hand_detection_confidence=0.5,
            min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            running_mode=vision.RunningMode.VIDEO,
        )
        self._detector = vision.HandLandmarker.create_from_options(options)
        self._uses_rgba = info.get("provider") == "GPUDelegate"
        self.set_runtime_info(info)
        self.log("info", "MediaPipe HandLandmarker initialised")

    def cleanup(self) -> None:
        # Drop the detector without calling close(). MediaPipe's native
        # teardown can SIGSEGV when close races with in-flight inference or
        # camera callbacks; the bridge process exits shortly after anyway.
        with self._detector_lock:
            self._detector = None

    @action("Mirror frames horizontally before detection.")
    def set_flip(self, flip: bool) -> FlipResult:
        self._flip = flip
        return FlipResult(flip=flip)

    @action("Detect only in a centered horizontal fraction of the frame (0.05 to 1).")
    def set_window(self, window: float) -> WindowResult:
        self._window = clamp_window(window)
        return WindowResult(window=self._window)

    @action("Set the camera->surface homography (9 values, row-major), or null to clear it.")
    def set_homography(self, matrix: Matrix3x3 | None) -> HomographyResult:
        if matrix is None:
            self._homography = None
            return HomographyResult(cleared=True)
        self._homography = homography.to_matrix(matrix)
        return HomographyResult()

    @action("Pin the camera frame size the homography was computed for.")
    def set_frame_size(self, size: Size) -> SizeResult:
        self._frame_size = (size.width, size.height)
        return SizeResult(width=size.width, height=size.height)

    @action("Set the surface size warped landmarks are normalised over.")
    def set_surface_size(self, size: Size) -> SizeResult:
        self._surface_size = (size.width, size.height)
        return SizeResult(width=size.width, height=size.height)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self.stop_requested() or not isinstance(data, dict):
            return
        with self._detector_lock:
            detector = self._detector
        if detector is None:
            return
        frame = data.get("_frame")
        if frame is None:
            raise RuntimeError("hand_pose requires camera.frame payload with _frame")

        cam_h, cam_w = frame.shape[:2]
        start = time.perf_counter()
        cropped, x0 = flip_and_crop(frame, self._flip, self._window)
        img = contiguous(
            cv2.cvtColor(cropped, cv2.COLOR_BGR2RGBA if self._uses_rgba else cv2.COLOR_BGR2RGB)
        )
        image_format = mp.ImageFormat.SRGBA if self._uses_rgba else mp.ImageFormat.SRGB
        mp_image = mp.Image(image_format=image_format, data=img)
        capture_ts, frame_age_ms = capture_timing(data)
        self.record("frame_age_ms", frame_age_ms)

        # VIDEO mode requires strictly increasing timestamps (ms).
        ts_ms = max(self._last_ts_ms + 1, int(capture_ts))
        self._last_ts_ms = ts_ms
        with self._detector_lock:
            if self._detector is None or self.stop_requested():
                return
            try:
                result = detector.detect_for_video(mp_image, ts_ms)
            except Exception as exc:
                self._report_detect_failure(exc)
                return

        # MediaPipe normalises over the crop; move back to the full frame.
        crop_w = cropped.shape[1]
        hands = [
            np.array([[(x0 + lm.x * crop_w) / cam_w, lm.y] for lm in hand], dtype=np.float64)
            for hand in result.hand_landmarks
        ]
        hands_handedness = [
            (int(getattr(hand[0], "index", idx)), str(hand[0].category_name), float(hand[0].score))
            for idx, hand in enumerate(result.handedness)
            if hand
        ]

        # A hand with a landmark the surface homography sends to infinity is dropped.
        warped = self._warp(hands, cam_w, cam_h)
        kept = [i for i, hand in enumerate(warped) if np.isfinite(hand).all()]
        if len(kept) < len(warped):
            hands_handedness = [hands_handedness[i] for i in kept if i < len(hands_handedness)]

        elapsed_ms = (time.perf_counter() - start) * 1000.0
        self.record("inference_ms", elapsed_ms)
        self.emit(
            "raw_data",
            {
                "hands_landmarks": [warped[i].tolist() for i in kept],
                "hands_handedness": hands_handedness,
                "ts": now_ms(),
                "capture_ts": capture_ts,
                "inference_ms": elapsed_ms,
                "frame_age_ms": frame_age_ms,
                "latency_ms": latency_ms(capture_ts),
            },
        )

    def _report_detect_failure(self, exc: Exception) -> None:
        """Warn about failed detections at most every DETECT_WARNING_INTERVAL_S."""
        self._detect_failures += 1
        now = time.monotonic()
        if now - self._last_failure_warning < DETECT_WARNING_INTERVAL_S:
            return
        self.log("warn", f"hand_pose: detection failed {self._detect_failures} time(s): {exc!r}")
        self._detect_failures = 0
        self._last_failure_warning = now

    def _warp(self, hands: list[np.ndarray], cam_w: int, cam_h: int) -> list[np.ndarray]:
        """Warp normalised camera landmarks into normalised surface coordinates."""
        matrix = self._homography
        if matrix is None or not hands:
            return hands
        frame_w, frame_h = self._frame_size or (cam_w, cam_h)
        surface = np.array(self._surface_size, dtype=np.float64)
        return [
            homography.warp_points(matrix, hand * (frame_w, frame_h)) / surface
            if len(hand)
            else hand
            for hand in hands
        ]
