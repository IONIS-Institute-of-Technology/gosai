"""Camera driver.

Captures frames from a connected camera using OpenCV. Publishes:
- `color`: { width, height, jpeg_base64 } at the configured FPS.
- `frame_size`: { width, height } when capture starts or resolution changes.

Optional Intel RealSense support is gated behind the `pyrealsense2` import.

Configurable via class attributes on subclasses or via the legacy
`get_data`/`execute` interface (set_device, set_resolution, set_fps).
"""

from __future__ import annotations

import contextlib
import time
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.serialization import frame_to_jpeg_base64


class CameraDriver(BaseDriver):
    name: ClassVar[str] = "camera"
    description: ClassVar[str] = "Webcam capture (OpenCV) with optional RealSense depth."
    events: ClassVar[tuple[str, ...]] = ("color", "depth", "frame_size", "fps")
    actions: ClassVar[tuple[str, ...]] = ("set_device", "set_resolution", "set_fps", "snapshot")
    loop_interval_s: ClassVar[float | None] = 0.0

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device = 0
        self._width = 1280
        self._height = 720
        self._fps_target = 30.0
        self._jpeg_quality = 60
        self._cap: Any = None  # cv2.VideoCapture instance
        self._last_emit = 0.0
        self._frame_count = 0
        self._fps_window_start = 0.0

    def pre_run(self) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv not available: {exc}")
            return
        self._open(cv2)

    def _open(self, cv2: Any) -> None:
        if self._cap is not None:
            with contextlib.suppress(Exception):
                self._cap.release()
        cap = cv2.VideoCapture(self._device)
        if not cap.isOpened():
            self.log("error", f"cannot open camera device {self._device}")
            self._cap = None
            return
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        cap.set(cv2.CAP_PROP_FPS, self._fps_target)
        actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self._cap = cap
        self.log("info", f"camera open: device={self._device} {actual_w}x{actual_h} target_fps={self._fps_target}")
        self.emit("frame_size", {"width": actual_w, "height": actual_h})

    def loop(self) -> None:
        if self._cap is None:
            time.sleep(0.5)
            return
        ok, frame = self._cap.read()
        if not ok or frame is None:
            time.sleep(0.01)
            return
        try:
            encoded = frame_to_jpeg_base64(frame, quality=self._jpeg_quality)
        except Exception as exc:
            self.log("error", f"frame encode failed: {exc!r}")
            return
        h, w = frame.shape[:2]
        self.emit(
            "color",
            {"width": int(w), "height": int(h), "jpeg_base64": encoded, "ts": time.time()},
        )

        # FPS tracking
        now = time.time()
        if self._fps_window_start == 0.0:
            self._fps_window_start = now
        self._frame_count += 1
        if now - self._fps_window_start >= 1.0:
            fps = self._frame_count / (now - self._fps_window_start)
            self.emit("fps", {"fps": round(fps, 1)})
            self._frame_count = 0
            self._fps_window_start = now

        # Cap effective rate to roughly fps_target by sleeping a bit.
        if self._fps_target > 0:
            target_interval = 1.0 / self._fps_target
            elapsed = time.perf_counter() - self._last_emit
            remaining = target_interval - elapsed
            if remaining > 0:
                time.sleep(remaining)
            self._last_emit = time.perf_counter()

    def execute(self, action: str, data: Any) -> Any:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError:
            cv2 = None

        if action == "set_device":
            self._device = int(data)
            if cv2 is not None:
                self._open(cv2)
            return {"device": self._device}
        if action == "set_resolution":
            self._width = int(data.get("width", self._width))
            self._height = int(data.get("height", self._height))
            if cv2 is not None:
                self._open(cv2)
            return {"width": self._width, "height": self._height}
        if action == "set_fps":
            self._fps_target = float(data)
            if cv2 is not None and self._cap is not None:
                self._cap.set(cv2.CAP_PROP_FPS, self._fps_target)
            return {"fps": self._fps_target}
        if action == "snapshot":
            return self.get_event_data("color")
        return super().execute(action, data)

    def cleanup(self) -> None:
        if self._cap is not None:
            with contextlib.suppress(Exception):
                self._cap.release()
            self._cap = None
        self.log("info", "camera released")
