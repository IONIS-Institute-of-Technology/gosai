"""Hand-pose driver.

Subscribes to `camera.frame` and runs MediaPipe Hands on each frame. Emits a
`raw_data` event with normalized landmarks and handedness, matching the
schema of the legacy driver.

Payload:
```json
{
  "hands_landmarks": [[[x, y], ... 21]],   // normalized [0..1] over surface
  "hands_handedness": [[index, "Left"|"Right", score], ...]
}
```

By default, the landmarks emitted are normalised over the *camera* frame.
When a camera->surface homography is configured via ``set_homography``
(typically by the app on startup, using the matrix produced by the
``calibration`` driver), the driver instead emits landmarks normalised over
the **surface reference space** (canvas / projector display, by default
1920x1080). This is what apps need so hand positions line up with the
physical surface regardless of how the camera is angled.

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
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

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
    actions: ClassVar[tuple[str, ...]] = (
        "set_flip",
        "set_window",
        "set_homography",
        "set_frame_size",
        "set_surface_size",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "frame"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._detector_lock = threading.Lock()
        self._detector: Any = None
        self._mp_image_cls: Any = None
        self._mp_image_format: Any = None
        self._flip = False
        self._window = 1.0
        self._last_inference_ms = 0.0
        # Camera->surface homography (numpy 3x3, float64) and the dimensions
        # used to denormalise camera-frame landmarks before the warp and to
        # renormalise the warped points before emitting. ``None`` until set.
        self._homography: Any = None
        # Camera frame size used at calibration time. Falls back to the live
        # frame size when unset.
        self._frame_size: tuple[int, int] | None = None
        # Surface (output reference) size that landmarks are normalised to
        # when the homography is active.
        self._surface_size: tuple[int, int] = (1920, 1080)
        self._last_ts_ms = 0

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
            self.start_latest_worker()
        except Exception as exc:
            self.log("error", f"hand_pose: failed to create detector: {exc!r}")
            self._detector = None

    def cleanup(self) -> None:
        self.stop_latest_worker()
        super().cleanup()
        # Drop the detector without calling close(). MediaPipe's native
        # teardown can SIGSEGV when close races with in-flight inference or
        # camera callbacks; the bridge process exits shortly after anyway.
        with self._detector_lock:
            self._detector = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_flip":
            self._flip = bool(data)
            return {"flip": self._flip}
        if action == "set_window":
            self._window = max(min(float(data), 1.0), 0.05)
            return {"window": self._window}
        if action == "set_homography":
            return self._set_homography(data)
        if action == "set_frame_size":
            return self._set_frame_size(data)
        if action == "set_surface_size":
            return self._set_surface_size(data)
        return super().execute(action, data)

    def _set_homography(self, data: Any) -> dict[str, Any]:
        if data is None:
            self._homography = None
            return {"ok": True, "cleared": True}
        if not isinstance(data, list) or len(data) != 9:
            return {"ok": False, "error": "homography must be a length-9 list"}
        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"numpy required: {exc}"}
        try:
            self._homography = np.asarray(data, dtype=np.float64).reshape(3, 3)
        except (TypeError, ValueError) as exc:
            return {"ok": False, "error": f"invalid matrix: {exc}"}
        return {"ok": True}

    def _set_frame_size(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {"ok": False, "error": "frame_size must be { width, height }"}
        try:
            w = int(data["width"])
            h = int(data["height"])
        except (KeyError, TypeError, ValueError) as exc:
            return {"ok": False, "error": f"frame_size requires width/height: {exc}"}
        if w <= 0 or h <= 0:
            return {"ok": False, "error": "frame_size must be positive"}
        self._frame_size = (w, h)
        return {"ok": True, "width": w, "height": h}

    def _set_surface_size(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {"ok": False, "error": "surface_size must be { width, height }"}
        try:
            w = int(data["width"])
            h = int(data["height"])
        except (KeyError, TypeError, ValueError) as exc:
            return {"ok": False, "error": f"surface_size requires width/height: {exc}"}
        if w <= 0 or h <= 0:
            return {"ok": False, "error": "surface_size must be positive"}
        self._surface_size = (w, h)
        return {"ok": True, "width": w, "height": h}

    def on_data(self, driver: str, event: str, data: Any) -> None:
        self.queue_latest_data(driver, event, data)

    def process_latest_data(self, driver: str, event: str, data: Any) -> None:
        if self.stop_requested() or not isinstance(data, dict):
            return
        with self._detector_lock:
            detector = self._detector
        if detector is None:
            return
        frame = data.get("_frame")
        if frame is None:
            raise RuntimeError("hand_pose requires camera.frame payload with _frame")
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        # Preserve the *original* camera frame dimensions before any flip /
        # crop so the homography can correctly denormalise landmarks. The
        # configured ``_frame_size`` overrides this when the caller wants to
        # pin a specific resolution.
        cam_h, cam_w = frame.shape[:2]
        if self._frame_size is None:
            self._frame_size = (cam_w, cam_h)

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
            rgb = np.ascontiguousarray(rgb)

        mp_image = self._mp_image_cls(image_format=self._mp_image_format, data=rgb)
        capture_ts = data.get("capture_ts")
        capture_ts_f = float(capture_ts) if isinstance(capture_ts, int | float) else time.time()
        frame_age_ms = (time.time() - capture_ts_f) * 1000.0
        self.record("frame_age_ms", frame_age_ms)

        ts_ms = max(self._last_ts_ms + 1, int(capture_ts_f * 1000))
        self._last_ts_ms = ts_ms
        try:
            with self._detector_lock:
                if self._detector is None or self.stop_requested():
                    return
                result = detector.detect_for_video(mp_image, ts_ms)
        except Exception as exc:
            self.log("warn", f"hand_pose: detect failed: {exc!r}")
            return

        # Convert cropped-frame normalised landmarks (MediaPipe output) back
        # into ORIGINAL camera-frame normalised coordinates. The horizontal
        # window crop scales x by ``window`` and shifts by ``offset_x``.
        offset_x = (1.0 - self._window) / 2.0
        cam_hands: list[list[tuple[float, float]]] = []
        for hand in result.hand_landmarks:
            cam_hands.append([
                (float(lm.x) * self._window + offset_x, float(lm.y))
                for lm in hand
            ])

        # Optionally warp every landmark through the camera->surface
        # homography. Without a homography we keep the legacy behaviour and
        # emit camera-normalised coords.
        hands_landmarks = self._warp_hands(cam_hands, cam_w, cam_h)

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
                "capture_ts": capture_ts_f,
                "inference_ms": elapsed_ms,
                "frame_age_ms": frame_age_ms,
                "latency_ms": (time.time() - capture_ts_f) * 1000.0,
            },
        )

    def _warp_hands(
        self,
        cam_hands: list[list[tuple[float, float]]],
        cam_w: int,
        cam_h: int,
    ) -> list[list[list[float]]]:
        """Optionally apply the camera->surface homography to every landmark.

        - If no homography is set, returns landmarks unchanged (still
          normalised over the camera frame).
        - Otherwise: denormalise to camera pixels using ``_frame_size`` if
          configured (else the live frame size), apply the 3x3 perspective
          transform, and renormalise to ``_surface_size`` so consumers can
          continue treating values as 0..1 over their reference space.
        """
        if not cam_hands:
            return []
        if self._homography is None:
            return [[[x, y] for (x, y) in hand] for hand in cam_hands]
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("warn", f"hand_pose: numpy/cv2 unavailable, skipping warp: {exc}")
            return [[[x, y] for (x, y) in hand] for hand in cam_hands]

        fw, fh = self._frame_size if self._frame_size else (cam_w, cam_h)
        sw, sh = self._surface_size

        # Flatten to a single (N, 1, 2) array for cv2.perspectiveTransform,
        # then split back by hand at the end.
        sizes = [len(hand) for hand in cam_hands]
        flat_px: list[list[float]] = []
        for hand in cam_hands:
            for x, y in hand:
                flat_px.append([x * fw, y * fh])
        if not flat_px:
            return [[[x, y] for (x, y) in hand] for hand in cam_hands]

        arr = np.array(flat_px, dtype=np.float64).reshape(-1, 1, 2)
        try:
            warped = cv2.perspectiveTransform(arr, self._homography).reshape(-1, 2)
        except cv2.error as exc:
            self.log("warn", f"hand_pose: perspectiveTransform failed: {exc!r}")
            return [[[x, y] for (x, y) in hand] for hand in cam_hands]

        out: list[list[list[float]]] = []
        cursor = 0
        for n in sizes:
            hand_out: list[list[float]] = []
            for i in range(n):
                px = warped[cursor + i]
                hand_out.append([float(px[0]) / sw, float(px[1]) / sh])
            out.append(hand_out)
            cursor += n
        return out
