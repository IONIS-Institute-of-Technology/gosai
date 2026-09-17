"""Pose-to-mirror driver (webcam-only).

Maps MediaPipe body, hand and face landmarks from `pose.raw_data` onto a
portrait screen, so the drawn skeleton lines up with the user. The geometry
lives in `gosai_py.geometry.mirror`.

Two modes, chosen with `set_mirror_config({"mode": ...})`:

- `direct` (default): a webcam selfie overlay. Landmarks are normalised by the
  camera frame, optionally flipped, and fitted to the canvas (`contain` or
  `cover`, times `zoom`). No calibration needed.
- `reflection`: the calibrated projection for a physical augmented mirror.
  Landmarks are reflected onto the mirror plane in millimeters, then mapped to
  pixels by an affine `x_px = ax * x_mm + bx`, `y_px = ay * y_mm + by`.

Reflection calibration: the user holds an index fingertip's reflection over a
target dot, the app calls `capture_calibration_sample` with the dot's pixel
position, and after enough targets `solve_calibration` grid-searches
`tilt_deg` x `scale` and fits the affine per axis by least squares. Without a
fitted affine, one is derived from the `x_offset`, `y_offset` and `screen_*_mm`
settings.

Both events are smoothed over time per part. Setting `face_mesh` to false
sends empty face meshes and skips their projection.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar, Literal

import msgspec
import numpy as np
from msgspec import UNSET, Meta, UnsetType

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.geometry import mirror
from gosai_py.geometry.mirror import Array, BodyFrame
from gosai_py.smoothing import lerp

FACE_ANCHOR = 2  # left-eye landmark; the face mesh takes its depth.
RIGHT_HAND_ANCHOR = 15  # left wrist; pose swaps hand keys upstream.
LEFT_HAND_ANCHOR = 16  # right wrist.
LEFT_INDEX = 19  # body-pose index fingertips used for calibration samples.
RIGHT_INDEX = 20

RAW_HISTORY = 24  # recent raw-pose frames kept for sample capture.
SAMPLE_MAX_AGE_S = 2.0
SAMPLE_MIN_FRAMES = 5
SOLVE_MIN_SAMPLES = 4
MIN_FINGERTIP_VISIBILITY = 0.35

PARTS = ("body_pose", "right_hand_pose", "left_hand_pose", "face_mesh")
# How far each part moves toward the new frame per update.
SMOOTHING = {"body_pose": 0.4, "right_hand_pose": 0.6, "left_hand_pose": 0.6, "face_mesh": 0.6}
# Rate for points at or above the top edge, which are usually spurious.
OFFSCREEN_SMOOTHING = 0.01

TILT_COARSE = [t * 2.5 for t in range(17)]  # 0..40 deg
SCALE_COARSE = [0.5 + 0.1 * s for s in range(14)]  # 0.5..1.8
TILT_REFINE_STEP = 0.5
SCALE_REFINE_STEP = 0.02

Affine = Annotated[list[float], Meta(min_length=4, max_length=4, description="[ax, bx, ay, by]")]
Landmark = list[float]


class MirrorSettings(msgspec.Struct, kw_only=True):
    """Every setting of the driver. Distances are millimeters."""

    mode: Literal["direct", "reflection"] = "direct"
    fit: Literal["contain", "cover"] = "contain"
    mirror: bool = True
    affine: Affine | None = None
    face_mesh: bool = True
    x_offset: float = -230.0
    y_offset: float = 100.0
    screen_width_mm: float = 392.85
    screen_height_mm: float = 698.4
    width: float = 1080.0
    height: float = 1920.0
    tilt_deg: float = 17.0
    mirror_offset_mm: float = 0.0
    hfov_deg: float = 60.0
    scale: float = 1.0
    default_distance_mm: float = 1500.0
    zoom: float = 1.0

    def optics(self, tilt_deg: float | None = None, scale: float | None = None) -> mirror.Optics:
        return mirror.Optics(
            hfov_deg=self.hfov_deg,
            tilt_deg=self.tilt_deg if tilt_deg is None else tilt_deg,
            scale=self.scale if scale is None else scale,
            mirror_offset_mm=self.mirror_offset_mm,
            default_distance_mm=self.default_distance_mm,
        )

    def pixel_affine(self) -> tuple[float, float, float, float]:
        if self.affine is not None:
            ax, bx, ay, by = self.affine
            return ax, bx, ay, by
        ax = self.width / self.screen_width_mm
        ay = self.height / self.screen_height_mm
        return ax, -ax * self.x_offset, ay, -ay * self.y_offset


class MirrorSettingsUpdate(msgspec.Struct, kw_only=True):
    """Settings to change; omitted fields keep their value. `affine: null` drops the fit."""

    mode: Literal["direct", "reflection"] | UnsetType = UNSET
    fit: Literal["contain", "cover"] | UnsetType = UNSET
    mirror: bool | UnsetType = UNSET
    affine: Affine | UnsetType | None = UNSET
    face_mesh: bool | UnsetType = UNSET
    x_offset: float | UnsetType = UNSET
    y_offset: float | UnsetType = UNSET
    screen_width_mm: float | UnsetType = UNSET
    screen_height_mm: float | UnsetType = UNSET
    width: float | UnsetType = UNSET
    height: float | UnsetType = UNSET
    tilt_deg: float | UnsetType = UNSET
    mirror_offset_mm: float | UnsetType = UNSET
    hfov_deg: float | UnsetType = UNSET
    scale: float | UnsetType = UNSET
    default_distance_mm: float | UnsetType = UNSET
    zoom: float | UnsetType = UNSET


class MirroredPayload(msgspec.Struct, kw_only=True):
    """Landmarks as `[x, y, depth_mm, visibility]`: pixels for `mirrored_data`,
    mirror-plane millimeters for `projected_data`. Direct mode reports depth 0."""

    body_pose: list[Landmark]
    right_hand_pose: list[Landmark]
    left_hand_pose: list[Landmark]
    face_mesh: list[Landmark]
    body_world_pose: list[Landmark]
    ts: float


class CaptureParams(msgspec.Struct, kw_only=True):
    target: Annotated[list[float], Meta(min_length=2, description="[x_px, y_px]")]
    # Body landmark to use; defaults to the more visible index fingertip.
    landmark: int | None = None


class CaptureResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    samples: int
    landmark: int
    visibility: float


class SolveParams(msgspec.Struct, kw_only=True):
    apply: bool = True


class SolveResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    tilt_deg: float
    scale: float
    affine: list[float]
    residual_px_mean: float
    residual_px_max: float
    residuals_px: list[float]
    samples: int
    applied: bool


class ClearResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    samples: int


@dataclass(frozen=True)
class _Sample:
    target: tuple[float, float]
    landmark: int
    pose: Array
    world: Array
    sizes: Array


@dataclass(frozen=True)
class _Fit:
    tilt_deg: float
    scale: float
    affine: tuple[float, float, float, float]
    errors: Array
    rmse: float


class PoseToMirrorDriver(BaseDriver):
    """Maps MediaPipe landmarks onto an augmented mirror (webcam-only)."""

    name = "pose_to_mirror"
    description = "Map MediaPipe landmarks onto an augmented mirror (webcam-only)."
    events: ClassVar[Mapping[str, Event]] = {
        "mirrored_data": Event(MirroredPayload, "Landmarks in screen pixels, smoothed."),
        "projected_data": Event(
            MirroredPayload, "Reflection mode only: landmarks on the mirror plane in mm."
        ),
    }
    stream_events = ("mirrored_data", "projected_data")
    dependencies = ("pose",)
    subscribed = (("pose", "raw_data"),)
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._lock = threading.Lock()
        self._settings = MirrorSettings()
        self._raw_history: deque[dict[str, Any]] = deque(maxlen=RAW_HISTORY)
        self._samples: list[_Sample] = []
        self._previous: dict[str, Array] = {}

    @action("Change settings and return all of them.")
    def set_mirror_config(self, params: MirrorSettingsUpdate | None) -> MirrorSettings:
        with self._lock:
            if params is not None:
                changes = {
                    field: value
                    for field in params.__struct_fields__
                    if (value := getattr(params, field)) is not UNSET
                }
                self._settings = msgspec.structs.replace(self._settings, **changes)
            return self._settings

    @action("Record recent pose frames for one calibration target.")
    def capture_calibration_sample(self, params: CaptureParams) -> CaptureResult:
        now = time.time()
        with self._lock:
            frames = [
                raw
                for raw in self._raw_history
                if now - raw["ts"] <= SAMPLE_MAX_AGE_S and raw.get("body_pose")
            ]
            if len(frames) < SAMPLE_MIN_FRAMES:
                raise RuntimeError(
                    f"need {SAMPLE_MIN_FRAMES} recent pose frames, have {len(frames)}"
                )
            pose, world, sizes = mirror.stack_frames(frames)
            landmark = params.landmark
            if landmark is None:
                left = _median_visibility(pose, LEFT_INDEX)
                right = _median_visibility(pose, RIGHT_INDEX)
                if max(left, right) < MIN_FINGERTIP_VISIBILITY:
                    raise RuntimeError("no visible index fingertip (raise a hand)")
                landmark = RIGHT_INDEX if right >= left else LEFT_INDEX
            if not 0 <= landmark < mirror.BODY_LANDMARKS:
                raise ValueError(f"landmark must be a body landmark index, got {landmark}")
            visibility = _median_visibility(pose, landmark)
            if visibility < MIN_FINGERTIP_VISIBILITY:
                raise RuntimeError(f"fingertip landmark {landmark} barely visible ({visibility:.2f})")
            target = (params.target[0], params.target[1])
            self._samples.append(_Sample(target, landmark, pose, world, sizes))
            # The next target must not reuse these frames; the stream refills
            # the history within a second.
            self._raw_history.clear()
            return CaptureResult(
                samples=len(self._samples), landmark=landmark, visibility=round(visibility, 2)
            )

    @action("Fit tilt, scale and the pixel affine to the captured samples.")
    def solve_calibration(self, params: SolveParams | None) -> SolveResult:
        apply = True if params is None else params.apply
        with self._lock:
            samples = list(self._samples)
            settings = self._settings
        if len(samples) < SOLVE_MIN_SAMPLES:
            raise RuntimeError(f"need at least {SOLVE_MIN_SAMPLES} samples, have {len(samples)}")

        solver = _Solver(samples, settings)
        best = solver.best(TILT_COARSE, SCALE_COARSE)
        if best is None:
            raise RuntimeError("could not project samples (poses unusable)")
        # Two refinement passes of +-1 coarse cell; the second recenters.
        for _ in range(2):
            tilts = [best.tilt_deg + TILT_REFINE_STEP * i for i in range(-5, 6)]
            scales = [max(best.scale + SCALE_REFINE_STEP * i, 0.05) for i in range(-5, 6)]
            best = solver.best(tilts, scales, best) or best

        result = SolveResult(
            tilt_deg=round(best.tilt_deg, 2),
            scale=round(best.scale, 3),
            affine=[round(v, 5) for v in best.affine],
            residual_px_mean=round(float(best.errors.mean()), 1),
            residual_px_max=round(float(best.errors.max()), 1),
            residuals_px=[round(float(e), 1) for e in best.errors],
            samples=len(samples),
            applied=apply,
        )
        if apply:
            with self._lock:
                self._settings = msgspec.structs.replace(
                    self._settings, tilt_deg=result.tilt_deg, scale=result.scale, affine=result.affine
                )
        self.log(
            "info",
            f"calibration solved: tilt={result.tilt_deg} scale={result.scale} "
            f"residual={result.residual_px_mean}px mean / {result.residual_px_max}px max "
            f"({len(samples)} samples, applied={apply})",
        )
        return result

    @action("Drop all captured calibration samples.")
    def clear_calibration_samples(self) -> ClearResult:
        with self._lock:
            self._samples.clear()
        return ClearResult(samples=0)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        body_raw = data.get("body_pose")
        if not isinstance(body_raw, list) or not body_raw:
            return
        frame_w = float(data.get("frame_width") or 1280.0)
        frame_h = float(data.get("frame_height") or 720.0)
        body_world = data.get("body_world_pose") or []
        with self._lock:
            settings = self._settings
            self._raw_history.append(
                {
                    "body_pose": body_raw,
                    "body_world_pose": body_world,
                    "frame_width": frame_w,
                    "frame_height": frame_h,
                    "ts": float(data.get("ts") or time.time()),
                }
            )

        face_raw = (data.get("_face_mesh") or data.get("face_mesh")) if settings.face_mesh else None
        parts = {
            "body_pose": mirror.landmarks(body_raw),
            "right_hand_pose": mirror.landmarks(data.get("right_hand_pose")),
            "left_hand_pose": mirror.landmarks(data.get("left_hand_pose")),
            "face_mesh": mirror.landmarks(face_raw),
        }
        if settings.mode == "direct":
            pixels = self._direct(settings, parts, frame_w, frame_h)
        else:
            projected = self._reflect(settings, parts, mirror.landmarks(body_world), frame_w, frame_h)
            self.emit("projected_data", _payload(projected, body_world))
            ax, bx, ay, by = settings.pixel_affine()
            pixels = {
                name: np.column_stack([ax * mm[:, 0] + bx, ay * mm[:, 1] + by, mm[:, 2:]])
                for name, mm in projected.items()
            }
        self.emit("mirrored_data", _payload(self._smooth(pixels), body_world))

    def _direct(
        self, settings: MirrorSettings, parts: dict[str, Array], frame_w: float, frame_h: float
    ) -> dict[str, Array]:
        """Fit the camera frame to the canvas, keeping the aspect ratio."""
        width_ratio = settings.width / max(frame_w, 1.0)
        height_ratio = settings.height / max(frame_h, 1.0)
        ratio = max(width_ratio, height_ratio) if settings.fit == "cover" else min(width_ratio, height_ratio)
        scale = ratio * max(settings.zoom, 0.1)
        sx, sy = frame_w * scale, frame_h * scale
        ox, oy = (settings.width - sx) / 2.0, (settings.height - sy) / 2.0
        out: dict[str, Array] = {}
        for name, points in parts.items():
            nx = points[:, 0] / frame_w
            if settings.mirror:
                nx = 1.0 - nx
            visibility = np.where(np.isnan(points[:, 2]), 1.0, points[:, 2])
            out[name] = np.column_stack(
                [nx * sx + ox, points[:, 1] / frame_h * sy + oy, np.zeros(len(points)), visibility]
            )
        return out

    def _reflect(
        self,
        settings: MirrorSettings,
        parts: dict[str, Array],
        world: Array,
        frame_w: float,
        frame_h: float,
    ) -> dict[str, Array]:
        optics = settings.optics()
        frame = BodyFrame.build(parts["body_pose"], world, frame_w, frame_h, optics)
        body = mirror.project_part(frame, parts["body_pose"], optics, None, own_depths=True)

        def anchor(index: int) -> Array | None:
            return body[index] if index < len(body) else None

        return {
            "body_pose": body,
            "right_hand_pose": mirror.project_part(
                frame, parts["right_hand_pose"], optics, anchor(RIGHT_HAND_ANCHOR), own_depths=False
            ),
            "left_hand_pose": mirror.project_part(
                frame, parts["left_hand_pose"], optics, anchor(LEFT_HAND_ANCHOR), own_depths=False
            ),
            "face_mesh": mirror.project_part(
                frame, parts["face_mesh"], optics, anchor(FACE_ANCHOR), own_depths=False
            ),
        }

    def _smooth(self, parts: dict[str, Array]) -> dict[str, Array]:
        """Move each part toward the new frame from the previous smoothed one."""
        out: dict[str, Array] = {}
        for name, points in parts.items():
            previous = self._previous.get(name)
            if previous is not None and previous.shape == points.shape:
                rate = np.where(points[:, 1] > 0, SMOOTHING[name], OFFSCREEN_SMOOTHING)[:, None]
                points = points.copy()
                points[:, :2] = lerp(previous[:, :2], points[:, :2], rate)
            out[name] = points
        self._previous = out
        return out


def _payload(parts: dict[str, Array], body_world: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {name: parts[name].tolist() for name in PARTS}
    payload["body_world_pose"] = body_world
    payload["ts"] = time.time()
    return payload


def _median_visibility(pose: Array, index: int) -> float:
    values = pose[:, index, 2]
    values = values[np.isfinite(values)]
    return float(np.median(values)) if values.size else 0.0


def _rank(fit: _Fit) -> tuple[float, float]:
    """Lower is better. Fits equal to a micropixel prefer the scale closest to 1,
    since scale is unobservable when every joint sits at one depth."""
    return round(fit.rmse, 6), abs(fit.scale - 1.0)


class _Solver:
    """Evaluates (tilt, scale) candidates over every captured frame at once."""

    def __init__(self, samples: list[_Sample], settings: MirrorSettings) -> None:
        self._settings = settings
        self._pose = np.concatenate([s.pose for s in samples])
        self._world = np.concatenate([s.world for s in samples])
        self._sizes = np.concatenate([s.sizes for s in samples])
        self._index = np.concatenate([np.full(len(s.pose), s.landmark) for s in samples])
        self._bounds = np.cumsum([0, *(len(s.pose) for s in samples)])
        self._targets = np.array([s.target for s in samples])

    def best(self, tilts: list[float], scales: list[float], best: _Fit | None = None) -> _Fit | None:
        for tilt in tilts:
            for scale in scales:
                fit = self._evaluate(tilt, scale)
                if fit is not None and (best is None or _rank(fit) < _rank(best)):
                    best = fit
        return best

    def _evaluate(self, tilt_deg: float, scale: float) -> _Fit | None:
        optics = self._settings.optics(tilt_deg, scale)
        located = mirror.reflect_landmark(self._pose, self._world, self._sizes, self._index, optics)
        points: list[Array] = []
        targets: list[Array] = []
        for i, (start, end) in enumerate(zip(self._bounds[:-1], self._bounds[1:], strict=True)):
            rows = located[start:end]
            rows = rows[np.isfinite(rows).all(axis=1)]
            if len(rows) >= SAMPLE_MIN_FRAMES:
                points.append(np.median(rows, axis=0))
                targets.append(self._targets[i])
        if len(points) < SOLVE_MIN_SAMPLES:
            return None
        pts, tgt = np.array(points), np.array(targets)
        fit_x = mirror.fit_axis(pts[:, 0], tgt[:, 0])
        fit_y = mirror.fit_axis(pts[:, 1], tgt[:, 1])
        if fit_x is None or fit_y is None:
            return None
        (ax, bx), (ay, by) = fit_x, fit_y
        # Reject collapsed axes and vertical flips (only a misconfigured camera
        # rotation produces those). Either horizontal sign is valid: it depends
        # on which side of the mirror the camera looks from.
        if abs(ax) < 1e-9 or ay <= 0:
            return None
        predicted = np.column_stack([ax * pts[:, 0] + bx, ay * pts[:, 1] + by])
        errors = np.linalg.norm(predicted - tgt, axis=1)
        return _Fit(tilt_deg, scale, (ax, bx, ay, by), errors, float(np.sqrt(np.mean(errors**2))))

