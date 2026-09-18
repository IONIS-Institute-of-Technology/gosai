"""Ball detector using a fine-tuned single-class YOLO model via ONNX Runtime.

Runs a purpose-trained "ball" detector (YOLO26, single class) exported to ONNX
for low-latency inference (no PyTorch at runtime). The single ONNX model is run
under the fastest available ONNX Runtime execution provider — TensorRT or CUDA
on NVIDIA, CoreML (Apple Neural Engine/GPU) on macOS, CPU otherwise — so the
pre/post-processing here is shared across every backend. Detections run in
camera space, then the calibration homography is applied to final ball
centers/radii so emitted coordinates live in the 1920x1080 reference system.

The model has a single class, so detections are ball candidates by definition —
they are only filtered by confidence, size, and the calibrated table bounds.
The model is trained with negatives (empty tables, pockets, hands, cues, glare)
so pockets and sun rays do not fire. Detected positions are emitted raw — no
smoothing — so rendered motion has zero added latency. A minimal
nearest-neighbour tracker only estimates per-ball velocity (for renderer-side
extrapolation between detections) and holds a ball for a couple of missed
frames so it does not flicker when YOLO drops a frame.

The model exports the YOLO26 end-to-end (NMS-free) head: the ONNX output is
``(1, 300, 6)`` rows of ``[x1, y1, x2, y2, confidence, class_id]`` — no NMS is
needed at runtime.

The model ships with the package at ``ball_models/ball.onnx``. Produce/update it
with the training pipeline in the repo's ``training/`` folder, which also writes
``ball.onnx.json``; when present, the driver checks the model's sha256 against
it. The input size comes from the ONNX model.

Events and actions are declared with their types on the driver class. Each
ball has a center ``x, y``, a ``diameter`` and a velocity ``vx, vy`` in px/s.

The letterbox preprocessing mirrors ``training/``'s ONNX export, which is a
separate package and keeps its own copy.

Environment (optional):
- ``GOSAI_BALL_CONFIDENCE`` — detection confidence threshold 0..1 (default 0.70);
  the ``set_confidence`` action still overrides it at runtime.
- ``GOSAI_ACCELERATOR`` — ``auto``, ``cuda``, ``tensorrt``, ``coreml`` (macOS),
  ``dml``, ``cpu``. ``auto`` uses CUDA on NVIDIA and CoreML on macOS. TensorRT is
  opt-in.
- ``GOSAI_CUDA_DEVICE_ID`` — CUDA device index when using NVIDIA (default 0)
- ``GOSAI_TRT_CACHE_DIR`` — where TensorRT caches compiled engines
  (default ``~/.cache/gosai/trt``); the first TensorRT run compiles and is slow.
"""

from __future__ import annotations

import math
import os
import time
from collections import deque
from collections.abc import Mapping
from pathlib import Path
from typing import Any, ClassVar, NamedTuple

import cv2
import msgspec
import numpy as np

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import capture_timing, latency_ms
from gosai_py.geometry import homography
from gosai_py.payloads import FpsPayload, Matrix3x3, Ok, Size, SizeResult
from gosai_py.runtime import create_onnx_session
from gosai_py.runtime.models import Model, resolve_model
from gosai_py.smoothing import lerp

MODEL = Model.bundled(Path(__file__).resolve().parent / "ball_models" / "ball.onnx")


DEFAULT_CONFIDENCE = 0.70


def _default_confidence() -> float:
    """Confidence threshold default, overridable via GOSAI_BALL_CONFIDENCE."""
    raw = os.environ.get("GOSAI_BALL_CONFIDENCE", "")
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_CONFIDENCE
    return max(0.01, min(1.0, value))


class _Detection(NamedTuple):
    x: float
    y: float
    r: float
    score: float


def _letterbox(img: Any, size: tuple[int, int]) -> tuple[Any, float, tuple[int, int]]:
    """Resize with aspect-preserving padding (letterbox) to (height, width).

    Returns the padded image, the scale factor, and (pad_top, pad_left).
    """
    ih, iw = size
    h, w = img.shape[:2]
    scale = min(ih / h, iw / w)
    nw, nh = round(w * scale), round(h * scale)
    if (nw, nh) != (w, h):
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    top, left = (ih - nh) // 2, (iw - nw) // 2
    bottom, right = ih - nh - top, iw - nw - left
    img = cv2.copyMakeBorder(
        img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114)
    )
    return img, scale, (top, left)


def _input_spec(session: Any) -> tuple[str, tuple[int, int]]:
    """Name and (height, width) of the model's NCHW image input."""
    inp = session.get_inputs()[0]
    shape = inp.shape
    if len(shape) != 4 or not all(isinstance(dim, int) for dim in shape[2:]):
        raise RuntimeError(f"ball: expected a fixed NCHW input, got {inp.name} {shape}")
    return inp.name, (int(shape[2]), int(shape[3]))


