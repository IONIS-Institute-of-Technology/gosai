"""Calibrated pinhole camera with lens distortion.

The camera frame is OpenCV's: x right and y down in the image, z forward, in
millimeters. Pixels are those of the unflipped frame the `camera` driver
delivers, after its rotation. A flipped or cropped view has to be mapped back
to these pixels before it reaches this model.

`normalize` turns pixels into undistorted rays `(x/z, y/z)`, so a point at
depth `z` is `z * (xn, yn, 1)`. Everything downstream works on those rays and
never sees focal lengths or distortion terms.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
from numpy.typing import ArrayLike, NDArray

type Array = NDArray[np.float64]

UNDISTORT_CRITERIA = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 20, 1e-10)


@dataclass(frozen=True)
class CameraModel:
    """Intrinsics for one frame size. `dist` follows OpenCV's coefficient order."""

    width: float
    height: float
    fx: float
    fy: float
    cx: float
    cy: float
    dist: tuple[float, ...] = ()

    @classmethod
    def from_hfov(cls, width: float, height: float, hfov_deg: float) -> CameraModel:
        """Square pixels, centered principal point, no distortion: the uncalibrated fallback."""
        f = (width / 2.0) / max(math.tan(math.radians(hfov_deg) / 2.0), 1e-6)
        return cls(width, height, f, f, width / 2.0, height / 2.0)

    @property
    def matrix(self) -> Array:
        return np.array([[self.fx, 0.0, self.cx], [0.0, self.fy, self.cy], [0.0, 0.0, 1.0]])

    @property
    def dist_coeffs(self) -> Array:
        return np.asarray(self.dist, dtype=np.float64)

    def scaled_to(self, width: float, height: float) -> CameraModel | None:
        """The same lens at another resolution, or None when the aspect ratio differs.

        A different aspect ratio means the sensor was cropped, and the crop
        can't be recovered from the frame size alone.
        """
        sx, sy = width / self.width, height / self.height
        if abs(sx - sy) > 0.01 * max(sx, sy):
            return None
        if sx == 1.0 and sy == 1.0:
            return self
        # Pixel centers sit at integer coordinates, so the scale pivots on -0.5.
        return CameraModel(
            width,
            height,
            self.fx * sx,
            self.fy * sy,
            (self.cx + 0.5) * sx - 0.5,
            (self.cy + 0.5) * sy - 0.5,
            self.dist,
        )

    def normalize(self, uv: ArrayLike) -> Array:
        """Undistorted rays `(x/z, y/z)` of (..., 2) pixels. NaN pixels stay NaN."""
        pixels = np.asarray(uv, dtype=np.float64)
        flat = pixels.reshape(-1, 2)
        out = np.full(flat.shape, np.nan)
        finite = np.isfinite(flat).all(axis=1)
        if finite.any():
            if self.dist:
                # The default five iterations leave about 0.1 px at the corners
                # of a webcam lens, a systematic error where arms and hands are.
                undistorted = cv2.undistortPoints(
                    flat[finite].reshape(-1, 1, 2),
                    self.matrix,
                    self.dist_coeffs,
                    criteria=UNDISTORT_CRITERIA,
                )
                out[finite] = undistorted.reshape(-1, 2)
            else:
                out[finite, 0] = (flat[finite, 0] - self.cx) / self.fx
                out[finite, 1] = (flat[finite, 1] - self.cy) / self.fy
        return out.reshape(pixels.shape)

    def project(self, points: ArrayLike) -> Array:
        """Distorted pixels of (..., 3) camera-frame points. The inverse of `normalize`."""
        pts = np.asarray(points, dtype=np.float64)
        flat = pts.reshape(-1, 3)
        if len(flat) == 0:
            return np.empty((*pts.shape[:-1], 2))
        pixels, _ = cv2.projectPoints(
            flat.reshape(-1, 1, 3), np.zeros(3), np.zeros(3), self.matrix, self.dist_coeffs
        )
        return np.asarray(pixels, dtype=np.float64).reshape(*pts.shape[:-1], 2)


def unflip(uv: ArrayLike, width: float) -> Array:
    """Pixels of a horizontally flipped frame, mapped back to the camera's own frame."""
    out = np.array(uv, dtype=np.float64, copy=True)
    out[..., 0] = (width - 1.0) - out[..., 0]
    return out
