"""Metric camera-frame positions of the eyes, body, hands and face from one webcam.

Inputs are undistorted rays `(x/z, y/z)` from `CameraModel.normalize`, in the
camera's own unflipped frame, next to MediaPipe's relative 3D estimates. A
single camera sees directions well and depth poorly, so every function here
keeps the observed ray and only estimates the depth along it.

Depth needs one metric length per person, and the mirror is used by strangers:
nobody's size is known. A depth that is off by a factor `s` moves the drawing
by `(s - 1)` times its distance on the glass from the point nearest the camera,
so 10 % costs about 6 cm at a hand by the hip. Three cues give that length:

- The pupil spacing. MediaPipe's face `z` shares the scale of its pixel `x`,
  so the mesh is a 3D shape known up to one factor, and an assumed spacing
  fixes that factor even when the head is turned. Adults spread about 5 %
  around the 63 mm assumed here, and children sit well below it. It is a
  prior about people, the least trusted cue, and the only one always there.
- The iris. Its diameter is close to 11.7 mm in nearly everybody from the age
  of two, so its apparent size gives the eye's range whoever it belongs to.
  It is small in the image, so single frames are noisy and the landmark model
  may read it a little large or small on a given camera; the calibration
  measures that on the operator (`calibrated_iris_mm`).
- The floor. A rig never moves, so the floor is a known plane, and a foot seen
  on it has a depth that owes nothing to the person's size. A camera on top of
  a mirror rarely has the feet in view.

All are turned into the same number, the scale of MediaPipe's world landmarks
(meters for an average person), and `SessionScale` fuses them per visitor. Only
a translation is fitted per frame. The head is then placed at the depth that
scale gives the body's own eyes, so body and head never disagree.

None of this proves a depth is right: a low reprojection error only says the
translation agrees with MediaPipe's own 3D guess.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

type Array = NDArray[np.float64]

# The population prior the pupil cue assumes when nobody is measured. Drivers
# take their `ipd_mm` default from here.
GENERIC_IPD_MM = 63.0

# Face-mesh landmarks. Iris centers exist only in the 478-point mesh.
RIGHT_EYE_CORNERS = (33, 133)
LEFT_EYE_CORNERS = (362, 263)
RIGHT_IRIS = 468
LEFT_IRIS = 473
# Opposite points on each iris boundary: across, then up and down.
IRIS_DIAMETERS = (((469, 471), (470, 472)), ((474, 476), (475, 477)))
GENERIC_IRIS_MM = 11.7
# Below this many pixels across, the boundary landmarks are mostly noise.
MIN_IRIS_PX = 5.0
# How far the landmark model's reading of an iris can be off on one camera,
# and how far one person's iris is from the average (relative, one sigma).
IRIS_MODEL_SIGMA = 0.06
IRIS_PERSON_SIGMA = 0.04

# Body landmarks used to fit the translation, with their relative trust. The
# torso carries the fit; the head helps when the hips leave the frame.
TRANSLATION_LANDMARKS = {11: 1.0, 12: 1.0, 23: 1.0, 24: 1.0, 0: 0.5, 7: 0.5, 8: 0.5}
BODY_LEFT_EYE = 2
BODY_RIGHT_EYE = 5
# Heels and toes. The landmarks sit a little above the sole.
FLOOR_LANDMARKS = (29, 30, 31, 32)
FOOT_CLEARANCE_MM = 20.0
MIN_FLOOR_VISIBILITY = 0.8
# A ray this close to horizontal meets the floor too far away to trust.
MIN_FLOOR_SLOPE = 0.25
MIN_BODY_SCALE = 0.4  # a small child against MediaPipe's average adult
MAX_BODY_SCALE = 2.0
# Session scale: frames kept per cue, frames before a cue counts, and how far
# each cue can be off for a stranger (relative, one sigma).
SCALE_WINDOW = 90
MIN_SCALE_SAMPLES = 8
CUE_SIGMA = {"eyes": 0.06, "iris": 0.05, "floor": 0.035}
# The pupil spacing is a prior about people; the others measure this person.
PRIOR_CUE = "eyes"
MIN_LANDMARK_VISIBILITY = 0.5
MIN_TRANSLATION_LANDMARKS = 3
# Rays closer together than this (in x/z units) can't give a depth.
MIN_RAY_SPREAD = 0.01
MIN_DEPTH_MM = 100.0
MAX_DEPTH_MM = 8000.0


@dataclass(frozen=True)
class Eyes:
    """Pupil positions in camera mm. `left` is the viewer's own left eye."""

    left: Array
    right: Array

    @property
    def midpoint(self) -> Array:
        return (self.left + self.right) / 2.0


