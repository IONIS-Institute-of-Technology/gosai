"""Viewer-dependent projection onto a screen behind a flat mirror, and its calibration.

The rig is a flat mirror with a screen parallel to it, `gap_mm` behind the
reflecting surface. Its pose relative to the camera is a rotation and the 3D
position of the canvas center, six numbers in total. Camera coordinates are
those of `camera_model`: x right and y down in the image, z forward, in mm.

The screen frame has `u` along pixel x (the viewer's right), `v` along pixel y
(down) and `w = u x v` pointing into the mirror, away from the viewer. A camera
facing the viewer from the mirror therefore sees `u` close to its own -x and
`w` close to its own -z. The columns of `Rig.rotation_matrix` are `u, v, w` in
camera coordinates.

For a body point P seen from the eye E, the mirror shows P at its virtual image

    P' = P - 2 * (w . P - d) * w        with the mirror plane  w . X = d

and the drawing belongs where the sight line from E to P' crosses the screen
plane `w . X = d + gap`. Rays are straight: glass refraction is ignored, and
`gap_mm` is an effective separation.

`fit_rig` recovers the six pose numbers from correspondences. Each one says
that, seen from a known eye position, the reflection of a known 3D point lined
up with a known screen position. Screen size, gap, lens and the metric scale of
eye and point are fixed inputs, never fitted here.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import cv2
import numpy as np
from numpy.typing import ArrayLike, NDArray

type Array = NDArray[np.float64]

# A sight line nearly parallel to the screen has no usable crossing.
MIN_APPROACH_MM = 1e-6
MIN_CORRESPONDENCES = 6

# Starting tilts about the screen's horizontal axis. The fit converges from far
# away, so a coarse sweep is enough to escape a wrong local minimum.
START_TILTS_DEG = (0.0, -15.0, 15.0, -30.0, 30.0)
LM_ITERATIONS = 60
JACOBIAN_STEP = 1e-5

# Physical limits of a plausible rig, used to reject fits.
MAX_CAMERA_TO_MIRROR_MM = 1000.0
MAX_CAMERA_TO_CENTER_MM = 3000.0
MIN_FACING = 0.3  # cosine between the camera axis and the mirror's outward normal

# Assumed per-axis alignment noise (mm on the screen) when the residuals are
# smaller than that. A fit to few points can look better than it is.
NOISE_FLOOR_MM = 2.0


@dataclass(frozen=True)
class Rig:
    """Pose and size of the canvas behind the mirror, in camera coordinates.

    `width_mm` x `height_mm` is the physical size of the area the canvas pixels
    cover, centered on `center_mm`. `rotation` is a rotation vector.
    """

    rotation: tuple[float, float, float]
    center_mm: tuple[float, float, float]
    width_mm: float
    height_mm: float
    gap_mm: float = 0.0

    @property
    def rotation_matrix(self) -> Array:
        matrix, _ = cv2.Rodrigues(np.asarray(self.rotation, dtype=np.float64))
        return np.asarray(matrix, dtype=np.float64)

    @property
    def tilt_deg(self) -> float:
        """Pitch of the camera axis against the mirror normal, positive when it looks down."""
        w = self.rotation_matrix[:, 2]
        v = self.rotation_matrix[:, 1]
        # The camera axis is +z, so its components along v and -w are v_z and -w_z.
        return math.degrees(math.atan2(v[2], -w[2]))

    @classmethod
    def nominal(
        cls,
        width_mm: float,
        height_mm: float,
        gap_mm: float = 0.0,
        camera_in_screen_mm: Sequence[float] | None = None,
        tilt_deg: float = 0.0,
    ) -> Rig:
        """A rig from rough mounting numbers: the fit's starting point and the uncalibrated default.

        `camera_in_screen_mm` is the camera position in the screen frame (u, v, w)
        relative to the canvas center. It defaults to just above the top edge.
        `tilt_deg` pitches the camera down about the screen's horizontal axis.
        """
        camera = (
            np.array([0.0, -(height_mm / 2.0 + 20.0), -gap_mm])
            if camera_in_screen_mm is None
            else np.asarray(camera_in_screen_mm, dtype=np.float64)
        )
        rotation = _nominal_rotation(tilt_deg)
        rotvec, _ = cv2.Rodrigues(rotation)
        center = -rotation @ camera
        return cls(_triple(rotvec.ravel()), _triple(center), width_mm, height_mm, gap_mm)


def _triple(values: ArrayLike) -> tuple[float, float, float]:
    x, y, z = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y, z


def _nominal_rotation(tilt_deg: float) -> Array:
    """Screen axes in camera coordinates for a camera facing out of the mirror."""
    theta = math.radians(tilt_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    u = np.array([-1.0, 0.0, 0.0])
    # Pitching the camera down by theta lifts the screen's down axis toward +z.
    v = np.array([0.0, cos_t, sin_t])
    w = np.cross(u, v)
    return np.column_stack([u, v, w])


def _screen_hit(rotation: Array, center: Array, gap_mm: float, eye: Array, points: Array) -> Array:
    """Screen-frame mm `(u, v)` where each eye-to-virtual-image line meets the screen.

    `eye` and `points` broadcast over (..., 3). NaN where the eye or the point
    is behind the mirror, or the line doesn't approach the screen.
    """
    u, v, w = rotation[:, 0], rotation[:, 1], rotation[:, 2]
    screen_d = float(w @ center)
    mirror_d = screen_d - gap_mm
    eye_side = eye @ w - mirror_d
    point_side = points @ w - mirror_d
    virtual = points - 2.0 * point_side[..., None] * w
    direction = virtual - eye
    approach = direction @ w
    with np.errstate(divide="ignore", invalid="ignore"):
        t = (screen_d - eye @ w) / approach
    hit = eye + t[..., None] * direction - center
    out = np.stack([hit @ u, hit @ v], axis=-1)
    invalid = (eye_side >= 0.0) | (point_side >= 0.0) | (approach < MIN_APPROACH_MM)
    out[np.broadcast_to(invalid, out.shape[:-1])] = np.nan
    return out


def project_mm(rig: Rig, eye: ArrayLike, points: ArrayLike) -> Array:
    """Canvas-centered screen mm `(u, v)` of (..., 3) camera-frame points seen from `eye`."""
    return _screen_hit(
        rig.rotation_matrix,
        np.asarray(rig.center_mm, dtype=np.float64),
        rig.gap_mm,
        np.asarray(eye, dtype=np.float64),
        np.asarray(points, dtype=np.float64),
    )


def mm_to_pixels(rig: Rig, mm: ArrayLike, width_px: float, height_px: float) -> Array:
    values = np.asarray(mm, dtype=np.float64)
    x = (values[..., 0] / rig.width_mm + 0.5) * width_px
    y = (values[..., 1] / rig.height_mm + 0.5) * height_px
    return np.stack([x, y], axis=-1)


def pixels_to_mm(rig: Rig, pixels: ArrayLike, width_px: float, height_px: float) -> Array:
    values = np.asarray(pixels, dtype=np.float64)
    u = (values[..., 0] / width_px - 0.5) * rig.width_mm
    v = (values[..., 1] / height_px - 0.5) * rig.height_mm
    return np.stack([u, v], axis=-1)


def project(
    rig: Rig, eye: ArrayLike, points: ArrayLike, width_px: float, height_px: float
) -> Array:
    """Canvas pixels of (..., 3) camera-frame points seen from `eye`, NaN where undefined."""
    return mm_to_pixels(rig, project_mm(rig, eye, points), width_px, height_px)


def mirror_distance(rig: Rig, points: ArrayLike) -> Array:
    """Distance (mm) of camera-frame points in front of the mirror, negative behind it."""
    w = rig.rotation_matrix[:, 2]
    mirror_d = float(w @ np.asarray(rig.center_mm)) - rig.gap_mm
    return mirror_d - np.asarray(points, dtype=np.float64) @ w


@dataclass(frozen=True)
class Correspondence:
    """One alignment: from `eye`, the reflection of `point` covered `target_mm` on the screen."""

    eye: tuple[float, float, float]
    point: tuple[float, float, float]
    target_mm: tuple[float, float]


@dataclass(frozen=True)
class RigFit:
    rig: Rig
    residuals_mm: Array  # (N,) distance on the screen between prediction and target
    rms_mm: float
    # One-sigma error (mm on the screen) the fit's own uncertainty adds when
    # projecting a standing viewer: the worst over near and far probe poses.
    # Large values mean the correspondences don't pin the rig down.
    predicted_error_mm: float
    condition: float
    starts_converged: int = field(default=1)


class RigFitError(RuntimeError):
    """The correspondences admit no physically valid rig."""


def fit_rig(
    correspondences: Sequence[Correspondence],
    width_mm: float,
    height_mm: float,
    gap_mm: float = 0.0,
    camera_in_screen_mm: Sequence[float] | None = None,
) -> RigFit:
    """Least-squares rig pose from alignments. Size and gap stay as given."""
    if len(correspondences) < MIN_CORRESPONDENCES:
        raise RigFitError(
            f"need at least {MIN_CORRESPONDENCES} correspondences, have {len(correspondences)}"
        )
    eyes = np.array([c.eye for c in correspondences], dtype=np.float64)
    points = np.array([c.point for c in correspondences], dtype=np.float64)
    targets = np.array([c.target_mm for c in correspondences], dtype=np.float64)

    def residuals(rotation: Array, center: Array) -> Array | None:
        hit = _screen_hit(rotation, center, gap_mm, eyes, points)
        if not np.isfinite(hit).all():
            return None
        return (hit - targets).ravel()

    best: tuple[float, Array, Array] | None = None
    converged = 0
    for tilt in START_TILTS_DEG:
        start = Rig.nominal(width_mm, height_mm, gap_mm, camera_in_screen_mm, tilt)
        solution = _levenberg_marquardt(
            residuals, start.rotation_matrix, np.asarray(start.center_mm)
        )
        if solution is None:
            continue
        cost, rotation, center = solution
        if not _plausible(rotation, center, gap_mm):
            continue
        if best is not None and abs(cost - best[0]) <= 1e-6 * max(best[0], 1.0):
            converged += 1
        elif best is None or cost < best[0]:
            converged = 1
        if best is None or cost < best[0]:
            best = solution
    if best is None:
        raise RigFitError(
            "no physically valid mirror pose fits the alignments; check the measurements, "
            "the camera flip setting and that the board stayed in view"
        )

    _, rotation, center = best
    rotvec, _ = cv2.Rodrigues(rotation)
    rig = Rig(_triple(rotvec.ravel()), _triple(center), width_mm, height_mm, gap_mm)
    final = residuals(rotation, center)
    assert final is not None
    per_sample = np.linalg.norm(final.reshape(-1, 2), axis=1)
    rms = float(np.sqrt(np.mean(per_sample**2)))

    jacobian = _jacobian(residuals, rotation, center)
    assert jacobian is not None
    predicted, condition = _predicted_error(jacobian, final, rig)
    return RigFit(rig, per_sample, rms, predicted, condition, converged)


def _retract(rotation: Array, center: Array, step: Array) -> tuple[Array, Array]:
    """Apply a 6-vector step: a small rotation on the right of `rotation`, then a translation."""
    delta, _ = cv2.Rodrigues(step[:3].reshape(3, 1))
    return rotation @ delta, center + step[3:]


def _jacobian(residuals, rotation: Array, center: Array) -> Array | None:
    columns = []
    for i in range(6):
        step = np.zeros(6)
        # Rotations in radians, translations in mm: scale the mm steps up so
        # both perturb the screen by a comparable amount.
        h = JACOBIAN_STEP if i < 3 else JACOBIAN_STEP * 1000.0
        step[i] = h
        plus = residuals(*_retract(rotation, center, step))
        minus = residuals(*_retract(rotation, center, -step))
        if plus is None or minus is None:
            return None
        columns.append((plus - minus) / (2.0 * h))
    return np.column_stack(columns)


def _levenberg_marquardt(
    residuals, rotation: Array, center: Array
) -> tuple[float, Array, Array] | None:
    current = residuals(rotation, center)
    if current is None:
        return None
    cost = float(current @ current)
    damping = 1e-3
    for _ in range(LM_ITERATIONS):
        jacobian = _jacobian(residuals, rotation, center)
        if jacobian is None:
            return None
        normal = jacobian.T @ jacobian
        gradient = jacobian.T @ current
        improved = False
        for _ in range(12):
            try:
                step = np.linalg.solve(
                    normal + damping * np.diag(np.diag(normal) + 1e-12), -gradient
                )
            except np.linalg.LinAlgError:
                damping *= 10.0
                continue
            trial_rotation, trial_center = _retract(rotation, center, step)
            trial = residuals(trial_rotation, trial_center)
            if trial is not None and float(trial @ trial) < cost:
                previous = cost
                rotation, center, current = trial_rotation, trial_center, trial
                cost = float(trial @ trial)
                damping = max(damping / 3.0, 1e-9)
                improved = True
                if previous - cost <= 1e-12 * max(previous, 1.0):
                    return cost, rotation, center
                break
            damping *= 4.0
        if not improved:
            break
    return cost, rotation, center


def _plausible(rotation: Array, center: Array, gap_mm: float) -> bool:
    w = rotation[:, 2]
    mirror_d = float(w @ center) - gap_mm
    return (
        -w[2] >= MIN_FACING
        and abs(mirror_d) <= MAX_CAMERA_TO_MIRROR_MM
        and float(np.linalg.norm(center)) <= MAX_CAMERA_TO_CENTER_MM
    )


def _probe_poses(rig: Rig) -> tuple[Array, Array]:
    """Eyes and body points of a viewer standing near and far, in camera coordinates."""
    rotation = rig.rotation_matrix
    center = np.asarray(rig.center_mm)
    eyes, points = [], []
    for distance in (800.0, 1500.0, 2200.0):
        for eye_u in (-250.0, 250.0):
            eye = np.array([eye_u, -rig.height_mm * 0.4, -distance])
            for point_u in (-450.0, 0.0, 450.0):
                for point_v in (-300.0, 300.0, 900.0):
                    for depth in (-250.0, 0.0):
                        eyes.append(eye)
                        points.append(np.array([eye_u + point_u, point_v, -distance - depth]))
    to_camera = lambda rows: np.asarray(rows) @ rotation.T + center  # noqa: E731
    return to_camera(eyes), to_camera(points)


def _predicted_error(jacobian: Array, residuals: Array, rig: Rig) -> tuple[float, float]:
    """Propagate the fit's parameter covariance to screen error at the probe poses."""
    dof = max(len(residuals) - 6, 1)
    sigma2 = max(float(residuals @ residuals) / dof, NOISE_FLOOR_MM**2)
    normal = jacobian.T @ jacobian
    # Condition number with the columns scaled to unit length, so it measures
    # how well the parameters are separated rather than their units.
    scale = 1.0 / np.sqrt(np.maximum(np.diag(normal), 1e-30))
    condition = float(np.linalg.cond(normal * scale[:, None] * scale[None, :]))
    try:
        covariance = sigma2 * np.linalg.inv(normal)
    except np.linalg.LinAlgError:
        return math.inf, math.inf

    eyes, points = _probe_poses(rig)
    rotation, center = rig.rotation_matrix, np.asarray(rig.center_mm)

    def probe(rot: Array, cen: Array) -> Array | None:
        hit = _screen_hit(rot, cen, rig.gap_mm, eyes, points)
        return hit.ravel() if np.isfinite(hit).all() else None

    probe_jacobian = _jacobian(probe, rotation, center)
    if probe_jacobian is None:
        return math.inf, condition
    variance = np.einsum("ij,jk,ik->i", probe_jacobian, covariance, probe_jacobian)
    per_point = np.sqrt(np.maximum(variance.reshape(-1, 2).sum(axis=1), 0.0))
    return float(per_point.max()), condition


