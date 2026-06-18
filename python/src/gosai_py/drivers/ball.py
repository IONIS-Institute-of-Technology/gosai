"""Ball detector using YOLOv8n via ONNX Runtime.

Runs a YOLOv8n model exported to ONNX for low-latency inference (no
PyTorch at runtime).  The camera frame is warped into display space via
the calibration homography *before* inference so that detections are
directly in the 1920x1080 reference coordinate system.

Detection is class-agnostic: all 80 COCO classes fire with a very low
confidence floor, and candidates are filtered purely by bounding-box
geometry (small + roughly square = ball).  Positions are smoothed with
a One-Euro filter (Casiez et al., CHI 2012) — strong smoothing when a
ball is stationary (kills jitter), weak smoothing when it moves fast
(kills lag).  Track association uses velocity prediction so a fast
ball stays attached to its track instead of spawning a phantom.

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
- ``GOSAI_ORT_DEVICE`` — ``cuda``, ``cpu``, ``coreml`` (macOS), ``dml`` (Windows)
- ``GOSAI_CUDA_DEVICE_ID`` — CUDA device index when using NVIDIA (default 0)
"""

from __future__ import annotations

import math
import os
import sys
import time
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

YOLO_ONNX_FILENAME = "yolov8n.onnx"
YOLO_ONNX_URL = (
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.onnx"
)
MODEL_INPUT_SIZE = 640
ProviderSpec = str | tuple[str, dict[str, Any]]


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


def _cuda_device_id() -> int:
    raw = os.environ.get("GOSAI_CUDA_DEVICE_ID", "0")
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _ort_device_mode() -> str:
    """``cuda`` | ``cpu`` | ``coreml`` | ``dml`` | ``auto``."""
    mode = os.environ.get("GOSAI_ORT_DEVICE", "auto").strip().lower()
    if mode in ("cuda", "cpu", "coreml", "dml", "auto"):
        return mode
    return "auto"


def _build_ort_providers(
    available: list[str],
    *,
    mode: str,
    cuda_device_id: int,
) -> list[ProviderSpec]:
    """Pick execution providers so NVIDIA CUDA wins on dual-GPU PCs.

    The default ``onnxruntime`` wheel is CPU-only.  Linux/Windows installs
    use ``onnxruntime-gpu`` (see ``pyproject.toml``) so
    ``CUDAExecutionProvider`` is available for the discrete NVIDIA GPU.

    We intentionally avoid OpenVINO / DirectML in ``auto`` mode: on
    Intel + NVIDIA machines they often bind to the Intel iGPU and are
    slower than CUDA on the NVIDIA card.
    """
    cuda_opts: dict[str, Any] = {"device_id": cuda_device_id}
    cuda = ("CUDAExecutionProvider", cuda_opts)
    cpu = "CPUExecutionProvider"
    coreml = "CoreMLExecutionProvider"
    dml = "DirectMLExecutionProvider"
    trt = "TensorrtExecutionProvider"

    if mode == "cpu":
        if cpu not in available:
            raise RuntimeError(f"CPUExecutionProvider unavailable; available providers: {available}")
        return [cpu]

    if mode == "coreml":
        if coreml not in available:
            raise RuntimeError(f"CoreMLExecutionProvider unavailable; available providers: {available}")
        return [coreml]

    if mode == "dml":
        if dml not in available:
            raise RuntimeError(
                f"DirectMLExecutionProvider unavailable; available providers: {available}"
            )
        return [dml]

    if mode == "cuda":
        if cuda[0] not in available:
            raise RuntimeError(
                f"CUDAExecutionProvider unavailable; available providers: {available}"
            )
        return [cuda]

    # auto
    if sys.platform == "darwin":
        if coreml not in available:
            raise RuntimeError(f"CoreMLExecutionProvider unavailable; available providers: {available}")
        return [coreml]

    if sys.platform.startswith(("linux", "win32")):
        if cuda[0] not in available:
            raise RuntimeError(
                f"CUDAExecutionProvider unavailable; available providers: {available}"
            )
        return [cuda]

    if trt in available:
        return [trt]
    if cpu in available:
        return [cpu]
    raise RuntimeError(f"no supported ONNX provider available; available providers: {available}")


