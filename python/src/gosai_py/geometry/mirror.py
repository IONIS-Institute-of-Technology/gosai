"""Reflection geometry for an augmented mirror.

A webcam sees the user; the app draws on a screen behind a one-way mirror so
that the drawing lines up with the user's reflection. For a body point P seen
from the eye E, the reflection crosses the mirror plane where the line from E
to P's virtual image meets it.

Depth comes from MediaPipe's metric world landmarks: shoulder span in meters
against shoulder span in pixels gives the distance (weak perspective), and
each joint adds its world z. Pixels are back-projected with a pinhole model
whose focal length follows from the horizontal field of view. Points are moved
into a mirror-aligned frame by rotating about the x axis by the camera tilt,
so distances to the mirror are measured along its normal.

Every function works on arrays: one call reflects all landmarks of a frame,
or one landmark across many frames.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
from numpy.typing import ArrayLike, NDArray

type Array = NDArray[np.float64]

NOSE = 0
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
BODY_LANDMARKS = 33


@dataclass(frozen=True)
class Optics:
    """Camera and mirror parameters of the reflection."""

    hfov_deg: float
    tilt_deg: float
    scale: float
    mirror_offset_mm: float
    default_distance_mm: float


def landmarks(points: Any, count: int = 0, columns: int = 3) -> Array:
    """Rows of landmark values as a (max(len, count), columns) array, NaN where missing."""
    rows = points if isinstance(points, Sequence) else []
    out = np.full((max(len(rows), count), columns), np.nan)
    for i, row in enumerate(rows):
        if isinstance(row, Sequence):
            values = [float(v) for v in row[:columns]]
            out[i, : len(values)] = values
    return out


def intrinsics(frame_w: ArrayLike, frame_h: ArrayLike, hfov_deg: float) -> tuple[Array, Array, Array]:
    """Focal length (square pixels) and principal point for a frame size."""
    w = np.asarray(frame_w, dtype=np.float64)
    h = np.asarray(frame_h, dtype=np.float64)
    fx = (w / 2.0) / max(math.tan(math.radians(hfov_deg) / 2.0), 1e-6)
    return fx, w / 2.0, h / 2.0


def deproject(uv: ArrayLike, depth: ArrayLike, fx: ArrayLike, ppx: ArrayLike, ppy: ArrayLike) -> Array:
    """Pinhole back-projection of (..., 2) pixels at `depth` mm into (..., 3) camera mm."""
    uv_arr = np.asarray(uv, dtype=np.float64)
    z = np.asarray(depth, dtype=np.float64)
    f = np.asarray(fx, dtype=np.float64)
    x = (uv_arr[..., 0] - np.asarray(ppx, dtype=np.float64)) / f * z
    y = (uv_arr[..., 1] - np.asarray(ppy, dtype=np.float64)) / f * z
    return np.stack(np.broadcast_arrays(x, y, z), axis=-1)


def reflect(eye: ArrayLike, points: ArrayLike, tilt_deg: float, mirror_offset_mm: float) -> Array:
    """Where the sight line from `eye` to each point's mirror image crosses the mirror.

    `eye` and `points` are camera-frame mm, broadcastable (..., 3). Returns
    (..., 2) mirror-plane mm, NaN where the geometry has no crossing.
    """
    theta = math.radians(tilt_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    a = np.asarray(eye, dtype=np.float64)
    b = np.asarray(points, dtype=np.float64)
    ya = a[..., 1] * cos_t + a[..., 2] * sin_t
    yb = b[..., 1] * cos_t + b[..., 2] * sin_t
    da = a[..., 2] * cos_t - a[..., 1] * sin_t - mirror_offset_mm
    db = b[..., 2] * cos_t - b[..., 1] * sin_t - mirror_offset_mm
    dz = da + db
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(dz > 1e-6, da / dz, np.nan)
    x = a[..., 0] + t * (b[..., 0] - a[..., 0])
    y = ya + t * (yb - ya)
    return np.stack(np.broadcast_arrays(x, y), axis=-1)


def estimate_distance(pose: Array, world: Array, fx: ArrayLike, optics: Optics) -> Array:
    """Distance (mm) from the camera to MediaPipe's world origin, the mid-hips.

    `pose` is (..., N, 2+) pixels and `world` (..., N, 3+) meters. Shoulder
    span gives the shoulders' depth; subtracting their world z moves it to
    the hip origin, so `distance + world_z` is each joint's depth.
    """
    if pose.shape[-2] <= RIGHT_SHOULDER or world.shape[-2] <= RIGHT_SHOULDER:
        return np.full(pose.shape[:-2], optics.default_distance_mm)
    px = np.linalg.norm(pose[..., LEFT_SHOULDER, :2] - pose[..., RIGHT_SHOULDER, :2], axis=-1)
    meters = np.linalg.norm(world[..., LEFT_SHOULDER, :2] - world[..., RIGHT_SHOULDER, :2], axis=-1)
    with np.errstate(divide="ignore", invalid="ignore"):
        shoulders_z = np.asarray(fx) * (meters * 1000.0) / px * optics.scale
        shoulders_world_z = (world[..., LEFT_SHOULDER, 2] + world[..., RIGHT_SHOULDER, 2]) / 2.0 * 1000.0
        valid = (px > 1.0) & (meters > 0.05) & np.isfinite(shoulders_world_z)
    return np.where(valid, shoulders_z - shoulders_world_z, optics.default_distance_mm)


@dataclass(frozen=True)
class BodyFrame:
    """One pose frame's reflection setup: joint depths and the eye position."""

    fx: float
    ppx: float
    ppy: float
    depths: Array  # (N,) mm, one per body landmark
    eye: Array  # (3,) camera mm

    @classmethod
    def build(cls, pose: Array, world: Array, frame_w: float, frame_h: float, optics: Optics) -> BodyFrame:
        fx, ppx, ppy = (float(v) for v in intrinsics(frame_w, frame_h, optics.hfov_deg))
        distance = float(estimate_distance(pose, world, fx, optics))
        world_z = np.zeros(len(pose))
        count = min(len(pose), len(world))
        world_z[:count] = np.nan_to_num(world[:count, 2] * 1000.0)
        depths = np.maximum(distance + world_z, 1.0)
        eye_depth = depths[NOSE] if len(depths) > NOSE else distance
        nose = pose[NOSE, :2] if len(pose) > NOSE and np.isfinite(pose[NOSE, :2]).all() else None
        eye_uv = nose if nose is not None else np.array([frame_w / 2.0, frame_h / 2.0])
        return cls(fx, ppx, ppy, depths, deproject(eye_uv, eye_depth, fx, ppx, ppy))

    def reflect(self, uv: Array, depths: ArrayLike, optics: Optics) -> Array:
        """Mirror-plane mm of (N, 2) pixels at the given depths, (-1, -1) where undefined."""
        points = deproject(uv, depths, self.fx, self.ppx, self.ppy)
        out = reflect(self.eye, points, optics.tilt_deg, optics.mirror_offset_mm)
        invalid = ~np.isfinite(out).all(axis=-1)
        out[invalid] = -1.0
        return out