def _preprocess(frame: Any, size: tuple[int, int]) -> tuple[Any, float, tuple[int, int]]:
    """BGR frame -> float32 NCHW tensor for ONNX."""
    img, scale, pad = _letterbox(frame, size)
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    img = img.astype(np.float32) / 255.0
    img = np.transpose(img, (2, 0, 1))[np.newaxis, ...]
    return np.ascontiguousarray(img), scale, pad


def _postprocess(
    output: Any,
    scale: float,
    pad: tuple[int, int],
    conf_thresh: float,
    min_px: float,
    max_px: float,
    max_aspect: float,
) -> list[_Detection]:
    """Extract ball candidates from the YOLO26 NMS-free head ``[1, N, 6]``.

    Each row is ``[x1, y1, x2, y2, confidence, class_id]`` in letterbox pixels.
    The model already performs duplicate suppression, so no NMS is required.
    """
    preds = np.asarray(output[0])
    if preds.ndim == 3:
        preds = preds[0]  # [N, 6]
    if preds.size == 0 or preds.shape[-1] < 6:
        return []

    scores = preds[:, 4]
    preds = preds[scores >= conf_thresh]
    if len(preds) == 0:
        return []

    # xyxy in letterbox coords -> original image coords
    boxes = preds[:, :4].copy()
    boxes[:, [0, 2]] -= pad[1]
    boxes[:, [1, 3]] -= pad[0]
    boxes /= scale

    results: list[_Detection] = []
    for (x1, y1, x2, y2), score in zip(boxes, preds[:, 4], strict=False):
        w = float(x2 - x1)
        h = float(y2 - y1)
        side = max(w, h)
        if side < min_px or side > max_px:
            continue
        aspect = max(w, h) / max(min(w, h), 1.0)
        if aspect > max_aspect:
            continue
        cx = float(x1) + w / 2.0
        cy = float(y1) + h / 2.0
        r = (w + h) / 4.0
        results.append(_Detection(cx, cy, r, float(score)))
    return results


def _warp_detections(
    detections: list[_Detection],
    matrix: homography.Matrix,
) -> list[_Detection]:
    if not detections:
        return []
    centers = homography.warp_points(matrix, [[d.x, d.y] for d in detections])
    # Estimate the radius scale locally by warping one horizontal and one
    # vertical radius endpoint, then averaging the distances in target space.
    horizontal = homography.warp_points(matrix, [[d.x + d.r, d.y] for d in detections])
    vertical = homography.warp_points(matrix, [[d.x, d.y + d.r] for d in detections])
    radii = (
        np.linalg.norm(horizontal - centers, axis=1) + np.linalg.norm(vertical - centers, axis=1)
    ) / 2.0
    # A detection that maps to infinity has no place on the surface.
    return [
        _Detection(float(x), float(y), float(r), d.score)
        for (x, y), r, d in zip(centers, radii, detections, strict=True)
        if np.isfinite(x) and np.isfinite(y) and np.isfinite(r)
    ]


def _filter_output_bounds(
    detections: list[_Detection],
    output_size: tuple[int, int],
) -> list[_Detection]:
    """Keep only plausible balls inside the calibrated table/surface plane."""
    width, height = output_size
    max_radius = max(16.0, min(width, height) * 0.10)
    filtered: list[_Detection] = []
    for det in detections:
        padding = max(8.0, det.r * 0.5)
        if det.r <= 0 or det.r > max_radius:
            continue
        if -padding <= det.x <= width + padding and -padding <= det.y <= height + padding:
            filtered.append(det)
    return filtered


# EMA weight for velocity estimation (velocity only -- positions pass raw).
_VELOCITY_ALPHA = 0.5


class _TrackedBall:
    __slots__ = ("last_seen_t", "missed", "r", "vx", "vy", "x", "y")

    def __init__(self, det: _Detection, t: float) -> None:
        self.x = det.x
        self.y = det.y
        self.r = det.r
        self.vx = 0.0
        self.vy = 0.0
        self.last_seen_t = t
        self.missed = 0

    def update(self, det: _Detection, t: float) -> None:
        dt = max(t - self.last_seen_t, 1e-6)
        # Positions pass through raw; only velocity is lightly averaged so
        # renderer-side extrapolation doesn't jitter.
        self.vx = lerp(self.vx, (det.x - self.x) / dt, _VELOCITY_ALPHA)
        self.vy = lerp(self.vy, (det.y - self.y) / dt, _VELOCITY_ALPHA)
        self.x = det.x
        self.y = det.y
        self.r = det.r
        self.last_seen_t = t
        self.missed = 0

    def predict(self, dt: float) -> tuple[float, float]:
        return self.x + self.vx * dt, self.y + self.vy * dt

    def render_position(self, t: float) -> tuple[float, float]:
        if self.missed <= 0:
            return self.x, self.y
        return self.predict(max(0.0, t - self.last_seen_t))

    def render_velocity(self) -> tuple[float, float]:
        # Decay extrapolation while YOLO is missing the ball to avoid overshoots.
        decay = 0.65 ** max(0, self.missed)
        return self.vx * decay, self.vy * decay


