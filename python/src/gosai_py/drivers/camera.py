"""Camera driver.

Captures frames from a connected camera using OpenCV. Publishes:
- `frame`: { width, height, _frame } in-process at the configured FPS.
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
import threading
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
_PROBE_FPS: tuple[int, ...] = (24, 25, 30, 60)
# When the driver cannot read discrete FPS modes, these targets are still valid
# because the capture loop software-throttles to `_fps_target`.
_SOFTWARE_FPS: tuple[int, ...] = (24, 30, 60)
_FPS_TOLERANCE = 1.5
_FRAME_READ_ATTEMPTS = 5
_FORMAT_CACHE_TTL_S = 10.0
_FORMAT_CACHE: dict[int, tuple[float, dict[str, Any]]] = {}


def _codec_candidates() -> tuple[str | None, ...]:
    system = platform.system()
    if system == "Linux":
        return ("MJPG", "H264", "YUYV", None)
    if system == "Windows":
        return ("MJPG", "H264", None)
    return (None,)


def _set_codec(cap: Any, cv2: Any, codec: str | None) -> None:
    """Request a camera pixel format/codec before setting size/FPS."""
    if codec is None:
        return
    with contextlib.suppress(Exception):
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*codec))


def _codec_label(codec: str | None) -> str:
    return codec or "native"


def _reported_codec(cap: Any, cv2: Any, requested: str | None) -> str:
    with contextlib.suppress(Exception):
        raw = int(cap.get(cv2.CAP_PROP_FOURCC))
        if raw > 0:
            chars = "".join(chr((raw >> (8 * i)) & 0xFF) for i in range(4))
            if chars.strip("\x00 "):
                return chars
    return _codec_label(requested)


def _fps_supported(reported: float, target: float) -> bool:
    return reported <= 1 or reported + _FPS_TOLERANCE >= target


def _fps_options(reported: float) -> list[int]:
    if reported > 1:
        return sorted({fps for fps in _SOFTWARE_FPS if fps <= int(reported + _FPS_TOLERANCE)})
    return list(_SOFTWARE_FPS)


def _format_probe_results(formats: dict[tuple[int, int], dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for entry in formats.values():
        fps_values = sorted(entry["fps"])
        if not fps_values:
            continue
        result.append(
            {
                "width": entry["width"],
                "height": entry["height"],
                "fps": fps_values,
                "codecs": sorted(entry["codecs"]),
            }
        )
    result.sort(key=lambda f: (f["width"] * f["height"], max(f["fps"], default=0)), reverse=True)
    return result


def _require_video_capture(cv2: Any) -> None:
    if not hasattr(cv2, "VideoCapture"):
        location = getattr(cv2, "__file__", None) or getattr(cv2, "__path__", "unknown")
        raise RuntimeError(
            "OpenCV imported without VideoCapture support. "
            f"Resolved cv2 from {location!r}; run `uv sync --reinstall-package opencv-contrib-python` "
            "inside python/ to restore the OpenCV binary wheel."
        )


def _video_node_number(entry: str) -> int:
    """Sort key for `/sys/class/video4linux` entries (video10 after video2)."""
    match = re.fullmatch(r"video(\d+)", entry)
    return int(match.group(1)) if match else 1_000_000


class CameraDriver(BaseDriver):
    name: ClassVar[str] = "camera"
    description: ClassVar[str] = "Webcam capture (OpenCV) with optional RealSense depth."
    events: ClassVar[tuple[str, ...]] = ("frame", "color", "depth", "frame_size", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_device",
        "set_mode",
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
        self._latest_lock = threading.Lock()
        self._latest_frame: Any = None
        self._latest_meta: dict[str, Any] | None = None
        self._latest_frame_id = 0
        self._published_frame_id = 0
        self._capture_thread: threading.Thread | None = None
        self._capture_stop = threading.Event()
        self._capture_codec = "native"

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
        try:
            _require_video_capture(cv2)
        except RuntimeError:
            return []
        devices: list[dict[str, Any]] = []
        misses = 0
        for idx in range(max_index):
            cap = _open_capture(cv2, idx)
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
        """Enumerate exact resolution/FPS combinations this runtime can read.

        The selector should only show modes that OpenCV can actually negotiate
        and decode. Many UVC cameras expose 720p+ only through MJPG/H264, so the
        probe tries those codecs explicitly and verifies a decoded frame shape
        instead of trusting capability lists. Results are cached briefly because
        the dashboard may ask from both global and per-app selectors.
        """
        now = time.monotonic()
        cached = _FORMAT_CACHE.get(device)
        if cached is not None and now - cached[0] < _FORMAT_CACHE_TTL_S:
            return dict(cached[1])

        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "device": device, "error": f"opencv not available: {exc}"}
        try:
            _require_video_capture(cv2)
        except RuntimeError as exc:
            return {"ok": False, "device": device, "error": str(exc)}

        formats: dict[tuple[int, int], dict[str, Any]] = {}
        errors: list[str] = []
        for codec in _codec_candidates():
            cap = _open_capture(cv2, device)
            if not cap.isOpened():
                errors.append(f"{_codec_label(codec)}: cannot open device")
                continue
            try:
                _request_low_latency(cap, cv2)
                _set_codec(cap, cv2, codec)
                for target_w, target_h in _PROBE_RESOLUTIONS:
                    ok, info = _configure_existing_capture(
                        cap,
                        cv2,
                        width=target_w,
                        height=target_h,
                        fps=30.0,
                        codec=codec,
                        require_fps=False,
                    )
                    if not ok:
                        continue
                    key = (info["width"], info["height"])
                    entry = formats.setdefault(
                        key,
                        {"width": info["width"], "height": info["height"], "fps": set(), "codecs": set()},
                    )
                    for fps in _fps_options(float(info["fps"])):
                        entry["fps"].add(fps)
                    entry["codecs"].add(info["codec"])
            finally:
                with contextlib.suppress(Exception):
                    cap.release()

        if not formats:
            error = "no exact camera modes detected"
            if errors:
                error = f"{error}: {'; '.join(errors)}"
            result_error = {"ok": False, "device": device, "error": error}
            _FORMAT_CACHE[device] = (now, result_error)
            return dict(result_error)

        result = _format_probe_results(formats)
        if not result:
            result_error = {
                "ok": False,
                "device": device,
                "error": "no camera modes at 24 fps or higher detected",
            }
            _FORMAT_CACHE[device] = (now, result_error)
            return dict(result_error)
        payload = {"ok": True, "device": device, "formats": result}
        _FORMAT_CACHE[device] = (now, payload)
        return dict(payload)

    def pre_run(self) -> None:
        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(f"opencv not available: {exc}") from exc
        _require_video_capture(cv2)
        self._open(cv2)

    def _open(self, cv2: Any) -> None:
        _FORMAT_CACHE.pop(self._device, None)
        errors: list[str] = []
        selected_cap: Any = None
        selected_info: dict[str, Any] | None = None
        for codec in _codec_candidates():
            cap = _open_capture(cv2, self._device)
            if not cap.isOpened():
                errors.append(f"{_codec_label(codec)}: cannot open device")
                continue
            _request_low_latency(cap, cv2)
            ok, info = _configure_existing_capture(
                cap,
                cv2,
                width=self._width,
                height=self._height,
                fps=self._fps_target,
                codec=codec,
            )
            if ok:
                selected_cap = cap
                selected_info = info
                break
            errors.append(f"{_codec_label(codec)}: rejected")
            with contextlib.suppress(Exception):
                cap.release()

        if selected_cap is None or selected_info is None:
            msg = (
                f"cannot open exact camera mode device={self._device} "
                f"{self._width}x{self._height}@{self._fps_target:g}fps"
            )
            if errors:
                msg = f"{msg} ({'; '.join(errors)})"
            raise RuntimeError(msg)

        self._stop_capture_worker()
        old_cap = self._cap
        self._cap = selected_cap
        self._capture_codec = str(selected_info["codec"])
        with contextlib.suppress(Exception):
            if old_cap is not None:
                old_cap.release()
        with self._latest_lock:
            self._latest_frame = None
            self._latest_meta = None
            self._latest_frame_id = 0
            self._published_frame_id = 0

        self.set_runtime_info(
            {
                "backend": "opencv",
                "provider": self._capture_codec,
                "device": f"camera:{self._device}",
                "model": f"{self._width}x{self._height}@{self._fps_target:g}",
                "accelerated": False,
                "reason": "camera capture codec",
            }
        )
        self._start_capture_worker()
        self.log(
            "info",
            "camera open: "
            f"device={self._device} {selected_info['width']}x{selected_info['height']} "
            f"target_fps={self._fps_target:g} codec={self._capture_codec}",
        )
        self.emit(
            "frame_size",
            {
                "width": selected_info["width"],
                "height": selected_info["height"],
                "fps": self._fps_target,
                "codec": self._capture_codec,
            },
        )

    def _start_capture_worker(self) -> None:
        self._capture_stop.clear()
        self._capture_thread = threading.Thread(
            target=self._capture_loop,
            name=f"camera:{self._device}:capture",
            daemon=True,
        )
        self._capture_thread.start()

    def _stop_capture_worker(self, timeout: float = 2.0) -> None:
        worker = self._capture_thread
        if worker is None:
            return
        self._capture_stop.set()
        worker.join(timeout)
        if worker.is_alive():
            self.log("warn", "camera capture worker did not stop before timeout")
        self._capture_thread = None

    def _capture_loop(self) -> None:
        while not self._capture_stop.is_set() and not self.stop_requested():
            cap = self._cap
            if cap is None:
                self._capture_stop.wait(0.05)
                continue
            ok, frame = cap.read()
            if not ok or frame is None:
                self._capture_stop.wait(0.005)
                continue
            h, w = frame.shape[:2]
            capture_ts = time.time()
            perf_ts = time.perf_counter()
            meta = {
                "width": int(w),
                "height": int(h),
                "ts": capture_ts,
                "capture_ts": capture_ts,
                "capture_perf": perf_ts,
                "codec": self._capture_codec,
            }
            with self._latest_lock:
                self._latest_frame = frame
                self._latest_meta = meta
                self._latest_frame_id += 1

    def loop(self) -> None:
        with self._latest_lock:
            if (
                self._latest_frame is None
                or self._latest_meta is None
                or self._latest_frame_id == self._published_frame_id
            ):
                frame = None
                meta = None
            else:
                frame = self._latest_frame
                meta = dict(self._latest_meta)
                self._published_frame_id = self._latest_frame_id
        if frame is None or meta is None:
            time.sleep(0.002)
            return

        if self._context.has_subscribers("frame"):
            self.emit("frame", {**meta, "_frame": frame})

        if self._context.has_subscribers("color"):
            try:
                encode_start = time.perf_counter()
                encoded = frame_to_jpeg_base64(frame, quality=self._jpeg_quality)
                encode_ms = (time.perf_counter() - encode_start) * 1000.0
            except Exception as exc:
                self.log("error", f"frame encode failed: {exc!r}")
                return
            self.record("jpeg_encode_ms", encode_ms)
            self.emit(
                "color",
                {
                    **meta,
                    "jpeg_base64": encoded,
                    "encode_ms": encode_ms,
                },
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
            _require_video_capture(cv2)
        except ImportError:
            cv2 = None
        except RuntimeError as exc:
            if action == "snapshot":
                raise
            raise RuntimeError(str(exc)) from exc

        if action == "set_device":
            old = (self._device, self._width, self._height, self._fps_target)
            self._device = int(data)
            if cv2 is not None:
                try:
                    self._open(cv2)
                    self.publish_state("running")
                except Exception:
                    self._device, self._width, self._height, self._fps_target = old
                    raise
            return {"device": self._device}
        if action == "set_resolution":
            old = (self._device, self._width, self._height, self._fps_target)
            self._width = int(data.get("width", self._width))
            self._height = int(data.get("height", self._height))
            if cv2 is not None:
                try:
                    self._open(cv2)
                    self.publish_state("running")
                except Exception:
                    self._device, self._width, self._height, self._fps_target = old
                    raise
            return {"width": self._width, "height": self._height}
        if action == "set_fps":
            old = (self._device, self._width, self._height, self._fps_target)
            self._fps_target = float(data)
            if cv2 is not None:
                try:
                    self._open(cv2)
                    self.publish_state("running")
                except Exception:
                    self._device, self._width, self._height, self._fps_target = old
                    raise
            return {"fps": self._fps_target}
        if action == "set_mode":
            old = (self._device, self._width, self._height, self._fps_target)
            if isinstance(data, dict):
                self._device = int(data.get("device", self._device))
                self._width = int(data.get("width", self._width))
                self._height = int(data.get("height", self._height))
                self._fps_target = float(data.get("fps", self._fps_target))
            if cv2 is not None:
                try:
                    self._open(cv2)
                    self.publish_state("running")
                except Exception:
                    self._device, self._width, self._height, self._fps_target = old
                    raise
            return {
                "device": self._device,
                "width": self._width,
                "height": self._height,
                "fps": self._fps_target,
                "codec": self._capture_codec,
            }
        if action == "snapshot":
            return self._snapshot()
        return super().execute(action, data)

    def _snapshot(self) -> dict[str, Any] | None:
        data = self.get_event_data("color")
        if isinstance(data, dict) and isinstance(data.get("jpeg_base64"), str):
            return data
        with self._latest_lock:
            frame = None if self._latest_frame is None else self._latest_frame.copy()
            meta = dict(self._latest_meta) if self._latest_meta is not None else None
        if frame is None or meta is None:
            return None
        encode_start = time.perf_counter()
        encoded = frame_to_jpeg_base64(frame, quality=self._jpeg_quality)
        encode_ms = (time.perf_counter() - encode_start) * 1000.0
        return {**meta, "jpeg_base64": encoded, "encode_ms": encode_ms}

    def cleanup(self) -> None:
        self._stop_capture_worker()
        if self._cap is not None:
            with contextlib.suppress(Exception):
                self._cap.release()
            self._cap = None
        self.log("info", "camera released")


def _open_capture(cv2: Any, device: int) -> Any:
    if platform.system() == "Linux" and hasattr(cv2, "CAP_V4L2"):
        return cv2.VideoCapture(device, cv2.CAP_V4L2)
    return cv2.VideoCapture(device)


def _request_low_latency(cap: Any, cv2: Any) -> None:
    with contextlib.suppress(Exception):
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)


def _configure_existing_capture(
    cap: Any,
    cv2: Any,
    *,
    width: int,
    height: int,
    fps: float,
    codec: str | None,
    require_fps: bool = True,
) -> tuple[bool, dict[str, Any]]:
    """Configure and verify an already-open capture object.

    A mode is accepted only when a decoded frame comes back at the requested
    resolution and the camera does not report a lower FPS than requested.
    """
    _set_codec(cap, cv2, codec)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(width))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(height))
    cap.set(cv2.CAP_PROP_FPS, float(fps))

    frame = None
    for _ in range(_FRAME_READ_ATTEMPTS):
        ok, candidate = cap.read()
        if ok and candidate is not None:
            frame = candidate
            break
        time.sleep(0.01)
    if frame is None:
        return False, {}

    actual_h, actual_w = frame.shape[:2]
    reported_fps = float(cap.get(cv2.CAP_PROP_FPS))
    if int(actual_w) != int(width) or int(actual_h) != int(height):
        return False, {
            "width": int(actual_w),
            "height": int(actual_h),
            "fps": reported_fps,
            "codec": _reported_codec(cap, cv2, codec),
        }
    if require_fps and not _fps_supported(reported_fps, float(fps)):
        return False, {
            "width": int(actual_w),
            "height": int(actual_h),
            "fps": reported_fps,
            "codec": _reported_codec(cap, cv2, codec),
        }
    return True, {
        "width": int(actual_w),
        "height": int(actual_h),
        "fps": reported_fps if reported_fps > 1 else float(fps),
        "codec": _reported_codec(cap, cv2, codec),
    }
