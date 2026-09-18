"""Calibration driver.

Detects ArUco markers (4x4_50) in camera frames and computes homographies
between the camera and the projector display. The math is
`gosai_py.geometry.homography.compute_homographies`.

- camera -> display uses all 4 corners of every detected marker, which keeps
  accuracy near the edges where keystone distortion is worst.
- camera -> surface is computed when `compute` gets a `focus_quad` (the 4
  physical surface corners in normalised camera coordinates) and a frame
  size. It maps the surface onto `surface_size`, the reference resolution
  apps render in, so tracking drivers (`ball`, `hand_pose`) emit coordinates
  in that space whatever the camera angle.

Typical flow: `render_marker` for each marker, `set_marker_layout` with where
they are drawn, then `compute` once enough markers are detected.
"""

from __future__ import annotations

import base64
import threading
from collections.abc import Mapping
from typing import Annotated, Any, ClassVar, Literal

import cv2
import msgspec
import numpy as np
from msgspec import Meta

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.geometry import homography
from gosai_py.geometry.homography import MarkerPlacement
from gosai_py.payloads import EpochMs, Ok, Point, PositiveInt, Size
from gosai_py.serialization import frame_to_jpeg_base64

ARUCO_DICTIONARY = cv2.aruco.DICT_4X4_50

# A point as {x, y} or [x, y].
PointLike = Point | Annotated[list[float], Meta(min_length=2, max_length=2)]
Space = Literal["display", "surface"]


class DetectionPayload(msgspec.Struct, kw_only=True):
    detected: int
    ids: list[int]
    # 4 corners per marker (TL, TR, BR, BL) in camera pixels.
    corners: list[list[list[float]]]
    ts: EpochMs


class HomographyPayload(msgspec.Struct, kw_only=True):
    """3x3 matrices flattened row by row."""

    matrix: list[float]
    inverse: list[float]
    surface_matrix: list[float] | None
    surface_inverse: list[float] | None
    ts: EpochMs


class StatusPayload(msgspec.Struct, kw_only=True):
    stage: str
    message: str


class LayoutResult(msgspec.Struct, kw_only=True):
    count: int


class CameraEventParams(msgspec.Struct, kw_only=True):
    driver: str | None = None
    event: str | None = None


class CameraEventResult(msgspec.Struct, kw_only=True):
    driver: str
    event: str


class ComputeParams(msgspec.Struct, kw_only=True):
    # Surface corners TL, TR, BR, BL in normalised camera coordinates.
    focus_quad: Annotated[list[PointLike], Meta(min_length=4, max_length=4)] | None = None
    surface_size: Size | None = None
    # Camera frame size; defaults to the last frame seen.
    frame_size: Size | None = None


class ComputeResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    matrix: list[float]
    inverse: list[float]
    surface_matrix: list[float] | None
    surface_inverse: list[float] | None
    surface_quad_display: Annotated[
        list[Point] | None,
        Meta(
            description=(
                "The surface corners TL, TR, BR, BL in display pixels. Null without a"
                " focus quad, or when a corner maps to infinity on the display."
            )
        ),
    ]
    surface_size: Size
    frame_size: Size | None
    samples: int
    markers: int
    inliers: int
    reprojection_error_mean: float
    reprojection_error_max: float


class RenderMarkerParams(msgspec.Struct, kw_only=True):
    id: int = 0
    size: PositiveInt = 200


class MarkerImage(msgspec.Struct, kw_only=True):
    ok: bool = True
    id: int
    size: int
    png_base64: str


class LatestFrame(msgspec.Struct, kw_only=True):
    ok: bool = True
    jpeg_base64: str
    width: int | None = None
    height: int | None = None
    ts: Annotated[
        float | None,
        Meta(description="The frame's `ts`, in milliseconds since the Unix epoch."),
    ] = None


class ReprojectPointParams(msgspec.Struct, kw_only=True):
    x: float
    y: float
    space: Space = "display"


class ReprojectedPoint(msgspec.Struct, kw_only=True):
    ok: bool = True
    x: float
    y: float


class ReprojectPointsParams(msgspec.Struct, kw_only=True):
    points: Annotated[list[PointLike], Meta(min_length=1)]
    space: Space = "display"