def _shape(rays: Array, rel_z: Array) -> Array:
    """Points at unit reference depth: each ray stretched by its relative depth."""
    depth = 1.0 + rel_z
    return np.column_stack([rays[:, 0] * depth, rays[:, 1] * depth, depth])


def _pupil(rays: Array, rel_z: Array, corners: tuple[int, int], iris: int) -> Array:
    """One pupil at unit reference depth.

    The iris center gives the direction when the mesh has it; its `z` is
    unreliable, so the depth always comes from the eye corners.
    """
    corner_depth = 1.0 + float(np.mean(rel_z[list(corners)]))
    if iris < len(rays) and np.isfinite(rays[iris]).all():
        ray = rays[iris]
    else:
        ray = np.mean(rays[list(corners)], axis=0)
    return np.array([ray[0] * corner_depth, ray[1] * corner_depth, corner_depth])


def face_depth(rays: Array, rel_z: Array, ipd_mm: float) -> float | None:
    """Depth (mm) of the face mesh's `z = 0` reference, from the pupil spacing.

    `rays` is (N, 2) and `rel_z` (N,) MediaPipe `z` divided by the focal
    length in the same pixels, so that `1 + rel_z` is each landmark's depth
    relative to the reference.
    """
    if len(rays) <= max(*RIGHT_EYE_CORNERS, *LEFT_EYE_CORNERS):
        return None
    a = _pupil(rays, rel_z, RIGHT_EYE_CORNERS, RIGHT_IRIS)
    b = _pupil(rays, rel_z, LEFT_EYE_CORNERS, LEFT_IRIS)
    spacing = float(np.linalg.norm(a - b))
    if not np.isfinite(spacing) or spacing < 1e-6:
        return None
    depth = ipd_mm / spacing
    return depth if MIN_DEPTH_MM <= depth <= MAX_DEPTH_MM else None


def locate_eyes(rays: Array, rel_z: Array, ipd_mm: float) -> Eyes | None:
    """Both pupils in camera mm, or None when the mesh can't give them."""
    depth = face_depth(rays, rel_z, ipd_mm)
    if depth is None:
        return None
    a = depth * _pupil(rays, rel_z, RIGHT_EYE_CORNERS, RIGHT_IRIS)
    b = depth * _pupil(rays, rel_z, LEFT_EYE_CORNERS, LEFT_IRIS)
    # The camera faces the viewer, so the viewer's left is at larger camera x.
    # Deciding by position keeps this independent of the mesh's index naming.
    return Eyes(left=a, right=b) if a[0] > b[0] else Eyes(left=b, right=a)


def _unit(ray: Array) -> Array:
    vector = np.array([ray[0], ray[1], 1.0])
    return vector / np.linalg.norm(vector)