def _create_ort_session(
    onnx_path: Path,
    *,
    cuda_device_id: int,
    log_fn: Any,
) -> tuple[Any, list[str]]:
    import onnxruntime as ort  # type: ignore[import-not-found]

    mode = _ort_device_mode()
    available = ort.get_available_providers()
    providers = _build_ort_providers(
        available,
        mode=mode,
        cuda_device_id=cuda_device_id,
    )
    wants_cuda = any(
        (p[0] if isinstance(p, tuple) else p) == "CUDAExecutionProvider"
        for p in providers
    )
    if wants_cuda and hasattr(ort, "preload_dlls"):
        try:
            # Allows `onnxruntime-gpu[cuda,cudnn]` / NVIDIA Python packages to
            # provide CUDA 12 + cuDNN 9 without relying on system LD paths.
            ort.preload_dlls(cuda=True, cudnn=True, msvc=False, directory=None)
        except TypeError:
            # Older ORT builds may not expose the newer keyword shape.
            try:
                ort.preload_dlls()
            except Exception as exc:
                log_fn("warn", f"ONNX CUDA preload failed: {exc!r}")
        except Exception as exc:
            log_fn("warn", f"ONNX CUDA preload failed: {exc!r}")
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        str(onnx_path),
        sess_options=opts,
        providers=providers,
    )
    active = session.get_providers()
    if wants_cuda and "CUDAExecutionProvider" not in active:
        raise RuntimeError(
            "CUDAExecutionProvider was requested but ONNX Runtime activated "
            f"{active}. Install CUDA 12.x + cuDNN 9.x runtime libraries, or "
            "install onnxruntime-gpu[cuda,cudnn] and ensure they can be preloaded."
        )
    log_fn(
        "info",
        f"ONNX session ready ({onnx_path.name}, active={active[0] if active else 'none'}, "
        f"available={available}, requested={[p[0] if isinstance(p, tuple) else p for p in providers]})",
    )
    return session, active


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
) -> list[tuple[float, float, float]]:
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

    results: list[tuple[float, float, float]] = []
    for i in np.array(indices).flatten():
        cx, cy, w, h = boxes_cxcywh[i]
        side = max(w, h)
        if side < min_px or side > max_px:
            continue
        aspect = max(w, h) / max(min(w, h), 1.0)
        if aspect > max_aspect:
            continue
        r = (w + h) / 4.0
        results.append((float(cx), float(cy), float(r)))
    return results


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
    __slots__ = ("age", "fr", "fx", "fy", "missed", "r", "x", "y")

    def __init__(self, x: float, y: float, r: float, t: float,
                 min_cutoff: float, beta: float) -> None:
        self.fx = _OneEuro(min_cutoff=min_cutoff, beta=beta)
        self.fy = _OneEuro(min_cutoff=min_cutoff, beta=beta)
        # Radius changes slowly -- smooth harder.
        self.fr = _OneEuro(min_cutoff=min_cutoff * 0.5, beta=beta * 0.5)
        self.x = self.fx(x, t)
        self.y = self.fy(y, t)
        self.r = self.fr(r, t)
        self.age = 1
        self.missed = 0

    def update(self, x: float, y: float, r: float, t: float) -> None:
        self.x = self.fx(x, t)
        self.y = self.fy(y, t)
        self.r = self.fr(r, t)
        self.age += 1
        self.missed = 0

    def predict(self, dt: float) -> tuple[float, float]:
        """Linear extrapolation using smoothed velocity."""
        return self.x + self.fx.velocity * dt, self.y + self.fy.velocity * dt


