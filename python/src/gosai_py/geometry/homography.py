"""Homographies: parsing, warping, and camera-projector calibration."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import cv2
import msgspec
import numpy as np
from numpy.typing import ArrayLike, NDArray

MIN_MARKERS = 4
RANSAC_THRESHOLD_PX = 5.0

type Matrix = NDArray[Any]


def to_matrix(values: ArrayLike) -> Matrix:
    """A 3x3 float64 matrix from 9 row-major values."""
    array = np.asarray(values, dtype=np.float64)
    if array.size != 9:
        raise ValueError(f"a homography needs 9 values, got {array.size}")
    return array.reshape(3, 3)


def flatten(matrix: Matrix) -> list[float]:
    return [float(v) for v in matrix.reshape(-1)]


def inverse(matrix: Matrix) -> Matrix:
    inv = np.linalg.inv(matrix)
    return inv / inv[2, 2]


def warp_points(matrix: Matrix, points: ArrayLike) -> NDArray[Any]:
    """Apply a homography to (N, 2) points."""
    array = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    if array.shape[0] == 0:
        return np.empty((0, 2), dtype=np.float64)
    return cv2.perspectiveTransform(array, matrix).reshape(-1, 2)


class MarkerPlacement(msgspec.Struct, kw_only=True):
    """Where the projector draws an ArUco marker, in display pixels."""

    id: int
    x: float
    y: float
    size: float = 60.0

    def corners(self) -> NDArray[np.float64]:
        """TL, TR, BR, BL, the order cv2.aruco reports detected corners in."""
        half = self.size / 2.0
        return np.array(
            [
                [self.x - half, self.y - half],
                [self.x + half, self.y - half],
                [self.x + half, self.y + half],
                [self.x - half, self.y + half],
            ],
            dtype=np.float64,
        )


@dataclass(frozen=True)
class Homographies:
    display: Matrix
    display_inverse: Matrix
    surface: Matrix | None
    surface_inverse: Matrix | None
    # The focus quad in display pixels, (4, 2), when a surface was computed.
    surface_quad_display: NDArray[Any] | None
    samples: int
    markers: int
    inliers: int
    error_mean: float
    error_max: float


def compute_homographies(
    layout: Sequence[MarkerPlacement],
    detections: Mapping[int, ArrayLike],
    *,
    focus_quad: ArrayLike | None = None,
    surface_size: tuple[int, int] = (1920, 1080),
    frame_size: tuple[int, int] | None = None,
) -> Homographies:
    """Fit camera->display from marker corners, and camera->surface from a focus quad.

    `detections` maps a marker id to its 4 detected corners in camera pixels.
    `focus_quad` holds the 4 surface corners in normalised camera coordinates
    (TL, TR, BR, BL); with `frame_size` it yields the camera->surface matrix
    that maps the quad onto a `surface_size` rectangle.
    """
    if len(layout) < MIN_MARKERS:
        raise ValueError(f"need at least {MIN_MARKERS} markers in layout")

    camera_pts: list[Any] = []
    display_pts: list[Any] = []
    for marker in layout:
        corners = detections.get(marker.id)
        if corners is None:
            continue
        camera_pts.append(np.asarray(corners, dtype=np.float64).reshape(4, 2))
        display_pts.append(marker.corners())
    markers = len(camera_pts)
    if markers < MIN_MARKERS:
        raise RuntimeError(f"only {markers} markers detected, need {MIN_MARKERS}")

    camera = np.concatenate(camera_pts)
    display = np.concatenate(display_pts)
    matrix, mask = cv2.findHomography(
        camera, display, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_THRESHOLD_PX
    )
    if matrix is None:
        raise RuntimeError("findHomography found no solution")
    inliers = mask.ravel().astype(bool) if mask is not None else np.ones(len(camera), dtype=bool)
    errors = np.linalg.norm(warp_points(matrix, camera) - display, axis=1)[inliers]

    surface = surface_inverse = quad_display = None
    if focus_quad is not None and frame_size is not None:
        quad = np.asarray(focus_quad, dtype=np.float64).reshape(4, 2) * np.asarray(frame_size)
        width, height = surface_size
        rect = np.array([[0, 0], [width, 0], [width, height], [0, height]], dtype=np.float64)
        surface, _ = cv2.findHomography(quad, rect, method=0)
        if surface is not None:
            surface_inverse = inverse(surface)
            quad_display = warp_points(matrix, quad)

    return Homographies(
        display=matrix,
        display_inverse=inverse(matrix),
        surface=surface,
        surface_inverse=surface_inverse,
        surface_quad_display=quad_display,
        samples=len(camera),
        markers=markers,
        inliers=int(inliers.sum()),
        error_mean=float(errors.mean()) if errors.size else 0.0,
        error_max=float(errors.max()) if errors.size else 0.0,
    )