def iris_angles(rays: Array, focal_px: float) -> list[tuple[float, float]]:
    """Per visible iris: the angle (radians) its diameter spans, and the depth-per-range of its ray.

    The iris is a circle seen as an ellipse, and a head turned both ways
    shortens both measured chords. The four boundary points are the ends of two
    conjugate diameters of that ellipse, which give its long axis exactly:
    with half-chords `p` and `q`, `a^2 + b^2 = |p|^2 + |q|^2` and
    `a b = |p x q|`. The long axis is the diameter seen face on.
    `focal_px` only turns the span into pixels for the `MIN_IRIS_PX` gate.
    """
    found = []
    for pairs in IRIS_DIAMETERS:
        indices = [index for pair in pairs for index in pair]
        if max(indices) >= len(rays) or not np.isfinite(rays[indices]).all():
            continue
        units = np.array([_unit(rays[index]) for index in indices])
        center = units.mean(axis=0)
        center /= np.linalg.norm(center)
        # Onto the plane facing the eye's own ray, where angles are tangents.
        flat = units / (units @ center)[:, None] - center
        p, q = (flat[0] - flat[1]) / 2.0, (flat[2] - flat[3]) / 2.0
        total = float(p @ p + q @ q)
        area = float(np.linalg.norm(np.cross(p, q)))
        semi_axis = math.sqrt((total + math.sqrt(max(total**2 - 4.0 * area**2, 0.0))) / 2.0)
        span = 2.0 * math.atan(semi_axis)
        if span * focal_px >= MIN_IRIS_PX:
            found.append((span, float(center[2])))
    return found


def iris_depth(rays: Array, focal_px: float, iris_mm: float = GENERIC_IRIS_MM) -> float | None:
    """Depth (mm) of the eyes from the apparent size of the irises, whoever they belong to.

    A diameter `D` spanning the angle `a` sits at range `D / (2 tan(a / 2))`
    along its ray; the ray's z component turns range into depth.
    """
    depths = [
        iris_mm / (2.0 * math.tan(span / 2.0)) * z_per_range
        for span, z_per_range in iris_angles(rays, focal_px)
    ]
    if not depths:
        return None
    depth = float(np.mean(depths))
    return depth if MIN_DEPTH_MM <= depth <= MAX_DEPTH_MM else None


def apparent_iris_mm(rays: Array, focal_px: float, eye_depth_mm: float) -> float | None:
    """The iris diameter the landmarks show for eyes at a known depth. The inverse of `iris_depth`."""
    sizes = [
        2.0 * math.tan(span / 2.0) * eye_depth_mm / z_per_range
        for span, z_per_range in iris_angles(rays, focal_px)
    ]
    return float(np.mean(sizes)) if sizes else None


def calibrated_iris_mm(apparent_mm: float) -> float:
    """The diameter to assume on this camera, from one operator's apparent iris.

    What the operator's iris reads is the model's bias on this camera times
    how far their own iris is from average, and one reading can't tell the two
    apart. The best estimate of the bias alone shrinks the reading toward the
    average by the share of the variance the bias is expected to own.
    """
    share = IRIS_MODEL_SIGMA**2 / (IRIS_MODEL_SIGMA**2 + IRIS_PERSON_SIGMA**2)
    return GENERIC_IRIS_MM * math.exp(share * math.log(apparent_mm / GENERIC_IRIS_MM))


def place_face(rays: Array, rel_z: Array, depth_mm: float) -> Array:
    """(N, 3) camera mm of every mesh landmark, given the reference depth."""
    return depth_mm * _shape(rays, rel_z)


