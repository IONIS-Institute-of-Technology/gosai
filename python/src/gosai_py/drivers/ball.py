"""Ball detector using YOLOv8n via ONNX Runtime.

Runs a YOLOv8n model exported to ONNX for low-latency inference (no
PyTorch at runtime).  The camera frame is warped into display space via
the calibration homography *before* inference so that detections are
directly in the 1920x1080 reference coordinate system.

Detection is class-agnostic: all 80 COCO classes fire with a very low
confidence floor, and candidates are filtered purely by bounding-box
geometry (small + roughly square = ball).  An EMA tracker smooths
positions across frames and suppresses single-frame noise.

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
- ``set_smoothing(0..1)``
- ``set_cuda_device(id)``           — NVIDIA GPU index (default 0)
- ``set_background(jpeg_base64)``  — no-op, backward compat

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
) -> list[str | tuple[str, dict[str, Any]]]:
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
        return [cpu] if cpu in available else available

    if mode == "coreml":
        out: list[str | tuple[str, dict[str, Any]]] = []
        if coreml in available:
            out.append(coreml)
        if cpu in available:
            out.append(cpu)
        return out or available

    if mode == "dml":
        out = []
        if dml in available:
            out.append(dml)
        if cpu in available:
            out.append(cpu)
        return out or available

    if mode == "cuda":
        out = []
        if cuda[0] in available:
            out.append(cuda)
        if cpu in available:
            out.append(cpu)
        return out or available

    # auto
    if sys.platform == "darwin":
        out = []
        if coreml in available:
            out.append(coreml)
        if cpu in available:
            out.append(cpu)
        return out or available

    out = []
    if cuda[0] in available:
        out.append(cuda)
    if trt in available:
        out.append(trt)
    if cpu in available:
        out.append(cpu)
    return out or available


def _create_ort_session(
    onnx_path: Path,
    *,
    cuda_device_id: int,
    log_fn: Any,
) -> tuple[Any, list[str]]:
    import onnxruntime as ort  # type: ignore[import-not-found]

    available = ort.get_available_providers()
    providers = _build_ort_providers(
        available,
        mode=_ort_device_mode(),
        cuda_device_id=cuda_device_id,
    )
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        str(onnx_path),
        sess_options=opts,
        providers=providers,
    )
    active = session.get_providers()
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
    import numpy as np  # type: ignore[import-not-found]

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


# ── EMA ball tracker ─────────────────────────────────────────────────────

class _TrackedBall:
    __slots__ = ("x", "y", "r", "age", "missed")

    def __init__(self, x: float, y: float, r: float) -> None:
        self.x = x
        self.y = y
        self.r = r
        self.age = 1
        self.missed = 0

    def update(self, x: float, y: float, r: float, alpha: float) -> None:
        self.x += alpha * (x - self.x)
        self.y += alpha * (y - self.y)
        self.r += alpha * (r - self.r)
        self.age += 1
        self.missed = 0


class _BallTracker:
    """Nearest-neighbour tracker with EMA smoothing."""

    def __init__(self, alpha: float = 0.3, max_miss: int = 4,
                 match_radius: float = 80.0, min_age: int = 2) -> None:
        self.alpha = alpha
        self.max_miss = max_miss
        self.match_radius = match_radius
        self.min_age = min_age
        self.tracks: list[_TrackedBall] = []

    def update(self, detections: list[tuple[float, float, float]]) -> list[_TrackedBall]:
        used_det: set[int] = set()
        used_trk: set[int] = set()

        pairs: list[tuple[float, int, int]] = []
        for ti, trk in enumerate(self.tracks):
            for di, (dx, dy, _dr) in enumerate(detections):
                dist = math.hypot(dx - trk.x, dy - trk.y)
                if dist < self.match_radius:
                    pairs.append((dist, ti, di))
        pairs.sort()
        for _dist, ti, di in pairs:
            if ti in used_trk or di in used_det:
                continue
            dx, dy, dr = detections[di]
            self.tracks[ti].update(dx, dy, dr, self.alpha)
            used_trk.add(ti)
            used_det.add(di)

        for di, (dx, dy, dr) in enumerate(detections):
            if di not in used_det:
                self.tracks.append(_TrackedBall(dx, dy, dr))

        for ti, trk in enumerate(self.tracks):
            if ti not in used_trk:
                trk.missed += 1
        self.tracks = [t for t in self.tracks if t.missed <= self.max_miss]

        return [t for t in self.tracks if t.age >= self.min_age]

    def current(self) -> list[_TrackedBall]:
        """Return the last known stable positions (for skip frames)."""
        return [t for t in self.tracks if t.age >= self.min_age]


# ── Driver ───────────────────────────────────────────────────────────────

class BallDriver(BaseProcessor):
    name: ClassVar[str] = "ball"
    description: ClassVar[str] = "YOLO-based ball detector (ONNX Runtime)."
    events: ClassVar[tuple[str, ...]] = ("balls", "fps")
    actions: ClassVar[tuple[str, ...]] = (
        "set_background",
        "set_homography",
        "set_output_size",
        "set_confidence",
        "set_max_ball_px",
        "set_min_ball_px",
        "set_smoothing",
        "set_cuda_device",
    )
    dependencies: ClassVar[tuple[str, ...]] = ("camera",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("camera", "color"),)
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
        self._tracker = _BallTracker(alpha=0.3, max_miss=4, min_age=2)
        self._frame_idx = 0
        self._skip = 1  # process every 2nd frame
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
            import onnxruntime  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"onnxruntime not installed: {exc}")
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
        except Exception as exc:
            self.log("error", f"failed to create ONNX session: {exc!r}")
            self._session = None

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_background":
            return {"ok": True, "note": "background not used by YOLO detector"}
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
        if action == "set_smoothing":
            self._tracker.alpha = max(0.0, min(1.0, float(data)))
            return {"smoothing": self._tracker.alpha}
        if action == "set_cuda_device":
            self._cuda_device_id = max(0, int(data))
            self._session = None
            self._load_session()
            return {"cuda_device_id": self._cuda_device_id}
        # Legacy actions.
        if action in ("set_min_area", "set_threshold", "set_max_area",
                       "set_min_circularity", "set_hand_landmarks",
                       "set_hand_radius", "set_persistence", "set_classes"):
            return {"ok": True, "note": f"{action} not used by YOLO detector"}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Detection pipeline
    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict) or self._session is None:
            return
        encoded = data.get("jpeg_base64")
        if not isinstance(encoded, str):
            return

        start = time.perf_counter()

        # Frame skipping: only run YOLO every (skip+1) frames.
        self._frame_idx += 1
        if self._frame_idx % (self._skip + 1) != 0:
            stable = self._tracker.current()
            balls = [
                {"x": int(t.x), "y": int(t.y), "r": round(t.r * 2, 1)}
                for t in stable
            ]
            self.emit("balls", {"balls": balls, "count": len(balls), "ts": time.time()})
            return

        try:
            import cv2  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"opencv required: {exc}")
            return

        from gosai_py.serialization import jpeg_base64_to_frame

        frame = jpeg_base64_to_frame(encoded)
        if frame is None:
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

        stable = self._tracker.update(detections)
        balls: list[dict[str, Any]] = [
            {"x": int(t.x), "y": int(t.y), "r": round(t.r * 2, 1)}
            for t in stable
        ]

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
