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
import os
import platform
import re
import time
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.serialization import frame_to_jpeg_base64

# Common modes to probe; actual hardware may only support a subset.
_PROBE_RESOLUTIONS: tuple[tuple[int, int], ...] = (
    (640, 480),
    (800, 600),
    (1024, 768),
    (1280, 720),
    (1280, 960),
    (1920, 1080),
    (2560, 1440),
    (3840, 2160),
)
_PROBE_FPS: tuple[int, ...] = (5, 10, 15, 24, 25, 30, 60)
# When the driver cannot read discrete FPS modes, these targets are still valid
# because the capture loop software-throttles to `_fps_target`.
_SOFTWARE_FPS: tuple[int, ...] = (15, 24, 30, 60)


def _video_node_number(entry: str) -> int:
    """Sort key for `/sys/class/video4linux` entries (video10 after video2)."""
    match = re.fullmatch(r"video(\d+)", entry)
    return int(match.group(1)) if match else 1_000_000


class CameraDriver(BaseDriver):
    name: ClassVar[str] = "camera"
    description: ClassVar[str] = "Webcam capture (OpenCV) with optional RealSense depth."
    events: ClassVar[tuple[str, ...]] = ("color", "depth", "frame_size", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_device",
        "set_resolution",
        "set_fps",
        "snapshot",
        "list_formats",
    )
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

    def apply_config(self, cfg: dict[str, Any]) -> None:
        """Apply persisted settings before the capture loop opens the device."""
        if "device" in cfg:
            self._device = int(cfg["device"])
        if "width" in cfg:
            self._width = int(cfg["width"])
        if "height" in cfg:
            self._height = int(cfg["height"])
        if "fps" in cfg:
            self._fps_target = float(cfg["fps"])

    @classmethod
    def probe_devices(cls, max_index: int = 8) -> list[dict[str, Any]]:
        """Enumerate connected cameras with human-readable names.

        Prefers fast, native enumeration that yields real device names without
        opening each camera (macOS `system_profiler`, Linux sysfs). Opening a
        device with OpenCV costs ~1s each on macOS, so the per-index open-probe
        is only a last-resort fallback. Returned indices match what
        `cv2.VideoCapture(index)` opens on that platform.
        """
        system = platform.system()
        with contextlib.suppress(Exception):
            if system == "Darwin":
                devices = cls._probe_devices_macos()
                if devices:
                    return devices
            elif system == "Linux":
                devices = cls._probe_devices_linux()
                if devices:
                    return devices
        return cls._probe_devices_opencv(max_index)

    @staticmethod
    def _probe_devices_macos() -> list[dict[str, Any]]:
        """Camera names via `system_profiler` (~0.3s, no device opening).

        OpenCV's AVFoundation backend sorts capture devices by `uniqueID`, so we
        apply the same ordering to keep our index aligned with
        `cv2.VideoCapture(index)`.
        """
        import json
        import subprocess

        out = subprocess.check_output(
            ["system_profiler", "-json", "-detailLevel", "full", "SPCameraDataType"],
            timeout=10,
            stderr=subprocess.DEVNULL,
        )
        cams = json.loads(out).get("SPCameraDataType", [])
        cams = sorted(cams, key=lambda c: str(c.get("spcamera_unique-id", "")))
        return [
            {"index": idx, "label": cam.get("_name") or f"Camera {idx}"}
            for idx, cam in enumerate(cams)
        ]

    @staticmethod
    def _probe_devices_linux() -> list[dict[str, Any]]:
        """Camera names via V4L2 sysfs. Skips secondary nodes (metadata) by only
        keeping each device's primary capture node (sysfs `index` == 0)."""
        base = "/sys/class/video4linux"
        if not os.path.isdir(base):
            return []
        devices: list[dict[str, Any]] = []
        for entry in sorted(os.listdir(base), key=_video_node_number):
            match = re.fullmatch(r"video(\d+)", entry)
            if not match:
                continue
            node = int(match.group(1))
            dpath = os.path.join(base, entry)
            with contextlib.suppress(OSError), open(os.path.join(dpath, "index")) as fh:
                if fh.read().strip() != "0":
                    continue
            name = f"Camera {node}"
            with contextlib.suppress(OSError), open(os.path.join(dpath, "name")) as fh:
                name = fh.read().strip() or name
            devices.append({"index": node, "label": name})
        return devices

    @classmethod
    def _probe_devices_opencv(cls, max_index: int) -> list[dict[str, Any]]:
        """Last-resort probe: open each index until two consecutive misses.

        Slow (each open can take ~1s) and yields only generic labels, so this
        only runs when native enumeration is unavailable.
        """
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError:
            return []
        devices: list[dict[str, Any]] = []
        misses = 0
        for idx in range(max_index):
            cap = cv2.VideoCapture(idx)
            opened = bool(cap.isOpened())
            with contextlib.suppress(Exception):
                cap.release()
            if opened:
                devices.append({"index": idx, "label": f"Camera {idx}"})
                misses = 0
            else:
                misses += 1
                if misses >= 2 and idx > 0:
                    break
        return devices

    @classmethod
    def probe_formats(cls, device: int = 0) -> dict[str, Any]:
        """Enumerate resolutions and frame rates supported by `device`."""
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "device": device, "error": f"opencv not available: {exc}"}

        cap = cv2.VideoCapture(device)
        if not cap.isOpened():
            return {"ok": False, "device": device, "error": f"cannot open camera device {device}"}

        try:
            seen: set[tuple[int, int]] = set()
            for target_w, target_h in _PROBE_RESOLUTIONS:
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, target_w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, target_h)
                actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                if actual_w <= 0 or actual_h <= 0:
                    continue
                # Accept exact matches or drivers that snap to the nearest mode.
                if abs(actual_w - target_w) <= 16 and abs(actual_h - target_h) <= 16:
                    seen.add((actual_w, actual_h))

            if not seen:
                return {"ok": False, "device": device, "error": "no supported resolutions detected"}

            formats: list[dict[str, Any]] = []
            for width, height in sorted(seen, key=lambda wh: wh[0] * wh[1], reverse=True):
                fps_values = cls._probe_fps_for_resolution(cap, cv2, width, height)
                formats.append({"width": width, "height": height, "fps": fps_values})

            return {"ok": True, "device": device, "formats": formats}
        finally:
            with contextlib.suppress(Exception):
                cap.release()

    @classmethod
    def _probe_fps_for_resolution(
        cls, cap: Any, cv2: Any, width: int, height: int
    ) -> list[int]:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        reported_max = float(cap.get(cv2.CAP_PROP_FPS))

        matched: list[int] = []
        for target in _PROBE_FPS:
            cap.set(cv2.CAP_PROP_FPS, float(target))
            actual = float(cap.get(cv2.CAP_PROP_FPS))
            if actual <= 0:
                continue
            if abs(actual - target) <= 1.5:
                matched.append(int(round(actual)))

        if matched:
            return sorted(set(matched))

        # Many UVC devices do not expose discrete FPS modes; software throttling still works.
        if reported_max > 1:
            return sorted({f for f in _SOFTWARE_FPS if f <= int(reported_max + 0.5)})
        return list(_SOFTWARE_FPS)

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
        self.log(
            "info",
            f"camera open: device={self._device} {actual_w}x{actual_h} target_fps={self._fps_target}",
        )
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
        if action == "list_formats":
            device = self._device
            if isinstance(data, dict) and "device" in data:
                device = int(data["device"])
            return self.probe_formats(device)

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
