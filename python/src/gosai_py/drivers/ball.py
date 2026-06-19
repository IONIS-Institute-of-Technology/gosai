"""Ball detector using YOLOv8n via ONNX Runtime.

Runs a YOLOv8n model exported to ONNX for low-latency inference (no
PyTorch at runtime). Detections run in camera space, then the calibration
homography is applied to final ball centers/radii so emitted coordinates
live in the 1920x1080 reference coordinate system.

Detection is class-agnostic: all 80 COCO classes can fire, then candidates
are filtered by confidence, shape, local edge support, and the calibrated
table bounds.  Positions are smoothed with a One-Euro filter (Casiez et al.,
CHI 2012) — strong smoothing when a ball is stationary (kills jitter), weak
smoothing when it moves fast (kills lag).  Track association uses velocity
prediction so a fast ball stays attached to its track instead of spawning a
phantom. New tracks require consecutive hits before rendering, while confirmed
tracks survive short detector misses using predicted positions.

On first launch the driver downloads ``yolov8n.onnx`` (~12 MB) into
``~/.gosai/models/``.

Events:
- ``balls``: list of ``{x, y, r}`` positions in display pixels.
- ``fps``: rolling FPS estimate.

Actions:
- ``set_homography(matrix9)``
- ``set_output_size({width, height})``
- ``set_confidence(0..1)``
- ``set_max_ball_px(px)`` / ``set_min_ball_px(px)``
- ``set_min_cutoff(hz)``            — One-Euro min cutoff (lower = smoother static)
- ``set_beta(value)``               — One-Euro speed coeff (lower = smoother moving)
- ``set_frame_skip(n)``             — run YOLO every (n+1) frames; 0 = every frame
- ``set_cuda_device(id)``           — NVIDIA GPU index (default 0)

Environment (optional):
- ``GOSAI_ACCELERATOR`` — ``auto``, ``cuda``, ``cpu``, ``coreml`` (macOS), ``dml``
- ``GOSAI_CUDA_DEVICE_ID`` — CUDA device index when using NVIDIA (default 0)
"""

from __future__ import annotations

import math
import os
import time
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any, ClassVar, NamedTuple

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.runtime import create_onnx_session, cuda_device_id

YOLO_ONNX_FILENAME = "yolov8n.onnx"
YOLO_ONNX_URL = (
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx"
)
MODEL_INPUT_SIZE = 640


class _Detection(NamedTuple):
    x: float
    y: float
    r: float
    score: float


# ── Helpers ──────────────────────────────────────────────────────────────

