"""Wire formats of the mirror's calibration results.

Drivers hold no storage: the app saves these structs and sends them back on
start. The lens profile belongs to the camera and its optical path, the rig
profile to the mirror assembly. Neither holds anything about a person: the
rig's `iris_mm` is read off the operator during the calibration, but what it
describes is how this camera reads an iris, not the size of theirs.
"""

from __future__ import annotations

from typing import Annotated

import msgspec
from msgspec import Meta

from gosai_py.geometry.camera_model import Array, CameraModel
from gosai_py.geometry.mirror_rig import Rig
from gosai_py.geometry.placement import GENERIC_IRIS_MM

Vector3 = Annotated[list[float], Meta(min_length=3, max_length=3)]


class LensProfile(msgspec.Struct, kw_only=True):
    """Camera intrinsics for unflipped frames of `width` x `height`, after the camera's rotation."""

    width: Annotated[float, Meta(gt=0)]
    height: Annotated[float, Meta(gt=0)]
    fx: Annotated[float, Meta(gt=0)]
    fy: Annotated[float, Meta(gt=0)]
    cx: float
    cy: float
    dist: Annotated[
        list[float], Meta(max_length=14, description="OpenCV order: k1, k2, p1, p2, k3, ...")
    ] = []
    rms_px: float | None = None

    def camera(self) -> CameraModel:
        return CameraModel(
            self.width, self.height, self.fx, self.fy, self.cx, self.cy, tuple(self.dist)
        )

    @classmethod
    def of(cls, camera: CameraModel, rms_px: float | None = None) -> LensProfile:
        return cls(
            width=camera.width,
            height=camera.height,
            fx=camera.fx,
            fy=camera.fy,
            cx=camera.cx,
            cy=camera.cy,
            dist=list(camera.dist),
            rms_px=rms_px,
        )


class RigProfile(msgspec.Struct, kw_only=True):
    """Pose of the canvas behind the mirror in camera coordinates. See `geometry.mirror_rig`."""

    rotation: Annotated[
        Vector3, Meta(description="Rotation vector; columns of the matrix are u, v, w.")
    ]
    center_mm: Annotated[Vector3, Meta(description="Canvas center in camera millimeters.")]
    width_mm: Annotated[float, Meta(gt=0, description="Physical width the canvas pixels cover.")]
    height_mm: Annotated[float, Meta(gt=0, description="Physical height the canvas pixels cover.")]
    gap_mm: Annotated[float, Meta(ge=0, description="Mirror surface to pixel plane.")] = 0.0
    # The constraint sits inside the union: msgspec rejects `gt` on a nullable type.
    camera_height_mm: Annotated[
        Annotated[float, Meta(gt=0)] | None,
        Meta(
            description="Camera lens above the floor, for a plumb mirror. Lets visible feet "
            "set a visitor's depth without knowing their size. Null turns that cue off."
        ),
    ] = None
    iris_mm: Annotated[
        float,
        Meta(
            ge=9.0,
            le=15.0,
            description="Iris diameter to ASSUME on this camera, not anybody's real iris: the "
            "generic 11.7 mm times what this camera's landmark model reads it as. Measured on "
            "the operator during the rig calibration, so it travels with the rig.",
        ),
    ] = GENERIC_IRIS_MM

    def floor(self) -> tuple[Array, float] | None:
        """The floor as `down . X = height` in camera coordinates, or None when unknown.

        The screen hangs plumb, so its own down axis `v` is the way to the floor.
        """
        if self.camera_height_mm is None:
            return None
        return self.rig().rotation_matrix[:, 1], self.camera_height_mm

    def rig(self) -> Rig:
        rx, ry, rz = self.rotation
        cx, cy, cz = self.center_mm
        return Rig((rx, ry, rz), (cx, cy, cz), self.width_mm, self.height_mm, self.gap_mm)

    @classmethod
    def of(
        cls,
        rig: Rig,
        camera_height_mm: float | None = None,
        iris_mm: float = GENERIC_IRIS_MM,
    ) -> RigProfile:
        return cls(
            rotation=list(rig.rotation),
            center_mm=list(rig.center_mm),
            width_mm=rig.width_mm,
            height_mm=rig.height_mm,
            gap_mm=rig.gap_mm,
            camera_height_mm=camera_height_mm,
            iris_mm=iris_mm,
        )
