"""Hand-pose driver.

Subscribes to `camera.color` and runs MediaPipe Hands on each frame. Emits a
`raw_data` event with normalized landmarks and handedness, matching the
schema of the legacy driver.

Payload:
```json
{
  "hands_landmarks": [[[x, y], ... 21]],   // normalized [0..1]
  "hands_handedness": [[index, "Left"|"Right", score], ...]
}
```

Implementation notes
--------------------
MediaPipe 0.10+ on macOS arm64 ships only the new "Tasks" API; the legacy
`mp.solutions.hands` submodule is no longer included in the wheel. This
driver uses `mediapipe.tasks.vision.HandLandmarker` and lazily downloads the
`hand_landmarker.task` model file into `~/.gosai/models/` if it isn't
already cached.
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

HAND_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)
HAND_MODEL_FILENAME = "hand_landmarker.task"


def _gosai_home() -> Path:
    override = os.environ.get("GOSAI_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".gosai"


def _ensure_hand_model(log: Any) -> Path | None:
    """Return the path to the cached hand landmarker model, downloading it
    on first use. Returns ``None`` on failure."""
    target = _gosai_home() / "models" / HAND_MODEL_FILENAME
    if target.exists() and target.stat().st_size > 0:
        return target
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        log("info", f"hand_pose: downloading {HAND_MODEL_FILENAME} to {target}")
        tmp = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(HAND_MODEL_URL, timeout=30) as resp, tmp.open("wb") as fp:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                fp.write(chunk)
        tmp.replace(target)
        log("info", "hand_pose: model download complete")
        return target
    except Exception as exc:
        log("error", f"hand_pose: failed to download model: {exc!r}")
        return None


class HandPoseDriver(BaseProcessor):
    name: ClassVar[str] = "hand_pose"
    description: ClassVar[str] = "Hand landmark detection (MediaPipe Hands)."
    events: ClassVar[tuple[str, ...]] = ("raw_data",)
    actions: ClassVar[tuple[str, ...]] = ("set_flip", "set_window")
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._detector: Any = None
        self._mp_image_cls: Any = None
        self._mp_image_format: Any = None
        self._flip = False
        self._window = 1.0
        self._last_inference_ms = 0.0

    def pre_run(self) -> None:
        super().pre_run()
        try:
            import mediapipe as mp  # type: ignore[import-not-found]
            from mediapipe.tasks import python as mp_python  # type: ignore[import-not-found]
            from mediapipe.tasks.python import vision as mp_vision  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"mediapipe not available: {exc}")
            return

        model_path = _ensure_hand_model(self.log)
        if model_path is None:
            self.log("error", "hand_pose: model unavailable, driver inactive")
            return

        try:
            base_options = mp_python.BaseOptions(model_asset_path=str(model_path))
            options = mp_vision.HandLandmarkerOptions(
                base_options=base_options,
                num_hands=2,
                min_hand_detection_confidence=0.5,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
                running_mode=mp_vision.RunningMode.VIDEO,
            )
            self._detector = mp_vision.HandLandmarker.create_from_options(options)
            self._mp_image_cls = mp.Image
            self._mp_image_format = mp.ImageFormat.SRGB
            self.log("info", "MediaPipe HandLandmarker initialised")
        except Exception as exc:
            self.log("error", f"hand_pose: failed to create detector: {exc!r}")
            self._detector = None

    def cleanup(self) -> None:
        super().cleanup()
        if self._detector is not None:
            try:
                self._detector.close()
            except Exception as exc:
                self.log("warn", f"hand_pose: detector close failed: {exc!r}")
            self._detector = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_flip":
            self._flip = bool(data)
            return {"flip": self._flip}
        if action == "set_window":
            self._window = max(min(float(data), 1.0), 0.05)
            return {"window": self._window}
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._detector is None or not isinstance(data, dict):
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

        start = time.perf_counter()
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        if self._flip:
            rgb = cv2.flip(rgb, 1)

        # Window crop centred horizontally (legacy behaviour).
        if self._window < 1.0:
            w = rgb.shape[1]
            half = self._window / 2.0
            x0 = int((0.5 - half) * w)
            x1 = int((0.5 + half) * w)
            rgb = rgb[:, x0:x1]

        # MediaPipe Tasks needs a contiguous SRGB-format Image. The Tasks
        # `detect_for_video` API expects monotonically increasing timestamps
        # in milliseconds.
        if not rgb.flags["C_CONTIGUOUS"]:
            import numpy as np  # type: ignore[import-not-found]
            rgb = np.ascontiguousarray(rgb)

        mp_image = self._mp_image_cls(image_format=self._mp_image_format, data=rgb)
        ts_ms = int(time.time() * 1000)
        try:
            result = self._detector.detect_for_video(mp_image, ts_ms)
        except Exception as exc:
            self.log("warn", f"hand_pose: detect failed: {exc!r}")
            return

        offset = (1.0 - self._window) / 2.0
        hands_landmarks: list[list[list[float]]] = []
        for hand in result.hand_landmarks:
            hands_landmarks.append(
                [
                    [float(lm.x + offset), float(lm.y)]
                    for lm in hand
                ]
            )

        hands_handedness: list[list[Any]] = []
        for idx, hand in enumerate(result.handedness):
            if not hand:
                continue
            top = hand[0]
            hands_handedness.append(
                [
                    int(getattr(top, "index", idx)),
                    str(top.category_name),
                    float(top.score),
                ]
            )

        elapsed_ms = (time.perf_counter() - start) * 1000.0
        self._last_inference_ms = elapsed_ms
        self.record("inference_ms", elapsed_ms)

        self.emit(
            "raw_data",
            {
                "hands_landmarks": hands_landmarks,
                "hands_handedness": hands_handedness,
                "ts": time.time(),
                "inference_ms": elapsed_ms,
            },
        )