def _gosai_home() -> Path:
    override = os.environ.get("GOSAI_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".gosai"


def _models_dir() -> Path:
    d = _gosai_home() / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _download_file(url: str, target: Path, log_fn: Any) -> bool:
    try:
        log_fn("info", f"ball: downloading {target.name}")
        tmp = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(url, timeout=60) as resp, tmp.open("wb") as fp:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                fp.write(chunk)
        tmp.replace(target)
        log_fn("info", f"ball: download complete ({target.name})")
        return True
    except Exception as exc:
        log_fn("error", f"ball: download failed: {exc!r}")
        return False


def _ensure_onnx(log_fn: Any) -> Path | None:
    """Return cached ONNX path, downloading from Ultralytics assets if missing."""
    onnx_path = _models_dir() / YOLO_ONNX_FILENAME
    if onnx_path.exists() and onnx_path.stat().st_size > 0:
        return onnx_path
    if _download_file(YOLO_ONNX_URL, onnx_path, log_fn):
        return onnx_path
    return None


# ── ONNX inference helpers ───────────────────────────────────────────────

def _letterbox(img: Any, size: int) -> tuple[Any, float, tuple[int, int]]:
    """Resize with aspect-preserving padding (letterbox).

    Returns the padded image, the scale factor, and (pad_top, pad_left).
    """
    import cv2  # type: ignore[import-not-found]

    h, w = img.shape[:2]
    scale = min(size / h, size / w)
    nw, nh = round(w * scale), round(h * scale)
    if (nw, nh) != (w, h):
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    dh, dw = (size - nh) / 2, (size - nw) / 2
    top, left = round(dh - 0.1), round(dw - 0.1)
    bottom, right = round(dh + 0.1), round(dw + 0.1)
    img = cv2.copyMakeBorder(img, top, bottom, left, right,
                             cv2.BORDER_CONSTANT, value=(114, 114, 114))
    return img, scale, (top, left)


def _preprocess(frame: Any, size: int) -> tuple[Any, float, tuple[int, int]]:
    """BGR frame -> float32 NCHW tensor for ONNX."""
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

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
    iou_thresh: float,
    min_px: float,
    max_px: float,
    max_aspect: float,
) -> list[_Detection]:
    """Extract ball candidates from raw ONNX output [1, 84, N]."""
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    preds = np.squeeze(output[0]).T  # [N, 84]
    class_scores = preds[:, 4:]
    max_scores = np.max(class_scores, axis=1)

    mask = max_scores >= conf_thresh
    preds = preds[mask]
    max_scores = max_scores[mask]
    if len(preds) == 0:
        return []

    # cx, cy, w, h in letterbox coords -> original image coords
    boxes_cxcywh = preds[:, :4].copy()
    boxes_cxcywh[:, 0] -= pad[1]
    boxes_cxcywh[:, 1] -= pad[0]
    boxes_cxcywh[:, :4] /= scale

    # Convert to x,y,w,h for NMS
    boxes_xywh = boxes_cxcywh.copy()
    boxes_xywh[:, 0] -= boxes_xywh[:, 2] / 2
    boxes_xywh[:, 1] -= boxes_xywh[:, 3] / 2

    indices = cv2.dnn.NMSBoxes(
        boxes_xywh.tolist(), max_scores.tolist(), conf_thresh, iou_thresh,
    )

    results: list[_Detection] = []
    for i in np.array(indices).flatten():
        cx, cy, w, h = boxes_cxcywh[i]
        side = max(w, h)
        if side < min_px or side > max_px:
            continue
        aspect = max(w, h) / max(min(w, h), 1.0)
        if aspect > max_aspect:
            continue
        r = (w + h) / 4.0
        results.append(_Detection(float(cx), float(cy), float(r), float(max_scores[i])))
    return results


def _edge_support_score(frame: Any, det: _Detection) -> float:
    """Return how much candidate edge energy sits near the expected ball rim."""
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    radius = max(2.0, det.r)
    pad = max(6, round(radius * 1.6))
    h, w = frame.shape[:2]
    x1 = max(0, round(det.x - pad))
    y1 = max(0, round(det.y - pad))
    x2 = min(w, round(det.x + pad))
    y2 = min(h, round(det.y + pad))
    if x2 - x1 < 6 or y2 - y1 < 6:
        return 1.0

    crop = frame[y1:y2, x1:x2]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    med = float(np.median(gray))
    lower = int(max(0, 0.66 * med))
    upper = int(min(255, max(lower + 20, 1.33 * med)))
    edges = cv2.Canny(gray, lower, upper)

    cy = det.y - y1
    cx = det.x - x1
    yy, xx = np.ogrid[: edges.shape[0], : edges.shape[1]]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    ring = np.abs(dist - radius) <= max(2.0, radius * 0.25)
    if not np.any(ring):
        return 1.0
    return float(np.count_nonzero((edges > 0) & ring) / max(1.0, 2.0 * math.pi * radius))


def _filter_visual_candidates(frame: Any, detections: list[_Detection]) -> list[_Detection]:
    """Reject weak, non-circular flashes while keeping confident YOLO candidates."""
    if not detections:
        return []

    filtered: list[_Detection] = []
    for det in detections:
        if det.score >= 0.16:
            filtered.append(det)
            continue
        if _edge_support_score(frame, det) >= 0.08:
            filtered.append(det)
    return filtered


def _warp_detections(
    detections: list[_Detection],
    homography: Any,
) -> list[_Detection]:
    if not detections:
        return []
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    centers = np.asarray([[[d.x, d.y]] for d in detections], dtype=np.float32)
    warped = cv2.perspectiveTransform(centers, homography).reshape(-1, 2)

    # Estimate radius scale locally by transforming one horizontal and one
    # vertical radius endpoint, then averaging the distances in target space.
    endpoints = np.asarray(
        [[[d.x + d.r, d.y], [d.x, d.y + d.r]] for d in detections],
        dtype=np.float32,
    )
    warped_endpoints = cv2.perspectiveTransform(endpoints, homography)
    out: list[_Detection] = []
    for idx, (x, y) in enumerate(warped):
        r1 = float(np.linalg.norm(warped_endpoints[idx, 0] - warped[idx]))
        r2 = float(np.linalg.norm(warped_endpoints[idx, 1] - warped[idx]))
        out.append(_Detection(float(x), float(y), (r1 + r2) * 0.5, detections[idx].score))
    return out


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