def point_for_target(rig: Rig, eye: ArrayLike, targets_mm: ArrayLike, distance_mm: float) -> Array:
    """Where a point must be held for its reflection to cover each screen target.

    The inverse of `project_mm` for a point `distance_mm` in front of the
    mirror: the virtual image sits on the sight line from `eye` through the
    target, as far behind the mirror as the point is in front of it.
    `targets_mm` is (..., 2) canvas-centered mm; returns (..., 3) camera mm.
    """
    rotation = rig.rotation_matrix
    center = np.asarray(rig.center_mm, dtype=np.float64)
    origin = np.asarray(eye, dtype=np.float64)
    targets = np.asarray(targets_mm, dtype=np.float64)
    u, v, w = rotation[:, 0], rotation[:, 1], rotation[:, 2]
    on_screen = center + targets[..., 0:1] * u + targets[..., 1:2] * v
    mirror_d = float(w @ center) - rig.gap_mm
    eye_side = float(origin @ w) - mirror_d
    # Signed side runs from eye_side (negative) at the eye to gap_mm on the
    # screen; the virtual image is where it reaches +distance_mm.
    reach = (distance_mm - eye_side) / (rig.gap_mm - eye_side)
    virtual = origin + reach * (on_screen - origin)
    return virtual - 2.0 * distance_mm * w