class ReprojectedPoints(msgspec.Struct, kw_only=True):
    ok: bool = True
    # In input order; null where a point maps to infinity.
    points: list[Point | None]


def _xy(point: PointLike) -> tuple[float, float]:
    return (point.x, point.y) if isinstance(point, Point) else (point[0], point[1])


class CalibrationDriver(BaseDriver):
    name = "calibration"
    description = "Camera-projector calibration via ArUco markers."
    events: ClassVar[Mapping[str, Event]] = {
        "detection": Event(DetectionPayload, "Markers found in the latest frame."),
        "homography": Event(HomographyPayload, "Matrices from the last successful compute."),
        "status": Event(StatusPayload, "Human-readable progress."),
    }
    stream_events = ("detection",)
    dependencies = ("camera",)
    subscribed = (("camera", "frame"),)
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._detector = cv2.aruco.ArucoDetector(
            cv2.aruco.getPredefinedDictionary(ARUCO_DICTIONARY), cv2.aruco.DetectorParameters()
        )
        self._lock = threading.Lock()
        self._camera = ("camera", "frame")
        self._layout: list[MarkerPlacement] = []
        # Latest 4 corners per marker id, (4, 2) camera pixels.
        self._detections: dict[int, np.ndarray] = {}
        self._latest_frame: Any = None
        self._latest_jpeg: str | None = None
        self._latest_meta: dict[str, Any] = {}
        self._display: homography.Matrix | None = None
        self._surface: homography.Matrix | None = None

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        frame = data.get("_frame")
        encoded = data.get("jpeg_base64")
        if frame is None and not isinstance(encoded, str):
            return
        with self._lock:
            self._latest_frame = frame
            self._latest_jpeg = encoded if isinstance(encoded, str) else None
            self._latest_meta = {k: data.get(k) for k in ("width", "height", "ts")}
        if frame is None and isinstance(encoded, str):
            # An event such as camera.color only carries the JPEG.
            frame = cv2.imdecode(
                np.frombuffer(base64.b64decode(encoded), np.uint8), cv2.IMREAD_COLOR
            )
        if frame is not None:
            self._detect(frame)

    def _detect(self, frame: Any) -> None:
        corners, ids, _ = self._detector.detectMarkers(frame)
        found = [] if ids is None else [int(i) for i in ids.reshape(-1)]
        marker_corners = [
            np.asarray(c, dtype=np.float64).reshape(4, 2) for c in corners[: len(found)]
        ]
        with self._lock:
            self._detections.update(zip(found, marker_corners, strict=True))
        self.emit(
            "detection",
            {
                "detected": len(found),
                "ids": found,
                "corners": [c.tolist() for c in marker_corners],
                "ts": now_ms(),
            },
        )

    @action("Set where the markers are drawn on the display. Clears detections.")
    def set_marker_layout(self, layout: list[MarkerPlacement]) -> LayoutResult:
        with self._lock:
            self._layout = layout
            self._detections.clear()
        self.emit(
            "status", {"stage": "configured", "message": f"layout with {len(layout)} markers"}
        )
        return LayoutResult(count=len(layout))

    @action(
        "Detect markers in another event with `_frame` or `jpeg_base64` (default camera.frame)."
    )
    def set_camera_event(self, params: CameraEventParams | None) -> CameraEventResult:
        previous = self._camera
        driver = params.driver if params and params.driver else previous[0]
        event = params.event if params and params.event else previous[1]
        self.unsubscribe(*previous)
        self._camera = (driver, event)
        self.subscribe(driver, event)
        return CameraEventResult(driver=driver, event=event)

    @action("Compute the homographies from the current detections.")
    def compute(self, params: ComputeParams | None) -> ComputeResult:
        params = params or ComputeParams()
        with self._lock:
            layout = list(self._layout)
            detections = dict(self._detections)
            meta = dict(self._latest_meta)
        surface_size = params.surface_size or Size(width=1920, height=1080)
        frame_size = params.frame_size
        if frame_size is None and meta.get("width") and meta.get("height"):
            frame_size = Size(width=int(meta["width"]), height=int(meta["height"]))
        focus_quad = [_xy(p) for p in params.focus_quad] if params.focus_quad else None

        result = homography.compute_homographies(
            layout,
            detections,
            focus_quad=focus_quad,
            surface_size=(surface_size.width, surface_size.height),
            frame_size=(frame_size.width, frame_size.height) if frame_size else None,
        )
        with self._lock:
            self._display = result.display
            if result.surface is not None:
                self._surface = result.surface

        matrix = homography.flatten(result.display)
        inverse = homography.flatten(result.display_inverse)
        surface = None if result.surface is None else homography.flatten(result.surface)
        surface_inverse = (
            None if result.surface_inverse is None else homography.flatten(result.surface_inverse)
        )
        self.emit(
            "homography",
            {
                "matrix": matrix,
                "inverse": inverse,
                "surface_matrix": surface,
                "surface_inverse": surface_inverse,
                "ts": now_ms(),
            },
        )
        self.emit(
            "status",
            {
                "stage": "computed",
                "message": (
                    f"homography from {result.markers} markers "
                    f"({result.samples} corner pairs, {result.inliers} inliers), "
                    f"reproj error {result.error_mean:.2f}px mean / {result.error_max:.2f}px max"
                ),
            },
        )
        quad = result.surface_quad_display
        return ComputeResult(
            matrix=matrix,
            inverse=inverse,
            surface_matrix=surface,
            surface_inverse=surface_inverse,
            surface_quad_display=None
            if quad is None
            else [Point(x=float(x), y=float(y)) for x, y in quad],
            surface_size=surface_size,
            frame_size=frame_size,
            samples=result.samples,
            markers=result.markers,
            inliers=result.inliers,
            reprojection_error_mean=round(result.error_mean, 3),
            reprojection_error_max=round(result.error_max, 3),
        )

    @action("Forget accumulated detections.")
    def clear(self) -> Ok:
        with self._lock:
            self._detections.clear()
        self.emit("status", {"stage": "cleared", "message": "accumulated detections cleared"})
        return Ok()

    @action("Render an ArUco marker as a PNG. Accepts {id, size} or a bare id.")
    def render_marker(self, params: RenderMarkerParams | int) -> MarkerImage:
        if isinstance(params, int):
            params = RenderMarkerParams(id=params)
        dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICTIONARY)
        image = cv2.aruco.generateImageMarker(dictionary, params.id, params.size)
        ok, buf = cv2.imencode(".png", image)
        if not ok:
            raise RuntimeError("PNG encoding failed")
        return MarkerImage(
            id=params.id,
            size=params.size,
            png_base64=base64.b64encode(buf.tobytes()).decode("ascii"),
        )

    @action("The latest camera frame as a base64 JPEG.")
    def get_latest_frame(self) -> LatestFrame:
        with self._lock:
            frame, encoded, meta = self._latest_frame, self._latest_jpeg, dict(self._latest_meta)
        if encoded is None:
            if frame is None:
                raise RuntimeError("no camera frame received yet")
            encoded = frame_to_jpeg_base64(frame, quality=75)
        return LatestFrame(
            jpeg_base64=encoded, width=meta["width"], height=meta["height"], ts=meta["ts"]
        )

    @action("Warp a camera pixel into display or surface space. Fails when it maps to infinity.")
    def reproject_point(self, params: ReprojectPointParams) -> ReprojectedPoint:
        [[x, y]] = homography.warp_points(self._matrix_for(params.space), [[params.x, params.y]])
        if not (np.isfinite(x) and np.isfinite(y)):
            raise ValueError(f"({params.x}, {params.y}) maps to infinity in '{params.space}' space")
        return ReprojectedPoint(x=float(x), y=float(y))

    @action("Warp camera pixels into display or surface space, null where one maps to infinity.")
    def reproject_points(self, params: ReprojectPointsParams) -> ReprojectedPoints:
        warped = homography.warp_points(
            self._matrix_for(params.space), [_xy(p) for p in params.points]
        )
        return ReprojectedPoints(
            points=[
                Point(x=float(x), y=float(y)) if np.isfinite(x) and np.isfinite(y) else None
                for x, y in warped
            ]
        )

    def _matrix_for(self, space: Space) -> homography.Matrix:
        with self._lock:
            matrix = self._surface if space == "surface" else self._display
        if matrix is None:
            raise RuntimeError(f"homography for '{space}' not computed yet")
        return matrix