def fit_translation(
    rays: Array, world_mm: Array, visibility: Array, scale: float = 1.0
) -> Array | None:
    """Camera-frame position (mm) of the world landmarks' origin, the mid-hips.

    `rays` is (33, 2), `world_mm` (33, 3) camera-aligned world landmarks and
    `visibility` (33,). Each landmark's camera position is modeled as
    `scale * world + T`, and its ray demands

        xn * (scale * Wz + Tz) = scale * Wx + Tx
        yn * (scale * Wz + Tz) = scale * Wy + Ty

    which is linear in T. The solution is proportional to `scale`: the scale
    sets the depth, and the frame can't tell a small near body from a large far one.
    """
    rows, rhs = [], []
    used = []
    for index, trust in TRANSLATION_LANDMARKS.items():
        if index >= min(len(rays), len(world_mm), len(visibility)):
            continue
        ray, world, seen = rays[index], world_mm[index], visibility[index]
        if not (np.isfinite(ray).all() and np.isfinite(world).all()):
            continue
        if not np.isfinite(seen) or seen < MIN_LANDMARK_VISIBILITY:
            continue
        weight = trust * float(seen)
        wx, wy, wz = scale * world
        rows.append(weight * np.array([1.0, 0.0, -ray[0]]))
        rhs.append(weight * (ray[0] * wz - wx))
        rows.append(weight * np.array([0.0, 1.0, -ray[1]]))
        rhs.append(weight * (ray[1] * wz - wy))
        used.append(ray)
    if len(used) < MIN_TRANSLATION_LANDMARKS:
        return None
    if float(np.ptp(np.array(used), axis=0).max()) < MIN_RAY_SPREAD:
        return None
    solution, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    if not np.isfinite(solution).all() or not MIN_DEPTH_MM <= solution[2] <= MAX_DEPTH_MM:
        return None
    return solution


def place_body(rays: Array, world_mm: Array, translation: Array, scale: float = 1.0) -> Array:
    """(N, 3) camera mm of body landmarks: the model's depth along each observed ray."""
    count = min(len(rays), len(world_mm))
    depth = np.full(len(rays), translation[2])
    depth[:count] = np.nan_to_num(scale * world_mm[:count, 2]) + translation[2]
    depth = np.maximum(depth, MIN_DEPTH_MM)
    return np.column_stack([rays[:, 0] * depth, rays[:, 1] * depth, depth])


def body_scale_from_eyes(
    rays: Array, world_mm: Array, visibility: Array, eye_depth_mm: float
) -> float | None:
    """Personal body scale that puts the body model's eyes at the head's measured depth.

    `fit_translation` is proportional to the scale, so the model's eye depth is
    `scale * (unit eye depth)` and one division recovers the scale.
    """
    unit = fit_translation(rays, world_mm, visibility, 1.0)
    if unit is None or max(BODY_LEFT_EYE, BODY_RIGHT_EYE) >= len(world_mm):
        return None
    eye_world_z = float(np.mean(world_mm[[BODY_LEFT_EYE, BODY_RIGHT_EYE], 2]))
    unit_depth = unit[2] + eye_world_z
    if not np.isfinite(unit_depth) or unit_depth < MIN_DEPTH_MM:
        return None
    scale = eye_depth_mm / unit_depth
    return scale if MIN_BODY_SCALE <= scale <= MAX_BODY_SCALE else None


def body_scale_from_floor(
    rays: Array, world_mm: Array, visibility: Array, down: Array, camera_height_mm: float
) -> float | None:
    """Body scale that puts the visible feet on the floor.

    `down` is the unit vector toward the floor in camera coordinates and the
    floor is the plane `down . X = camera_height_mm`. A foot on the ray
    `(xn, yn, 1)` therefore has depth `height / (down . ray)`, whoever it
    belongs to. Against the unit-scale model depth of the same landmark, that
    gives the scale, as in `body_scale_from_eyes`.
    """
    unit = fit_translation(rays, world_mm, visibility, 1.0)
    if unit is None:
        return None
    estimates = []
    for index in FLOOR_LANDMARKS:
        if index >= min(len(rays), len(world_mm), len(visibility)):
            continue
        ray, seen = rays[index], visibility[index]
        if not np.isfinite(ray).all() or not np.isfinite(seen) or seen < MIN_FLOOR_VISIBILITY:
            continue
        slope = float(down @ np.array([ray[0], ray[1], 1.0]))
        unit_depth = float(unit[2] + world_mm[index, 2])
        if slope < MIN_FLOOR_SLOPE or not np.isfinite(unit_depth) or unit_depth < MIN_DEPTH_MM:
            continue
        estimates.append((camera_height_mm - FOOT_CLEARANCE_MM) / slope / unit_depth)
    if not estimates:
        return None
    scale = float(np.median(estimates))
    return scale if MIN_BODY_SCALE <= scale <= MAX_BODY_SCALE else None


