"""Camera driver.

Captures frames with OpenCV on a worker thread and publishes the newest one:

- `frame`: in-process only, `{..., _frame}` with the BGR ndarray. Node gets
  the metadata without the image.
- `color`: the frame as a base64 JPEG, encoded only while someone listens.
- `frame_size`: the delivered size, after rotation, whenever the mode changes.
- `fps`: the publish rate, once a second.

Every mode change goes through `_reconfigure`: stop the capture worker,
release the device, then open it with the new settings. V4L2 refuses a second
handle on a busy device, so the old one must go first. If the new mode fails,
the previous one is restored and the action raises.

`list_formats` runs without an instance. For a device a camera instance has
open it answers from the cache (or the current mode), since probing would
need the device.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from typing import Any, ClassVar, Literal

import cv2
import msgspec

from gosai_py.devices import open_capture
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.payloads import FpsPayload, PositiveInt
from gosai_py.serialization import frame_to_jpeg_base64

# Resolutions offered to the UI. The probe keeps only the ones the device
# actually delivers, so listing extras is harmless.
STANDARD_RESOLUTIONS: tuple[tuple[int, int], ...] = (
    (640, 480),
    (1280, 720),
    (1920, 1080),
    (2560, 1440),
    (3840, 2160),
)
# The capture loop throttles to the selected rate, so common targets are
# offered instead of the camera's often wrong reported FPS.
STANDARD_FPS: tuple[int, ...] = (24, 30, 60)
# Reads after a mode change while the stream settles: the first frames can be
# stale at the old size or undecodable mid-renegotiation.
READ_SETTLE_ATTEMPTS = 5
FORMAT_CACHE_TTL_S = 10.0
JPEG_QUALITY = 60
# How long `loop` waits for a new frame before reporting an idle iteration.
FRAME_WAIT_S = 0.1

Rotation = Literal[0, 90, 180, 270]


class CameraConfig(msgspec.Struct, kw_only=True):
    device: int = 0
    width: PositiveInt = 1280
    height: PositiveInt = 720
    fps: float = 30.0
    rotation: Rotation = 0


class FramePayload(msgspec.Struct, kw_only=True):
    width: int
    height: int
    # Capture time in seconds since the epoch; `ts` repeats it.
    ts: float
    capture_ts: float
    # `time.perf_counter()` at capture, comparable within the bridge process.
    capture_perf: float
    codec: str


class ColorPayload(FramePayload, kw_only=True):
    jpeg_base64: str
    encode_ms: float


class FrameSizePayload(msgspec.Struct, kw_only=True):
    width: int
    height: int
    fps: float
    codec: str


class CameraFormat(msgspec.Struct, kw_only=True):
    width: int
    height: int
    fps: list[int]


class CameraFormats(msgspec.Struct, kw_only=True):
    ok: bool = True
    device: int
    formats: list[CameraFormat]
    # True when a camera instance holds the device and the list may be partial.
    in_use: bool = False


class ListFormatsParams(msgspec.Struct, kw_only=True):
    device: int = 0


class DeviceResult(msgspec.Struct, kw_only=True):
    device: int


class ResolutionParams(msgspec.Struct, kw_only=True):
    width: PositiveInt | None = None
    height: PositiveInt | None = None


class ResolutionResult(msgspec.Struct, kw_only=True):
    width: int
    height: int


class FpsResult(msgspec.Struct, kw_only=True):
    fps: float


class ModeParams(msgspec.Struct, kw_only=True):
    device: int | None = None
    width: PositiveInt | None = None
    height: PositiveInt | None = None
    fps: float | None = None
    rotation: Rotation | None = None


class ModeResult(msgspec.Struct, kw_only=True):
    device: int
    width: int
    height: int
    fps: float
    rotation: int
    codec: str


_devices_lock = threading.Lock()
# Probed formats by device, with the time of the probe.
_format_cache: dict[int, tuple[float, CameraFormats]] = {}
# Devices a camera instance has open, with the mode it delivers.
_devices_in_use: dict[int, CameraFormat] = {}


def probe_formats(device: int) -> CameraFormats:
    """The resolutions a device delivers, probing it when no instance holds it.

    Opens the device once, prefers MJPG (which unlocks 720p and up on UVC
    webcams), asks for each standard resolution and records the size the
    camera returns.
    """
    now = time.monotonic()
    with _devices_lock:
        in_use = _devices_in_use.get(device)
        cached = _format_cache.get(device)
    if in_use is not None:
        formats = cached[1].formats if cached is not None else [in_use]
        return CameraFormats(device=device, formats=formats, in_use=True)
    if cached is not None and now - cached[0] < FORMAT_CACHE_TTL_S:
        return cached[1]

    sizes: set[tuple[int, int]] = set()
    cap = open_capture(device)
    try:
        if not cap.isOpened():
            raise RuntimeError(f"cannot open camera device {device}")
        _request_low_latency(cap)
        _prefer_mjpg(cap)
        for width, height in STANDARD_RESOLUTIONS:
            actual = _negotiate_mode(cap, width, height, max(STANDARD_FPS))
            if actual is not None:
                sizes.add(actual)
    finally:
        cap.release()
    if not sizes:
        raise RuntimeError(f"camera device {device} delivered no readable modes")

    result = CameraFormats(
        device=device,
        formats=[
            CameraFormat(width=w, height=h, fps=list(STANDARD_FPS))
            for w, h in sorted(sizes, key=lambda s: s[0] * s[1], reverse=True)
        ],
    )
    with _devices_lock:
        _format_cache[device] = (now, result)
    return result


class CameraDriver(BaseDriver):
    name = "camera"
    description = "Webcam capture (OpenCV)."
    events: ClassVar[Mapping[str, Event]] = {
        "frame": Event(FramePayload, "Newest frame. In-process subscribers also get `_frame`."),
        "color": Event(ColorPayload, "Newest frame as a base64 JPEG."),
        "frame_size": Event(FrameSizePayload, "Delivered mode after each (re)open."),
        "fps": Event(FpsPayload, "Publish rate, once a second."),
    }
    stream_events = ("frame", "color")
    config_type = CameraConfig
    loop_interval_s = 0.0

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._config = CameraConfig()
        self._reconfigure_lock = threading.Lock()
        self._cap: Any = None
        self._codec = "native"
        self._capture_thread: threading.Thread | None = None
        self._capture_stop = threading.Event()
        self._frame_cond = threading.Condition()
        self._latest_frame: Any = None
        self._latest_meta: dict[str, Any] | None = None
        self._latest_frame_id = 0
        self._published_frame_id = 0
        self._last_emit = 0.0
        self._frame_count = 0
        self._fps_window_start = 0.0

    def configure(self, config: CameraConfig) -> None:
        self._config = config

    def pre_run(self) -> None:
        with self._reconfigure_lock:
            self._open(self._config)

    def cleanup(self) -> None:
        with self._reconfigure_lock:
            self._close()
        self.log("info", "camera released")

    @action("List the modes a device delivers.", requires_instance=False)
    @staticmethod
    def list_formats(params: ListFormatsParams | None) -> CameraFormats:
        return probe_formats(params.device if params is not None else 0)

    @action("Switch to another camera device.")
    def set_device(self, device: int) -> DeviceResult:
        return DeviceResult(device=self._reconfigure(device=device).device)

    @action("Change the requested resolution. Omitted sides keep their value.")
    def set_resolution(self, params: ResolutionParams) -> ResolutionResult:
        config = self._reconfigure(**_given(params))
        return ResolutionResult(width=config.width, height=config.height)

    @action("Change the target frame rate.")
    def set_fps(self, fps: float) -> FpsResult:
        return FpsResult(fps=self._reconfigure(fps=fps).fps)

    @action("Change several settings with one reopen. Omitted fields keep their value.")
    def set_mode(self, params: ModeParams | None) -> ModeResult:
        config = self._reconfigure(**(_given(params) if params is not None else {}))
        return ModeResult(
            device=config.device,
            width=config.width,
            height=config.height,
            fps=config.fps,
            rotation=config.rotation,
            codec=self._codec,
        )

    @action("The newest frame as a base64 JPEG, or null before the first frame.")
    def snapshot(self) -> ColorPayload | None:
        data = self.get_event_data("color")
        if isinstance(data, dict) and isinstance(data.get("jpeg_base64"), str):
            return msgspec.convert(data, ColorPayload)
        with self._frame_cond:
            frame, meta = self._latest_frame, self._latest_meta
        if frame is None or meta is None:
            return None
        return ColorPayload(**meta, **_encode(frame))

    def loop(self) -> bool:
        with self._frame_cond:
            fresh = self._frame_cond.wait_for(
                lambda: self._latest_frame_id != self._published_frame_id, timeout=FRAME_WAIT_S
            )
            if not fresh or self._latest_frame is None or self._latest_meta is None:
                return False
            frame, meta = self._latest_frame, dict(self._latest_meta)
            self._published_frame_id = self._latest_frame_id

        if self._context.has_subscribers("frame"):
            self.emit("frame", {**meta, "_frame": frame})
        if self._context.has_subscribers("color"):
            encoded = _encode(frame)
            self.record("jpeg_encode_ms", encoded["encode_ms"])
            self.emit("color", {**meta, **encoded})

        now = time.time()
        if self._fps_window_start == 0.0:
            self._fps_window_start = now
        self._frame_count += 1
        if now - self._fps_window_start >= 1.0:
            self.emit("fps", {"fps": round(self._frame_count / (now - self._fps_window_start), 1)})
            self._frame_count = 0
            self._fps_window_start = now

        # Publish at roughly the target rate.
        fps = self._config.fps
        if fps > 0:
            remaining = 1.0 / fps - (time.perf_counter() - self._last_emit)
            if remaining > 0:
                time.sleep(remaining)
            self._last_emit = time.perf_counter()
        return True

    def _reconfigure(self, **changes: Any) -> CameraConfig:
        """Reopen the device with `changes`, restoring the previous mode on failure."""
        with self._reconfigure_lock:
            previous = self._config
            target = msgspec.structs.replace(previous, **changes)
            self._close()
            try:
                self._open(target)
            except Exception:
                try:
                    self._open(previous)
                except Exception as exc:
                    self.log("error", f"could not restore camera device={previous.device}: {exc!r}")
                    self.publish_state("errored")
                raise
            self.publish_state("running")
            return self._config

    def _open(self, config: CameraConfig) -> None:
        cap = open_capture(config.device)
        if not cap.isOpened():
            cap.release()
            raise RuntimeError(f"cannot open camera device={config.device}")
        _request_low_latency(cap)
        _prefer_mjpg(cap)
        # Keep the size the camera delivers rather than rejecting near misses,
        # so a resolution the hardware rounds never fails the start.
        actual = _negotiate_mode(cap, config.width, config.height, config.fps)
        if actual is None:
            cap.release()
            raise RuntimeError(
                f"camera device={config.device} returned no frames at {config.width}x{config.height}"
            )
        width, height = actual
        if actual != (config.width, config.height):
            self.log(
                "warn",
                f"camera device={config.device} delivered {width}x{height} "
                f"(requested {config.width}x{config.height})",
            )
        self._cap = cap
        self._config = msgspec.structs.replace(config, width=width, height=height)
        self._codec = _current_fourcc(cap)
        with _devices_lock:
            _devices_in_use[config.device] = CameraFormat(
                width=width, height=height, fps=[round(config.fps)]
            )

        output_w, output_h = (height, width) if config.rotation in (90, 270) else (width, height)
        self.set_runtime_info(
            {
                "backend": "opencv",
                "provider": self._codec,
                "device": f"camera:{config.device}",
                "model": f"{output_w}x{output_h}@{config.fps:g}",
                "accelerated": False,
                "reason": "camera capture codec",
            }
        )
        self._capture_stop.clear()
        self._capture_thread = threading.Thread(
            target=self._capture_loop, args=(cap, config.rotation),
            name=f"camera:{config.device}:capture", daemon=True,
        )
        self._capture_thread.start()
        self.log(
            "info",
            f"camera open: device={config.device} {width}x{height} target_fps={config.fps:g} "
            f"codec={self._codec} rotation={config.rotation}",
        )
        self.emit(
            "frame_size",
            {"width": output_w, "height": output_h, "fps": config.fps, "codec": self._codec},
        )

    def _close(self) -> None:
        """Stop the capture worker, then release the device."""
        thread, self._capture_thread = self._capture_thread, None
        if thread is not None:
            self._capture_stop.set()
            thread.join(2.0)
            if thread.is_alive():
                self.log("warn", "camera capture worker did not stop within 2s")
        cap, self._cap = self._cap, None
        if cap is not None:
            cap.release()
            with _devices_lock:
                _devices_in_use.pop(self._config.device, None)
        with self._frame_cond:
            self._latest_frame = None
            self._latest_meta = None

    def _capture_loop(self, cap: Any, rotation: int) -> None:
        codec = self._codec
        while not self._capture_stop.is_set():
            ok, frame = _safe_read(cap)
            if not ok or frame is None:
                self._capture_stop.wait(0.005)
                continue
            frame = _rotate_frame(frame, rotation)
            h, w = frame.shape[:2]
            capture_ts = time.time()
            with self._frame_cond:
                self._latest_frame = frame
                self._latest_meta = {
                    "width": int(w),
                    "height": int(h),
                    "ts": capture_ts,
                    "capture_ts": capture_ts,
                    "capture_perf": time.perf_counter(),
                    "codec": codec,
                }
                self._latest_frame_id += 1
                self._frame_cond.notify_all()


def _given(params: msgspec.Struct) -> dict[str, Any]:
    return {
        field: value
        for field in params.__struct_fields__
        if (value := getattr(params, field)) is not None
    }


def _encode(frame: Any) -> dict[str, Any]:
    start = time.perf_counter()
    encoded = frame_to_jpeg_base64(frame, quality=JPEG_QUALITY)
    return {"jpeg_base64": encoded, "encode_ms": (time.perf_counter() - start) * 1000.0}


def _rotate_frame(frame: Any, rotation: int) -> Any:
    if rotation == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    if rotation == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    if rotation == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def _request_low_latency(cap: Any) -> None:
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)


def _prefer_mjpg(cap: Any) -> None:
    """Ask for MJPG, which UVC webcams need for 720p and up. Backends without it ignore it."""
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter.fourcc(*"MJPG"))


def _safe_read(cap: Any) -> tuple[bool, Any]:
    """Read one frame, treating decode errors as a miss.

    While a V4L2 stream renegotiates, OpenCV can raise `cv2.error` (for
    example "total number of matrix elements is not divisible ... in function
    'reshape'"). That only means this frame isn't decodable yet.
    """
    try:
        ok, frame = cap.read()
    except cv2.error:
        return False, None
    return bool(ok), frame


def _current_fourcc(cap: Any) -> str:
    """Label of the pixel format the capture settled on."""
    raw = int(cap.get(cv2.CAP_PROP_FOURCC))
    chars = "".join(chr((raw >> (8 * i)) & 0xFF) for i in range(4)).strip("\x00 ") if raw > 0 else ""
    return chars or "native"


def _negotiate_mode(cap: Any, width: int, height: int, fps: float) -> tuple[int, int] | None:
    """Request a mode and return the frame size the camera actually delivers.

    Returns None only when no frame decodes. Stops early once the requested
    size arrives, otherwise returns the last decoded size, which may be the
    camera's nearest supported mode.
    """
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, float(width))
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, float(height))
    cap.set(cv2.CAP_PROP_FPS, float(fps))
    size: tuple[int, int] | None = None
    for _ in range(READ_SETTLE_ATTEMPTS):
        ok, frame = _safe_read(cap)
        if not ok or frame is None:
            time.sleep(0.01)
            continue
        h, w = frame.shape[:2]
        size = (int(w), int(h))
        if size == (width, height):
            break
    return size