class _BallTracker:
    """Minimal nearest-neighbour tracker with zero position smoothing.

    Detections are emitted at their raw positions, so there is no added
    motion latency. The tracker only keeps per-ball identity across frames
    to estimate velocity (used by the renderer to extrapolate between
    detections) and holds a confirmed ball at its predicted position for a
    couple of missed frames so a dropped YOLO frame does not flicker.
    """

    def __init__(
        self,
        max_miss: int = 3,
        render_miss: int = 2,
        match_radius: float = 110.0,
        min_match_radius: float = 45.0,
    ) -> None:
        self.max_miss = max_miss
        self.render_miss = render_miss
        self.match_radius = match_radius
        self.min_match_radius = min_match_radius
        self.tracks: list[_TrackedBall] = []

    def update(self, detections: list[_Detection], t: float) -> list[_TrackedBall]:
        used_det: set[int] = set()
        used_trk: set[int] = set()

        # Greedy nearest-neighbour matching against predicted positions so a
        # fast ball stays attached to its track instead of spawning a phantom.
        pairs: list[tuple[float, int, int]] = []
        for ti, trk in enumerate(self.tracks):
            dt = max(0.0, t - trk.last_seen_t)
            px, py = trk.predict(dt) if dt > 0 else (trk.x, trk.y)
            speed = math.hypot(trk.vx, trk.vy)
            radius_gate = trk.r * 2.4 + speed * dt * 1.1
            gate = min(self.match_radius, max(self.min_match_radius, radius_gate))
            for di, det in enumerate(detections):
                dist = math.hypot(det.x - px, det.y - py)
                if dist < gate:
                    pairs.append((dist, ti, di))
        pairs.sort()
        for _dist, ti, di in pairs:
            if ti in used_trk or di in used_det:
                continue
            self.tracks[ti].update(detections[di], t)
            used_trk.add(ti)
            used_det.add(di)

        for ti, trk in enumerate(self.tracks):
            if ti not in used_trk:
                trk.missed += 1

        for di, det in enumerate(detections):
            if di not in used_det:
                self.tracks.append(_TrackedBall(det, t))

        self.tracks = [trk for trk in self.tracks if trk.missed <= self.max_miss]

        return self._renderable()

    def current(self) -> list[_TrackedBall]:
        return self._renderable()

    def _renderable(self) -> list[_TrackedBall]:
        return [t for t in self.tracks if t.missed <= self.render_miss]


class Ball(msgspec.Struct, kw_only=True):
    """A tracked ball in output pixels."""

    x: int
    y: int
    diameter: float
    # Velocity in px/s, for extrapolating between detections.
    vx: float
    vy: float


class BallsPayload(msgspec.Struct, kw_only=True):
    balls: list[Ball]
    count: int
    ts: float
    capture_ts: float
    frame_age_ms: float
    latency_ms: float


class ConfidenceResult(msgspec.Struct, kw_only=True):
    confidence: float


class MaxBallResult(msgspec.Struct, kw_only=True):
    max_ball_px: float


class MinBallResult(msgspec.Struct, kw_only=True):
    min_ball_px: float


class FrameSkipResult(msgspec.Struct, kw_only=True):
    frame_skip: int


class CudaDeviceResult(msgspec.Struct, kw_only=True):
    cuda_device_id: int