class _BallTracker:
    """Velocity-aware tracker with One-Euro smoothing.

    Tracks are matched against detections using the **predicted** next
    position (current filtered position + smoothed velocity * dt), so a
    fast-moving ball stays attached to its existing track instead of
    spawning a phantom duplicate.

    Stale tracks are kept alive for ``max_miss`` frames so a single
    YOLO miss doesn't kill the smoothing state, but they are **not
    rendered** during those frames -- this is what eliminates the
    visible trail of phantom outlines.
    """

    def __init__(self, min_cutoff: float = 1.0, beta: float = 0.05,
                 max_miss: int = 1, match_radius: float = 140.0,
                 min_age: int = 1) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.max_miss = max_miss
        self.match_radius = match_radius
        self.min_age = min_age
        self.tracks: list[_TrackedBall] = []
        self._t_prev: float | None = None

    def update(self, detections: list[tuple[float, float, float]],
               t: float) -> list[_TrackedBall]:
        dt = (t - self._t_prev) if self._t_prev is not None else 0.0
        self._t_prev = t

        used_det: set[int] = set()
        used_trk: set[int] = set()

        # Velocity-aware matching: compare detections to predicted positions.
        pairs: list[tuple[float, int, int]] = []
        for ti, trk in enumerate(self.tracks):
            px, py = trk.predict(dt) if dt > 0 else (trk.x, trk.y)
            for di, (dx, dy, _dr) in enumerate(detections):
                dist = math.hypot(dx - px, dy - py)
                if dist < self.match_radius:
                    pairs.append((dist, ti, di))
        pairs.sort()
        for _dist, ti, di in pairs:
            if ti in used_trk or di in used_det:
                continue
            dx, dy, dr = detections[di]
            self.tracks[ti].update(dx, dy, dr, t)
            used_trk.add(ti)
            used_det.add(di)

        for di, (dx, dy, dr) in enumerate(detections):
            if di not in used_det:
                self.tracks.append(
                    _TrackedBall(dx, dy, dr, t, self.min_cutoff, self.beta),
                )

        for ti, trk in enumerate(self.tracks):
            if ti not in used_trk:
                trk.missed += 1
        self.tracks = [t for t in self.tracks if t.missed <= self.max_miss]

        return self._renderable()

    def current(self) -> list[_TrackedBall]:
        return self._renderable()

    def _renderable(self) -> list[_TrackedBall]:
        # Only emit tracks updated this frame: no phantom outlines.
        return [
            t for t in self.tracks
            if t.age >= self.min_age and t.missed == 0
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
        self._confidence = 0.05
        self._iou_thresh = 0.5
        self._min_ball_px = 10.0
        self._max_ball_px = 100.0
        self._max_aspect = 1.8
        self._frame_times: deque[float] = deque(maxlen=50)
        self._tracker = _BallTracker(min_cutoff=1.0, beta=0.05,
                                     max_miss=1, min_age=1,
                                     match_radius=140.0)
        self._frame_idx = 0
        self._skip = 0  # 0 = process every frame; raise on slow hardware
        self._cuda_device_id = _cuda_device_id()
        self._onnx_path: Path | None = None

    def pre_run(self) -> None:
        super().pre_run()
        self._load_session()

    def _load_session(self) -> None:
        if self._onnx_path is None:
            self._onnx_path = _ensure_onnx(self.log)
        onnx_path = self._onnx_path
        if onnx_path is None:
            self.log("error", "ball: ONNX model unavailable, driver inactive")
            self._session = None
            return

        try:
            self._session, _active = _create_ort_session(
                onnx_path,
                cuda_device_id=self._cuda_device_id,
                log_fn=self.log,
            )
            inp = self._session.get_inputs()[0]
            self._input_name = inp.name
            self._input_size = inp.shape[2] if isinstance(inp.shape[2], int) else MODEL_INPUT_SIZE
            self.start_latest_worker()
        except Exception as exc:
            self.log("error", f"failed to create ONNX session: {exc!r}")
            self._session = None

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
            self._tracker.min_cutoff = max(0.01, float(data))
            return {"min_cutoff": self._tracker.min_cutoff}
        if action == "set_beta":
            self._tracker.beta = max(0.0, float(data))
            return {"beta": self._tracker.beta}
        if action == "set_frame_skip":
            self._skip = max(0, int(data))
            return {"frame_skip": self._skip}
        if action == "set_cuda_device":
            self._cuda_device_id = max(0, int(data))
            self._session = None
            self._load_session()
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

        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv required: {exc}")
            return

        if self._homography is not None:
            frame = cv2.warpPerspective(
                frame, self._homography, self._output_size,
                flags=cv2.INTER_LINEAR,
            )

        tensor, scale, pad = _preprocess(frame, self._input_size)
        outputs = self._session.run(None, {self._input_name: tensor})

        detections = _postprocess(
            outputs, scale, pad,
            self._confidence, self._iou_thresh,
            self._min_ball_px, self._max_ball_px, self._max_aspect,
        )

        now = time.perf_counter()
        stable = self._tracker.update(detections, now)
        # Emit per-ball velocity (px/s) alongside position so the renderer
        # can extrapolate between detections.  Critical for low-FPS cameras:
        # without it, a 15 Hz camera produces visible stepping on a 60 Hz
        # display because each detection is drawn for ~4 display frames.
        balls: list[dict[str, Any]] = [
            {
                "x": int(t.x),
                "y": int(t.y),
                "r": round(t.r * 2, 1),
                "vx": round(t.fx.velocity, 1),
                "vy": round(t.fy.velocity, 1),
            }
            for t in stable
        ]

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