# ── One-Euro filter + ball tracker ───────────────────────────────────────

class _OneEuro:
    """One-Euro filter (Casiez et al., CHI 2012).

    Adaptive low-pass filter.  Cutoff frequency rises with measured
    speed: heavy smoothing on a stationary signal (low cutoff, kills
    jitter), light smoothing on a moving signal (high cutoff, kills
    lag).  Far superior to a fixed-alpha EMA for tracking.
    """

    __slots__ = ("_dx_filt", "_t_prev", "_x_filt",
                 "beta", "d_cutoff", "min_cutoff")

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.05,
                 d_cutoff: float = 1.0) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x_filt: float | None = None
        self._dx_filt: float = 0.0
        self._t_prev: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * max(cutoff, 1e-6))
        return dt / (tau + dt) if (tau + dt) > 0 else 1.0

    def __call__(self, x: float, t: float) -> float:
        if self._x_filt is None or self._t_prev is None:
            self._x_filt = x
            self._t_prev = t
            return x
        dt = max(t - self._t_prev, 1e-6)
        dx_raw = (x - self._x_filt) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self._dx_filt = a_d * dx_raw + (1.0 - a_d) * self._dx_filt
        cutoff = self.min_cutoff + self.beta * abs(self._dx_filt)
        a = self._alpha(cutoff, dt)
        self._x_filt = a * x + (1.0 - a) * self._x_filt
        self._t_prev = t
        return self._x_filt

    @property
    def velocity(self) -> float:
        return self._dx_filt


class _TrackedBall:
    __slots__ = ("age", "fr", "fx", "fy", "last_seen_t", "missed", "r", "score", "x", "y")

    def __init__(self, det: _Detection, t: float,
                 min_cutoff: float, beta: float) -> None:
        self.fx = _OneEuro(min_cutoff=min_cutoff, beta=beta)
        self.fy = _OneEuro(min_cutoff=min_cutoff, beta=beta)
        # Radius changes slowly -- smooth harder.
        self.fr = _OneEuro(min_cutoff=min_cutoff * 0.5, beta=beta * 0.5)
        self.x = self.fx(det.x, t)
        self.y = self.fy(det.y, t)
        self.r = self.fr(det.r, t)
        self.score = det.score
        self.last_seen_t = t
        self.age = 1
        self.missed = 0

    def update(self, det: _Detection, t: float) -> None:
        self.x = self.fx(det.x, t)
        self.y = self.fy(det.y, t)
        self.r = self.fr(det.r, t)
        self.score = self.score * 0.7 + det.score * 0.3
        self.last_seen_t = t
        self.age += 1
        self.missed = 0

    def predict(self, dt: float) -> tuple[float, float]:
        """Linear extrapolation using smoothed velocity."""
        return self.x + self.fx.velocity * dt, self.y + self.fy.velocity * dt

    def render_position(self, t: float) -> tuple[float, float]:
        if self.missed <= 0:
            return self.x, self.y
        return self.predict(max(0.0, t - self.last_seen_t))

    def render_velocity(self) -> tuple[float, float]:
        # Decay extrapolation while YOLO is missing the ball to avoid long overshoots.
        decay = 0.65 ** max(0, self.missed)
        return self.fx.velocity * decay, self.fy.velocity * decay

    def set_filter_params(self, min_cutoff: float, beta: float) -> None:
        self.fx.min_cutoff = min_cutoff
        self.fx.beta = beta
        self.fy.min_cutoff = min_cutoff
        self.fy.beta = beta
        self.fr.min_cutoff = min_cutoff * 0.5
        self.fr.beta = beta * 0.5


