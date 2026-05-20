"""Ball/object detector via background subtraction.

A faithful re-implementation of the legacy `ball` driver. Differences:

- Background image is provided either as a base64 JPEG (passed through
  `set_background`) or pulled from the GOSAI calibration app's storage by
  the application that starts this driver.
- The homography matrix used to warp the camera into display space is also
  supplied per-action; the driver no longer reads `home/calibration_data.json`.

Events:
- `balls`: list of `{x, y}` positions in display pixels.
- `fps`: rolling FPS estimate over the most recent 50 frames.

Actions:
- `set_background(jpeg_base64)`
- `set_homography(matrix9)`  // row-major 3x3 flattened
- `set_output_size({ width, height })`
- `set_min_area(px)` / `set_threshold(value)`
"""

from __future__ import annotations

import base64
import time
from collections import deque
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor


class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "Background-subtraction ball detector."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_background",
        "set_homography",
        "set_output_size",
        "set_min_area",
        "set_threshold",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
    loop_interval_s: ClassVar[float | None] = None

    DEFAULT_OUTPUT_SIZE: ClassVar[tuple[int, int]] = (1920, 1080)

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._bkg: Any = None  # ndarray
        self._homography: Any = None  # ndarray (3,3)
        self._output_size = self.DEFAULT_OUTPUT_SIZE
        self._min_area = 700.0  # pixels^2
        self._threshold = 100  # binary threshold after blur
        self._frame_times: deque[float] = deque(maxlen=50)

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_background":
            return self._set_background(data)
        if action == "set_homography":
            return self._set_homography(data)
        if action == "set_output_size":
            return self._set_output_size(data)
        if action == "set_min_area":
            self._min_area = float(data)
            return {"min_area": self._min_area}
        if action == "set_threshold":
            self._threshold = int(data)
            return {"threshold": self._threshold}
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return
        if self._bkg is None or self._homography is None:
            return
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv/numpy required: {exc}")
            return

        raw = base64.b64decode(encoded)
        arr = np.frombuffer(raw, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        start = time.perf_counter()
        bkg = self._bkg
        if bkg.shape != frame.shape:
            bkg = cv2.resize(bkg, (frame.shape[1], frame.shape[0]))
            self._bkg = bkg

        diff = cv2.absdiff(bkg, frame)
        # Use the blue channel for projection (matches legacy behaviour) then
        # warp into display coordinates using the homography.
        blue = diff[..., -1]
        warped = cv2.warpPerspective(
            blue, self._homography, self._output_size, flags=cv2.INTER_LINEAR
        )
        warped = cv2.GaussianBlur(warped, (5, 5), 0)
        _, mask = cv2.threshold(warped, self._threshold, 255, cv2.THRESH_BINARY)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        balls: list[dict[str, int]] = []
        for contour in contours:
            m = cv2.moments(contour)
            if m["m00"] < self._min_area:
                continue
            cx = int(m["m10"] / m["m00"])
            cy = int(m["m01"] / m["m00"])
            balls.append({"x": cx, "y": cy})

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

    def _set_background(self, data: Any) -> dict[str, Any]:
        try:
            import cv2  # type: ignore[import-not-found]
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"opencv/numpy required: {exc}"}
        if not isinstance(data, str):
            return {"ok": False, "error": "background must be a base64 jpeg string"}
        raw = base64.b64decode(data)
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return {"ok": False, "error": "failed to decode background"}
        self._bkg = img
        return {"ok": True, "width": int(img.shape[1]), "height": int(img.shape[0])}

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