class BallDriver(BaseDriver):
    name = "ball"
    description = "YOLO-based ball detector (ONNX Runtime)."
    events: ClassVar[Mapping[str, Event]] = {
        "balls": Event(BallsPayload, "Balls tracked in the latest processed frame."),
        "fps": Event(FpsPayload, "Detection rate over the last 50 frames."),
    }
    stream_events = ("balls", "fps")
    dependencies = ("camera",)
    subscribed = (("camera", "frame"),)
    loop_interval_s = None

    DEFAULT_OUTPUT_SIZE: ClassVar[tuple[int, int]] = (1920, 1080)

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._session: Any = None
        self._input_name: str = ""
        self._input_size: tuple[int, int] = (0, 0)
        self._homography: homography.Matrix | None = None
        self._output_size = self.DEFAULT_OUTPUT_SIZE
        self._confidence = _default_confidence()
        self._min_ball_px = 10.0
        self._max_ball_px = 100.0
        self._max_aspect = 1.6
        self._frame_times: deque[float] = deque(maxlen=50)
        self._tracker = _BallTracker(
            max_miss=3, render_miss=2, match_radius=110.0, min_match_radius=45.0
        )
        self._frame_idx = 0
        self._skip = 0  # 0 = process every frame; raise on slow hardware
        # None uses GOSAI_CUDA_DEVICE_ID, read when the session is created.
        self._cuda_device_id: int | None = None

    def pre_run(self) -> None:
        self._load_session()

    def _load_session(self) -> None:
        model_path = resolve_model(MODEL, self.log)
        session, info = create_onnx_session(
            model_path,
            cuda_device_id=self._cuda_device_id,
            log_fn=self.log,
        )
        self._input_name, self._input_size = _input_spec(session)
        self._session = session
        self.set_runtime_info(dict(info))

    @action("Set the camera->output homography (9 values, row-major).")
    def set_homography(self, matrix: Matrix3x3) -> Ok:
        self._homography = homography.to_matrix(matrix)
        return Ok()

    @action("Set the output size balls are kept within once a homography is set.")
    def set_output_size(self, size: Size) -> SizeResult:
        self._output_size = (size.width, size.height)
        return SizeResult(width=size.width, height=size.height)

    @action("Set the detection confidence threshold (clamped to 0.01..1).")
    def set_confidence(self, confidence: float) -> ConfidenceResult:
        self._confidence = max(0.01, min(1.0, confidence))
        return ConfidenceResult(confidence=self._confidence)

    @action("Ignore detections larger than this, in camera pixels.")
    def set_max_ball_px(self, px: float) -> MaxBallResult:
        self._max_ball_px = px
        return MaxBallResult(max_ball_px=px)

    @action("Ignore detections smaller than this, in camera pixels.")
    def set_min_ball_px(self, px: float) -> MinBallResult:
        self._min_ball_px = px
        return MinBallResult(min_ball_px=px)

    @action("Run detection on one frame out of n + 1; 0 processes every frame.")
    def set_frame_skip(self, skip: int) -> FrameSkipResult:
        self._skip = max(0, skip)
        return FrameSkipResult(frame_skip=self._skip)

    @action("Reload the model on another CUDA device.")
    def set_cuda_device(self, device: int) -> CudaDeviceResult:
        self._cuda_device_id = max(0, device)
        self._session = None
        self._load_session()
        self.publish_state("running")
        return CudaDeviceResult(cuda_device_id=self._cuda_device_id)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict) or self._session is None:
            return
        frame = data.get("_frame")
        if frame is None:
            raise RuntimeError("ball requires camera.frame payload with _frame")

        start = time.perf_counter()
        capture_ts, frame_age_ms = capture_timing(data)
        self.record("frame_age_ms", frame_age_ms)

        # On skipped frames nothing is emitted: the renderer keeps the last
        # outline until the next detection, which avoids ghost outlines.
        self._frame_idx += 1
        if self._skip > 0 and self._frame_idx % (self._skip + 1) != 0:
            return

        tensor, scale, pad = _preprocess(frame, self._input_size)
        outputs = self._session.run(None, {self._input_name: tensor})

        detections = _postprocess(
            outputs,
            scale,
            pad,
            self._confidence,
            self._min_ball_px,
            self._max_ball_px,
            self._max_aspect,
        )
        if self._homography is not None:
            detections = _warp_detections(detections, self._homography)
            detections = _filter_output_bounds(detections, self._output_size)

        now = time.perf_counter()
        stable = self._tracker.update(detections, now)
        # Velocity lets the renderer extrapolate between detections, which a
        # 15 Hz camera on a 60 Hz display needs to avoid visible stepping.
        balls: list[dict[str, Any]] = []
        for t in stable:
            x, y = t.render_position(now)
            vx, vy = t.render_velocity()
            balls.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "diameter": round(t.r * 2, 1),
                    "vx": round(vx, 1),
                    "vy": round(vy, 1),
                },
            )

        self._frame_times.append(now)
        if len(self._frame_times) >= 2:
            span = self._frame_times[-1] - self._frame_times[0]
            fps = (len(self._frame_times) - 1) / span if span > 0 else 0.0
            self.emit("fps", {"fps": round(fps, 2)})
        self.record("loop_ms", (now - start) * 1000.0)

        self.emit(
            "balls",
            {
                "balls": balls,
                "count": len(balls),
                "ts": time.time(),
                "capture_ts": capture_ts,
                "frame_age_ms": frame_age_ms,
                "latency_ms": latency_ms(capture_ts),
            },
        )
