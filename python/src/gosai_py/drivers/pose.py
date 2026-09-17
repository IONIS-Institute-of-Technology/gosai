"""Body-pose driver.

Runs the MediaPipe Tasks `HolisticLandmarker` on `camera.frame` and emits face
mesh, body pose, hand landmarks and body world coordinates as `raw_data`. The
model bundle is downloaded once into `~/.gosai/models` and checked against its
sha256.

Hand keys are swapped relative to the model output: `right_hand_pose` holds
the model's left hand. The SLR models were trained on this layout and
`pose_to_mirror` anchors hands assuming it, so it is kept at the source.

With `face_mesh` off, `raw_data` sends an empty `face_mesh` to Node while
in-process subscribers still find the mesh under `_face_mesh`.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any, ClassVar

import cv2
import mediapipe as mp
import msgspec
from mediapipe.tasks.python import vision

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import clamp_window, contiguous, flip_and_crop
from gosai_py.payloads import FlipResult, WindowResult
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
    """Landmarks `[x_px, y_px, visibility]` in the full camera frame.
    `body_world_pose` rows are `[x_m, y_m, z_m, visibility]` from the hips."""

    face_mesh: list[list[float]]
    body_pose: list[list[float]]
    left_hand_pose: list[list[float]]
    right_hand_pose: list[list[float]]
    body_world_pose: list[list[float]]
    frame_width: float
    frame_height: float
    ts: float
    inference_ms: float


class FaceMeshResult(msgspec.Struct, kw_only=True):
    face_mesh: bool


def _visibility(landmark: Any) -> float:
    vis = getattr(landmark, "visibility", None)
    return round(float(vis), 2) if vis is not None else 1.0


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

        # VIDEO mode requires strictly increasing timestamps (ms).
        ts_ms = max(self._last_ts_ms + 1, int(time.perf_counter() * 1000))
        self._last_ts_ms = ts_ms
        start = time.perf_counter()
        result = self._landmarker.detect_for_video(mp_image, ts_ms)
        inference_ms = (time.perf_counter() - start) * 1000.0

        h_crop, w_crop = cropped.shape[:2]

        def to_xyv(landmarks: Any) -> list[list[float]]:
            return [
                [float(x0 + lm.x * w_crop), float(lm.y * h_crop), _visibility(lm)] for lm in landmarks
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
            "ts": time.time(),
            "inference_ms": inference_ms,
        }
        if not config.face_mesh:
            payload["_face_mesh"] = face_mesh
        self.record("inference_ms", inference_ms)
        self.emit("raw_data", payload)