class _BallTracker:
    """Velocity-aware tracker with One-Euro smoothing.

    Tracks are matched against detections using the **predicted** next
    position (current filtered position + smoothed velocity * dt), so a
    fast-moving ball stays attached to its existing track instead of
    spawning a phantom duplicate.

    New tracks must be confirmed by consecutive detections before they
    are rendered, which absorbs one-frame glare/sun-ray false positives.
    Confirmed tracks are rendered through short misses using predicted
    positions, which keeps real moving balls from visibly flickering when
    YOLO drops a frame.
    """

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.05,
                 max_miss: int = 5, render_miss: int = 3,
                 match_radius: float = 110.0, min_match_radius: float = 45.0,
                 min_age: int = 2) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.max_miss = max_miss
        self.render_miss = render_miss
        self.match_radius = match_radius
        self.min_match_radius = min_match_radius
        self.min_age = min_age
        self.tracks: list[_TrackedBall] = []
        self._t_prev: float | None = None

    def update(self, detections: list[_Detection],
               t: float) -> list[_TrackedBall]:
        self._t_prev = t

        used_det: set[int] = set()
        used_trk: set[int] = set()

        # Velocity-aware matching: compare detections to predicted positions.
        pairs: list[tuple[float, float, int, int]] = []
        for ti, trk in enumerate(self.tracks):
            dt = max(0.0, t - trk.last_seen_t)
            px, py = trk.predict(dt) if dt > 0 else (trk.x, trk.y)
            speed = math.hypot(trk.fx.velocity, trk.fy.velocity)
            radius_gate = trk.r * 2.4 + speed * dt * 1.1
            gate = min(self.match_radius, max(self.min_match_radius, radius_gate))
            if trk.age < self.min_age:
                gate *= 0.75
            for di, det in enumerate(detections):
                dist = math.hypot(det.x - px, det.y - py)
                if dist < gate:
                    # Prefer close matches, with a tiny confidence tie-breaker.
                    cost = (dist / gate) - det.score * 0.02
                    pairs.append((cost, dist, ti, di))
        pairs.sort()
        for _cost, _dist, ti, di in pairs:
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
                self.tracks.append(_TrackedBall(det, t, self.min_cutoff, self.beta))

        self.tracks = [trk for trk in self.tracks if self._keep_track(trk)]

        return self._renderable()

    def current(self) -> list[_TrackedBall]:
        return self._renderable()

    def set_filter_params(self, min_cutoff: float, beta: float) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        for trk in self.tracks:
            trk.set_filter_params(min_cutoff, beta)

    def _keep_track(self, trk: _TrackedBall) -> bool:
        if trk.missed > self.max_miss:
            return False
        # Unconfirmed tracks must be consecutive hits; a flickering false
        # positive never becomes visible by reappearing every few frames.
        return trk.age >= self.min_age or trk.missed == 0

    def _renderable(self) -> list[_TrackedBall]:
        return [
            t for t in self.tracks
            if t.age >= self.min_age and t.missed <= self.render_miss
        ]


# ── Driver ───────────────────────────────────────────────────────────────