class SessionScale:
    """One visitor's body scale, fused from the cues seen so far.

    Each cue keeps a sliding window of its estimates and contributes the
    window's median, weighted by how far that cue can be off for a stranger:
    the pupil cue by the spread of pupil spacings, the iris cue by the spread
    of irises and what is left of the model's bias, the floor cue by foot and
    floor-plane error. Working on logarithms makes 10 % too big and 10 % too
    small cancel. A window rather than a frozen value lets the scale follow
    when one visitor replaces another without a gap.
    """

    def __init__(self) -> None:
        self._logs: dict[str, deque[float]] = {cue: deque(maxlen=SCALE_WINDOW) for cue in CUE_SIGMA}

    def reset(self) -> None:
        for window in self._logs.values():
            window.clear()

    def add(self, cue: str, scale: float | None) -> None:
        if scale is not None and math.isfinite(scale) and scale > 0.0:
            self._logs[cue].append(math.log(scale))

    def cue(self, cue: str) -> float | None:
        """The median of one cue, or None while it has too few samples."""
        window = self._logs[cue]
        return math.exp(float(np.median(window))) if len(window) >= MIN_SCALE_SAMPLES else None

    @property
    def value(self) -> float:
        """The fused scale; 1.0, MediaPipe's average person, before any cue settles.

        The cues that measure this person are averaged by their variances. The
        pupil spacing is only a prior about people, and the people it is most
        wrong about, children, are far from its center. So when the measured
        cues disagree with it, the prior gives way: its weight falls with the
        squared disagreement in sigmas, as a heavy-tailed prior's would. An
        adult a few percent off still gets everything averaged.
        """
        total, weight = 0.0, 0.0
        for name, sigma in CUE_SIGMA.items():
            estimate = self.cue(name)
            if name != PRIOR_CUE and estimate is not None:
                total += math.log(estimate) / sigma**2
                weight += 1.0 / sigma**2
        prior = self.cue(PRIOR_CUE)
        if prior is not None:
            sigma = CUE_SIGMA[PRIOR_CUE]
            disagreement = (math.log(prior) - total / weight) / sigma if weight else 0.0
            prior_weight = 1.0 / sigma**2 / (1.0 + disagreement**2)
            total += prior_weight * math.log(prior)
            weight += prior_weight
        return math.exp(total / weight) if weight else 1.0

    @property
    def head_factor(self) -> float:
        """How much farther the head is than the assumed pupil spacing says.

        The pupil cue alone gives 1. With the floor cue the body scale moves,
        and the head follows it by this factor so both stay one person.
        """
        eyes = self.cue("eyes")
        return self.value / eyes if eyes is not None else 1.0


def place_hand(
    rays: Array, hand_world_mm: Array | None, wrist_depth_mm: float, scale: float = 1.0
) -> Array:
    """(N, 3) camera mm of hand landmarks, anchored at the body's wrist depth.

    With hand world landmarks, each joint keeps its depth relative to the
    hand's own wrist (landmark 0). Without them the hand is flat at the wrist.
    """
    depth = np.full(len(rays), wrist_depth_mm)
    if hand_world_mm is not None and len(hand_world_mm) == len(rays) and len(rays) > 0:
        relative = scale * (hand_world_mm[:, 2] - hand_world_mm[0, 2])
        depth = depth + np.nan_to_num(relative)
    depth = np.maximum(depth, MIN_DEPTH_MM)
    return np.column_stack([rays[:, 0] * depth, rays[:, 1] * depth, depth])