def project_part(frame: BodyFrame, part: Array, optics: Optics, anchor: Array | None, own_depths: bool) -> Array:
    """Reflect a landmark part into `[x_mm, y_mm, depth_mm, visibility]` rows.

    Body landmarks use their own depths (`own_depths`). Hands and face take
    depth and visibility from an anchor row of the projected body, or the eye
    depth when the anchor is missing.
    """
    if len(part) == 0:
        return np.empty((0, 4))
    if own_depths:
        depths = frame.depths[: len(part)]
        visibility = np.where(np.isnan(part[:, 2]), 1.0, part[:, 2])
    elif anchor is not None:
        depths = np.full(len(part), anchor[2])
        visibility = np.full(len(part), anchor[3])
    else:
        depths = np.full(len(part), float(frame.eye[2]))
        visibility = np.where(np.isnan(part[:, 2]), 1.0, part[:, 2])
    xy = frame.reflect(part[:, :2], depths, optics)
    return np.column_stack([xy, depths, visibility])


def reflect_landmark(
    pose: Array, world: Array, frame_size: Array, index: ArrayLike, optics: Optics
) -> Array:
    """Reflect one body landmark per frame, for many frames at once.

    `pose` (F, N, 3), `world` (F, N, 3), `frame_size` (F, 2), `index` (F,) or
    scalar. Returns (F, 2) mirror-plane mm, NaN where it can't be reflected.
    """
    frames = np.arange(len(pose))
    fx, ppx, ppy = intrinsics(frame_size[:, 0], frame_size[:, 1], optics.hfov_deg)
    distance = estimate_distance(pose, world, fx, optics)
    world_z = np.nan_to_num(world[:, :, 2] * 1000.0)
    idx = np.broadcast_to(np.asarray(index), frames.shape)
    eye_depth = np.maximum(distance + world_z[:, NOSE], 1.0)
    nose = pose[:, NOSE, :2]
    center = frame_size / 2.0
    eye_uv = np.where(np.isfinite(nose).all(axis=1, keepdims=True), nose, center)
    eye = deproject(eye_uv, eye_depth, fx, ppx, ppy)
    point_depth = np.maximum(distance + world_z[frames, idx], 1.0)
    point = deproject(pose[frames, idx, :2], point_depth, fx, ppx, ppy)
    return reflect(eye, point, optics.tilt_deg, optics.mirror_offset_mm)


def stack_frames(frames: Sequence[Mapping[str, Any]]) -> tuple[Array, Array, Array]:
    """Stack raw pose payloads into (F, 33, 3) pose, (F, 33, 3) world and (F, 2) sizes."""
    pose = np.stack([landmarks(f.get("body_pose"), BODY_LANDMARKS)[:BODY_LANDMARKS] for f in frames])
    world = np.stack([landmarks(f.get("body_world_pose"), BODY_LANDMARKS)[:BODY_LANDMARKS] for f in frames])
    sizes = np.array(
        [[float(f.get("frame_width") or 1280.0), float(f.get("frame_height") or 720.0)] for f in frames]
    )
    return pose, world, sizes


def fit_axis(xs: ArrayLike, targets: ArrayLike) -> tuple[float, float] | None:
    """Least-squares `target = a * x + b`, or None when the xs don't vary."""
    x = np.asarray(xs, dtype=np.float64)
    if len(x) < 2 or np.ptp(x) < 1e-9:
        return None
    design = np.column_stack([x, np.ones_like(x)])
    (a, b), *_ = np.linalg.lstsq(design, np.asarray(targets, dtype=np.float64))
    return float(a), float(b)