class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "YOLO-based ball detector (ONNX Runtime)."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_homography",
        "set_output_size",
        "set_confidence",
        "set_max_ball_px",
        "set_min_ball_px",
        "set_min_cutoff",
        "set_beta",
        "set_frame_skip",
        "set_cuda_device",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "frame"),)
    loop_interval_s: ClassVar[float | None] = None

    DEFAULT_OUTPUT_SIZE: ClassVar[tuple[int, int]] = (1920, 1080)

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._session: Any = None
        self._input_name: str = ""
        self._input_size: int = MODEL_INPUT_SIZE
        self._homography: Any = None
        self._output_size = self.DEFAULT_OUTPUT_SIZE
        self._confidence = 0.10
        self._iou_thresh = 0.5
        self._min_ball_px = 10.0
        self._max_ball_px = 100.0
        self._max_aspect = 1.6
        self._frame_times: deque[float] = deque(maxlen=50)
        self._tracker = _BallTracker(min_cutoff=1.0, beta=0.05,
                                     max_miss=5, render_miss=3, min_age=2,
                                     match_radius=110.0, min_match_radius=45.0)
        self._frame_idx = 0
        self._skip = 0  # 0 = process every frame; raise on slow hardware
        self._cuda_device_id = cuda_device_id()
        self._onnx_path: Path | None = None

    def pre_run(self) -> None:
        super().pre_run()
        self._load_session()

    def _load_session(self) -> None:
        if self._onnx_path is None:
            self._onnx_path = _ensure_onnx(self.log)
        onnx_path = self._onnx_path
        if onnx_path is None:
            raise RuntimeError("ball: ONNX model unavailable")

        self._session, info = create_onnx_session(
            onnx_path,
            model_name=onnx_path.name,
            cuda_id=self._cuda_device_id,
            log_fn=self.log,
        )
        self.set_runtime_info(dict(info))
        inp = self._session.get_inputs()[0]
        self._input_name = inp.name
        self._input_size = inp.shape[2] if isinstance(inp.shape[2], int) else MODEL_INPUT_SIZE
        self.start_latest_worker()

    def cleanup(self) -> None:
        self.stop_latest_worker()
        super().cleanup()

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_homography":
            return self._set_homography(data)
        if action == "set_output_size":
            return self._set_output_size(data)
        if action == "set_confidence":
            self._confidence = max(0.01, min(1.0, float(data)))
            return {"confidence": self._confidence}
        if action == "set_max_ball_px":
            self._max_ball_px = float(data)
            return {"max_ball_px": self._max_ball_px}
        if action == "set_min_ball_px":
            self._min_ball_px = float(data)
            return {"min_ball_px": self._min_ball_px}
        if action == "set_min_cutoff":
            self._tracker.set_filter_params(max(0.01, float(data)), self._tracker.beta)
            return {"min_cutoff": self._tracker.min_cutoff}
        if action == "set_beta":
            self._tracker.set_filter_params(self._tracker.min_cutoff, max(0.0, float(data)))
            return {"beta": self._tracker.beta}
        if action == "set_frame_skip":
            self._skip = max(0, int(data))
            return {"frame_skip": self._skip}
        if action == "set_cuda_device":
            self._cuda_device_id = max(0, int(data))
            self._session = None
            self._load_session()
            self.publish_state("running")
            return {"cuda_device_id": self._cuda_device_id}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Detection pipeline
    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        self.queue_latest_data(driver, event, data)

    def process_latest_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict) or self._session is None:
            return
        frame = data.get("_frame")
        if frame is None:
            raise RuntimeError("ball requires camera.frame payload with _frame")

        start = time.perf_counter()
        capture_ts = data.get("capture_ts")
        capture_ts_f = float(capture_ts) if isinstance(capture_ts, int | float) else time.time()
        frame_age_ms = (time.time() - capture_ts_f) * 1000.0
        self.record("frame_age_ms", frame_age_ms)

        # Optional frame skipping (default 0 = every frame).  On skipped
        # frames we don't re-emit anything: the renderer keeps the last
        # outline visible until the next detection refreshes it, which
        # avoids ghost outlines and reduces apparent jitter.
        self._frame_idx += 1
        if self._skip > 0 and self._frame_idx % (self._skip + 1) != 0:
            return

        tensor, scale, pad = _preprocess(frame, self._input_size)
        outputs = self._session.run(None, {self._input_name: tensor})

        detections = _postprocess(
            outputs, scale, pad,
            self._confidence, self._iou_thresh,
            self._min_ball_px, self._max_ball_px, self._max_aspect,
        )
        detections = _filter_visual_candidates(frame, detections)
        if self._homography is not None:
            detections = _warp_detections(detections, self._homography)
            detections = _filter_output_bounds(detections, self._output_size)

        now = time.perf_counter()
        stable = self._tracker.update(detections, now)
        # Emit per-ball velocity (px/s) alongside position so the renderer
        # can extrapolate between detections.  Critical for low-FPS cameras:
        # without it, a 15 Hz camera produces visible stepping on a 60 Hz
        # display because each detection is drawn for ~4 display frames.
        balls: list[dict[str, Any]] = []
        for t in stable:
            x, y = t.render_position(now)
            vx, vy = t.render_velocity()
            balls.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "r": round(t.r * 2, 1),
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
                "capture_ts": capture_ts_f,
                "frame_age_ms": frame_age_ms,
                "latency_ms": (time.time() - capture_ts_f) * 1000.0,
            },
        )

    # ------------------------------------------------------------------
    # Setters
    # ------------------------------------------------------------------

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
