"""Body-pose driver.

Runs the MediaPipe Tasks `HolisticLandmarker` on `camera.frame` and emits face
mesh, body pose, hand landmarks and body world coordinates as `raw_data`. The
model bundle is downloaded once into `~/.gosai/models` and checked against its
sha256.

Hand keys are swapped relative to the model output: `right_hand_pose` holds
the model's left hand. The SLR models were trained on this layout and
`pose_to_mirror` anchors hands assuming it, so it is kept at the source. The
in-process world-landmark keys follow the same swap.

With `face_mesh` off, `raw_data` sends an empty `face_mesh` to Node while
in-process subscribers still find the mesh under `_face_mesh`.

Underscore-prefixed keys stay in process, stripped before the payload reaches
Node. Besides `_face_mesh` they carry what the geometry pipeline needs and the
public payload cannot hold: `_face_xyz` (the mesh with its `z`) and
`_left_hand_world` / `_right_hand_world` (metric hand landmarks).
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Annotated, Any, ClassVar

import cv2
import mediapipe as mp
import msgspec
import numpy as np
from mediapipe.tasks.python import vision
from msgspec import Meta

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import capture_timing, clamp_window, contiguous, flip_and_crop, latency_ms
from gosai_py.payloads import CaptureMs, EpochMs, FlipResult, WindowResult
from gosai_py.runtime import RuntimeInfo, mediapipe_base_options
from gosai_py.runtime.models import Model, resolve_model

MODEL = Model.download(
    "holistic_landmarker.task",
    url=(
        "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/"
        "holistic_landmarker/float16/1/holistic_landmarker.task"
    ),
    sha256="e2dab61191e2dcd0a15f943d8e3ed1dce13c82dfa597b9dd39f562975a50c3f8",
)


class PoseConfig(msgspec.Struct, kw_only=True):
    flip: bool = False
    window: float = 1.0
    face_mesh: bool = True


class RawPosePayload(msgspec.Struct, kw_only=True):
    """Landmarks `[x_px, y_px, visibility]` in the full camera frame, mirrored when
    `flipped`. `body_world_pose` rows are `[x_m, y_m, z_m, visibility]` from the hips."""

    face_mesh: list[list[float]]
    body_pose: list[list[float]]
    left_hand_pose: list[list[float]]
    right_hand_pose: list[list[float]]
    body_world_pose: list[list[float]]
    frame_width: float
    frame_height: float
    flipped: Annotated[
        bool,
        Meta(description="Whether the landmarks sit in a horizontally flipped frame."),
    ]
    ts: EpochMs
    capture_ts: CaptureMs
    inference_ms: float
    frame_age_ms: float
    latency_ms: float


class FaceMeshResult(msgspec.Struct, kw_only=True):
    face_mesh: bool


def _visibility(landmark: Any) -> float:
    vis = getattr(landmark, "visibility", None)
    return round(float(vis), 2) if vis is not None else 1.0


def _face_xyz(landmarks: Any, x0: int, w_crop: int, h_crop: int) -> np.ndarray | None:
    """(N, 3) face mesh: `x` and `y` in full-frame pixels, `z` in the same pixels as `x`.

    MediaPipe's face `z` is normalised like its `x`, with the origin near the
    center of the head and smaller meaning closer to the camera, so the crop
    width converts it to the pixel scale the mesh's `x` already uses.
    """
    if not landmarks:
        return None
    return np.array(
        [[x0 + lm.x * w_crop, lm.y * h_crop, lm.z * w_crop] for lm in landmarks],
        dtype=np.float64,
    )


def _hand_world(result: Any, side: str) -> np.ndarray | None:
    """(21, 3) hand world landmarks in meters, or None when that hand is absent.

    The holistic bundle places them in the body's world frame, the same one as
    `body_world_pose`: row 0 is the wrist and equals the matching body world
    landmark. Only their differences within the hand are meaningful here.
    """
    landmarks = getattr(result, f"{side}_hand_world_landmarks", None)
    if not landmarks:
        return None
    return np.array([[lm.x, lm.y, lm.z] for lm in landmarks], dtype=np.float64)


class PoseDriver(BaseDriver):
    name = "pose"
    description = "Body, face and hand landmarks (MediaPipe Holistic Landmarker)."
    events: ClassVar[Mapping[str, Event]] = {
        "raw_data": Event(RawPosePayload, "Landmarks for the latest camera frame."),
    }
    stream_events = ("raw_data",)
    config_type = PoseConfig
    dependencies = ("camera",)
    subscribed = (("camera", "frame"),)
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._landmarker: Any = None
        self._uses_rgba = False
        self._config = PoseConfig()
        self._last_ts_ms = 0

    def configure(self, config: PoseConfig) -> None:
        self._config = msgspec.structs.replace(config, window=clamp_window(config.window))

    def pre_run(self) -> None:
        model_path = resolve_model(MODEL, self.log)

        def create(allow_gpu: bool) -> tuple[Any, RuntimeInfo]:
            base_options, info = mediapipe_base_options(
                mp.tasks.BaseOptions, model_path=model_path, allow_gpu=allow_gpu
            )
            options = vision.HolisticLandmarkerOptions(
                base_options=base_options, running_mode=vision.RunningMode.VIDEO
            )
            return vision.HolisticLandmarker.create_from_options(options), info

        try:
            self._landmarker, info = create(allow_gpu=True)
        except RuntimeError as exc:
            # The holistic bundle's quantized blendshapes graph cannot bind
            # Metal buffers, so the macOS GPU delegate fails at graph open.
            self.log("warn", f"pose: GPU delegate failed, retrying on CPU delegate: {exc!r}")
            self._landmarker, info = create(allow_gpu=False)
        self._uses_rgba = info.get("provider") == "GPUDelegate"
        self.set_runtime_info(info)
        self.log("info", "MediaPipe Holistic Landmarker initialized")

    def cleanup(self) -> None:
        if self._landmarker is not None:
            try:
                self._landmarker.close()
            except Exception as exc:
                self.log("warn", f"holistic.close failed: {exc!r}")
            self._landmarker = None

    @action("Mirror frames horizontally before detection.")
    def set_flip(self, flip: bool) -> FlipResult:
        self._config = msgspec.structs.replace(self._config, flip=flip)
        return FlipResult(flip=flip)

    @action("Detect only in a centered horizontal fraction of the frame (0.05 to 1).")
    def set_window(self, window: float) -> WindowResult:
        self._config = msgspec.structs.replace(self._config, window=clamp_window(window))
        return WindowResult(window=self._config.window)

    @action("Send the face mesh to Node (in-process subscribers always get it).")
    def set_face_mesh(self, enabled: bool) -> FaceMeshResult:
        self._config = msgspec.structs.replace(self._config, face_mesh=enabled)
        return FaceMeshResult(face_mesh=enabled)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._landmarker is None or not isinstance(data, dict):
            return
        frame = data.get("_frame")
        if frame is None:
            raise RuntimeError("pose requires camera.frame payload with _frame")
        config = self._config
        cropped, x0 = flip_and_crop(frame, config.flip, config.window)
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
        start = time.perf_counter()
        result = self._landmarker.detect_for_video(mp_image, ts_ms)
        inference_ms = (time.perf_counter() - start) * 1000.0

        h_crop, w_crop = cropped.shape[:2]

        def to_xyv(landmarks: Any) -> list[list[float]]:
            return [
                [float(x0 + lm.x * w_crop), float(lm.y * h_crop), _visibility(lm)]
                for lm in landmarks
            ]

        face_mesh = to_xyv(result.face_landmarks)
        payload: dict[str, Any] = {
            "face_mesh": face_mesh if config.face_mesh else [],
            "body_pose": to_xyv(result.pose_landmarks),
            "left_hand_pose": to_xyv(result.right_hand_landmarks),
            "right_hand_pose": to_xyv(result.left_hand_landmarks),
            "body_world_pose": [
                [float(lm.x), float(lm.y), float(lm.z), _visibility(lm)]
                for lm in result.pose_world_landmarks
            ],
            "frame_width": float(frame.shape[1]),
            "frame_height": float(frame.shape[0]),
            "flipped": config.flip,
            "ts": now_ms(),
            "capture_ts": capture_ts,
            "inference_ms": inference_ms,
            "frame_age_ms": frame_age_ms,
            "latency_ms": latency_ms(capture_ts),
            # The face mesh with its depth, and the hands in meters, for geometry.
            "_face_xyz": _face_xyz(result.face_landmarks, x0, w_crop, h_crop),
            "_left_hand_world": _hand_world(result, "right"),
            "_right_hand_world": _hand_world(result, "left"),
        }
        if not config.face_mesh:
            payload["_face_mesh"] = face_mesh
        self.record("inference_ms", inference_ms)
        self.emit("raw_data", payload)
