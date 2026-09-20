"""The printed ChArUco board: the metric reference the mirror calibration leans on.

One sheet of paper carries a 4 x 6 ChArUco board at known size. Detecting it
gives a metric pose, so a single webcam can report where a real point is in
camera millimeters without knowing anything about the scene. Two jobs use it:

- Lens calibration. The user waves the sheet around, `LensCalibrator` keeps the
  sharp and mutually different views, and OpenCV turns them into a `CameraModel`.
- Rig calibration. The user lines up the reflection of one printed corner, the
  designated point, with a target on the screen. `estimate_pose` gives that
  corner's 3D position, `mirror_rig.fit_rig` turns a handful of those into the
  mirror pose.

Board coordinates are millimeters, x along the 4-square side, y along the
6-square side and z through the paper away from the camera, so a board held
square to the camera has its axes lined up with the camera's own. The origin is
the outer corner of the chessboard grid, printed at the top left of the sheet
inside a ring and a crosshair: `DESIGNATED_POINT_MM`. Camera coordinates are
those of `camera_model`: x right, y down, z forward, in millimeters.

Pose from a planar target has the usual two-fold ambiguity when the board looks
frontal or small. We only need one point, so `BoardPose` reports how far apart
the two solutions place that point instead of hiding the problem.
"""

from __future__ import annotations

import argparse
import math
import zlib
from collections.abc import Sequence
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal, cast

import cv2
import numpy as np
from numpy.typing import NDArray

from .camera_model import CameraModel

type Array = NDArray[np.float64]
type Gray = NDArray[np.uint8]
type Paper = Literal["a4", "letter"]

# Board definition. 4 x 6 squares of 42 mm is 168 x 252 mm, which leaves a
# usable margin on both A4 and US Letter. A 31 mm marker spans about 19 px at
# 1.5 m on a 720p camera with a typical 70 degree lens, enough for DICT_4X4_50,
# whose 4 x 4 cells stay readable when the board gets small.
SQUARES_X = 4
SQUARES_Y = 6
SQUARE_MM = 42.0
MARKER_MM = 31.0
DICTIONARY_ID = cv2.aruco.DICT_4X4_50
BOARD_WIDTH_MM = SQUARES_X * SQUARE_MM
BOARD_HEIGHT_MM = SQUARES_Y * SQUARE_MM

# The board-frame origin: the outer grid corner the user aligns in the mirror.
DESIGNATED_POINT_MM: Array = np.zeros(3)
DESIGNATED_POINT_MM.flags.writeable = False

PAPER_MM: dict[str, tuple[float, float]] = {"a4": (210.0, 297.0), "letter": (215.9, 279.4)}
PT_PER_MM = 72.0 / 25.4

# Sheet layout, all in millimeters. The ruler sits in the left margin because
# US Letter is only 27 mm taller than the board, and the marked corner needs
# the room at the top more than the ruler does.
RULER_LENGTH_MM = 100.0
RULER_TICK_MM = 10.0
RULER_BAND_MM = 16.0
RULER_CAPTION = "Print at 100% (actual size). This ruler must measure 100 mm."
# Room kept above the board for the corner mark, when the paper allows it.
TOP_MARGIN_MM = 18.0
MARK_RING_MM = 5.0
MARK_ARM_INNER_MM = 7.0
MARK_ARM_OUTER_MM = 12.0
MARK_LABEL = "ORIGIN"

MIN_CORNERS = 6

# Pose is only trusted in front of the camera, and far enough that the board
# cannot be a degenerate fit.
MIN_DEPTH_MM = 50.0

# The second IPPE solution counts as a real alternative only while it explains
# the image about as well as the first. The floor keeps a noise-free synthetic
# fit from making every ratio enormous.
AMBIGUITY_ERROR_RATIO = 2.0
AMBIGUITY_ERROR_FLOOR_PX = 0.3


@cache
def board() -> cv2.aruco.CharucoBoard:
    """The one board this project prints and detects."""
    dictionary = cv2.aruco.getPredefinedDictionary(DICTIONARY_ID)
    return cv2.aruco.CharucoBoard((SQUARES_X, SQUARES_Y), SQUARE_MM, MARKER_MM, dictionary)


@cache
def _detector() -> cv2.aruco.CharucoDetector:
    return cv2.aruco.CharucoDetector(board())


@dataclass(frozen=True)
class SheetLayout:
    """Where the board sits on the printed page, in sheet pixels.

    A board point in millimeters lands at `board_left + x * px_per_mm - 0.5`,
    the half pixel being OpenCV's pixel-center convention: a corner detected in
    the rendered sheet returns exactly that value.
    """

    paper: str
    dpi: int
    width_px: int
    height_px: int
    px_per_mm: float
    square_px: int
    board_left: int
    board_top: int

    @property
    def origin_px(self) -> Array:
        """Sheet pixel of `DESIGNATED_POINT_MM`, where the mark is centered."""
        return self.to_sheet_px([[0.0, 0.0]])[0]

    def to_sheet_px(self, points_mm: Sequence[Sequence[float]] | Array) -> Array:
        """(..., 2) board millimeters to sheet pixels."""
        mm = np.asarray(points_mm, dtype=np.float64)
        offset = np.array([self.board_left, self.board_top], dtype=np.float64) - 0.5
        return mm[..., :2] * self.px_per_mm + offset

    def to_board_mm(self, pixels: Sequence[Sequence[float]] | Array) -> Array:
        """(..., 2) sheet pixels back to board millimeters. Points off the board are fine."""
        px = np.asarray(pixels, dtype=np.float64)
        offset = np.array([self.board_left, self.board_top], dtype=np.float64) - 0.5
        return (px[..., :2] - offset) / self.px_per_mm

    @property
    def ruler_px(self) -> tuple[float, float, float]:
        """The ruler's axis: its x, and the y of its 0 mm and 100 mm ends."""
        x = RULER_BAND_MM * 0.6 * self.px_per_mm
        center = self.board_top + SQUARES_Y * self.square_px / 2.0
        half = RULER_LENGTH_MM * self.px_per_mm / 2.0
        return x, center - half, center + half


def sheet_layout(paper: Paper, dpi: int = 300) -> SheetLayout:
    """Page and board geometry for one paper size and print resolution."""
    if paper not in PAPER_MM:
        raise ValueError(f"unknown paper size {paper!r}, expected one of {sorted(PAPER_MM)}")
    page_w, page_h = PAPER_MM[paper]
    # Round the square to whole pixels, then derive the page scale from it, so
    # the squares are identical and the printed scale error stays under 0.1 px.
    square_px = max(round(SQUARE_MM * dpi / 25.4), 8)
    px_per_mm = square_px / SQUARE_MM
    width_px = round(page_w * px_per_mm)
    height_px = round(page_h * px_per_mm)
    board_w = SQUARES_X * square_px
    board_h = SQUARES_Y * square_px
    slack = height_px - board_h
    # Centered when the paper is generous, pushed down when centering would put
    # the marked corner too close to the edge a printer cannot reach.
    top = max(slack // 2, min(round(TOP_MARGIN_MM * px_per_mm), slack))
    return SheetLayout(
        paper=paper,
        dpi=dpi,
        width_px=width_px,
        height_px=height_px,
        px_per_mm=px_per_mm,
        square_px=square_px,
        board_left=(width_px - board_w) // 2,
        board_top=max(top, 0),
    )


def _px(value: float) -> int:
    """Nearest whole pixel, for OpenCV's integer drawing calls."""
    return round(float(value))


def _text_scale(text: str, font: int, height_px: float) -> tuple[float, int]:
    """Font scale and thickness whose capital height is about `height_px`."""
    thickness = max(_px(height_px / 8.0), 1)
    (_, base_height), _ = cv2.getTextSize(text, font, 1.0, thickness)
    return height_px / max(base_height, 1), thickness


def _draw_ruler(sheet: Gray, layout: SheetLayout) -> None:
    """A 100 mm ruler with 10 mm ticks in the left margin, caption reading upward."""
    mm = layout.px_per_mm
    line = max(_px(0.35 * mm), 1)
    axis, top, bottom = layout.ruler_px
    axis_x, y0, y1 = _px(axis), _px(top), _px(bottom)
    center_y = (top + bottom) / 2.0
    cv2.line(sheet, (axis_x, y0), (axis_x, y1), 0, line)
    ticks = _px(RULER_LENGTH_MM / RULER_TICK_MM)
    for i in range(ticks + 1):
        y = _px(y0 + (y1 - y0) * i / ticks)
        length = 0.55 if i in (0, ticks) else 0.35
        cv2.line(sheet, (axis_x, y), (axis_x + _px(length * RULER_BAND_MM * mm), y), 0, line)

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale, thickness = _text_scale(RULER_CAPTION, font, 3.2 * mm)
    (text_w, text_h), baseline = cv2.getTextSize(RULER_CAPTION, font, scale, thickness)
    strip = np.full((text_h + baseline + 2, text_w + 2), 255, np.uint8)
    cv2.putText(strip, RULER_CAPTION, (1, text_h + 1), font, scale, 0, thickness, cv2.LINE_AA)
    strip = np.rot90(strip)  # reads bottom to top along the ruler
    x = max(axis_x - _px(1.5 * mm) - strip.shape[1], 0)
    y = max(min(_px(center_y - strip.shape[0] / 2.0), layout.height_px - strip.shape[0]), 0)
    patch = sheet[y : y + strip.shape[0], x : x + strip.shape[1]]
    np.minimum(patch, strip[: patch.shape[0], : patch.shape[1]], out=patch)


def _draw_origin_mark(sheet: Gray, layout: SheetLayout) -> None:
    """Ring, crosshair and label around the designated corner.

    Everything is drawn before the board is pasted, so the quarter of the ring
    that falls on the pattern is overwritten and no marker or interior corner is
    covered. What remains is a three quarter ring in the margin with two arms
    pointing at the corner from outside.
    """
    mm = layout.px_per_mm
    cx, cy = (_px(v) for v in layout.origin_px)
    bold = max(_px(0.8 * mm), 1)
    cv2.circle(sheet, (cx, cy), _px(MARK_RING_MM * mm), 0, bold, cv2.LINE_AA)
    inner, outer = _px(MARK_ARM_INNER_MM * mm), _px(MARK_ARM_OUTER_MM * mm)
    cv2.line(sheet, (cx - inner, cy), (cx - outer, cy), 0, bold, cv2.LINE_AA)
    cv2.line(sheet, (cx, cy - inner), (cx, cy - outer), 0, bold, cv2.LINE_AA)

    font = cv2.FONT_HERSHEY_SIMPLEX
    scale, thickness = _text_scale(MARK_LABEL, font, 3.5 * mm)
    cv2.putText(
        sheet,
        MARK_LABEL,
        (cx + _px(MARK_ARM_INNER_MM * mm), cy - _px(2.0 * mm)),
        font,
        scale,
        0,
        thickness,
        cv2.LINE_AA,
    )


def render_sheet(paper: Paper = "a4", dpi: int = 300) -> Gray:
    """The printable page as a grayscale image: board at exact scale, ruler, corner mark."""
    layout = sheet_layout(paper, dpi)
    sheet = np.full((layout.height_px, layout.width_px), 255, np.uint8)
    _draw_ruler(sheet, layout)
    _draw_origin_mark(sheet, layout)
    pattern = board().generateImage(
        (SQUARES_X * layout.square_px, SQUARES_Y * layout.square_px), marginSize=0
    )
    top, left = layout.board_top, layout.board_left
    sheet[top : top + pattern.shape[0], left : left + pattern.shape[1]] = pattern
    return sheet


def sheet_pdf(paper: Paper = "a4", dpi: int = 300) -> bytes:
    """A one page PDF of `render_sheet`, sized so printing at 100% gives true size.

    Written by hand to avoid a PDF dependency: catalog, pages, page, one
    FlateDecode grayscale image and a content stream that stretches the image
    over the whole MediaBox.
    """
    image = render_sheet(paper, dpi)
    height_px, width_px = image.shape
    page_w_mm, page_h_mm = PAPER_MM[paper]
    w_pt, h_pt = page_w_mm * PT_PER_MM, page_h_mm * PT_PER_MM
    pixels = zlib.compress(image.tobytes(), 9)
    content = f"q\n{w_pt:.4f} 0 0 {h_pt:.4f} 0 0 cm\n/Im0 Do\nQ\n".encode("ascii")
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w_pt:.4f} {h_pt:.4f}] "
            f"/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"
        ).encode("ascii"),
        (
            f"<< /Type /XObject /Subtype /Image /Width {width_px} /Height {height_px} "
            f"/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode "
            f"/Length {len(pixels)} >>\nstream\n"
        ).encode("ascii")
        + pixels
        + b"\nendstream",
        f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"endstream",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii") + b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ).encode("ascii")
    return bytes(out)


@dataclass(frozen=True)
class BoardObservation:
    """One detection of the board in one frame, in unflipped camera pixels.

    `sharpness` is the variance of the Laplacian inside the board's bounding
    box. It says nothing absolute: it depends on the camera, the lighting and
    how large the board is in the frame, so only compare it with other frames
    from the same session. `hull_px` is the convex hull of everything detected,
    for drawing over the camera preview.
    """

    corner_ids: NDArray[np.int32]
    corners_px: Array
    marker_count: int
    frame_size: tuple[int, int]
    sharpness: float
    hull_px: Array

    @classmethod
    def from_corners(
        cls,
        corner_ids: Sequence[int] | NDArray[np.int32],
        corners_px: Sequence[Sequence[float]] | Array,
        marker_count: int,
        frame_size: tuple[int, int],
        sharpness: float,
    ) -> BoardObservation:
        """Build an observation from corners alone, deriving the hull."""
        corners = np.asarray(corners_px, dtype=np.float64).reshape(-1, 2)
        return cls(
            corner_ids=np.asarray(corner_ids, dtype=np.int32).reshape(-1),
            corners_px=corners,
            marker_count=marker_count,
            frame_size=frame_size,
            sharpness=sharpness,
            hull_px=_hull(corners),
        )

    @property
    def center_px(self) -> Array:
        return np.asarray(self.corners_px.mean(axis=0), dtype=np.float64)

    @property
    def size_px(self) -> float:
        """Apparent size: the side of a square with the hull's area."""
        area = float(cv2.contourArea(self.hull_px.astype(np.float32)))
        return math.sqrt(max(area, 0.0))


def _hull(points: Array) -> Array:
    hull = cv2.convexHull(points.astype(np.float32))
    return np.asarray(hull, dtype=np.float64).reshape(-1, 2)


def _to_gray(image: NDArray) -> Gray:
    if image.ndim == 3:
        return np.asarray(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), dtype=np.uint8)
    return np.ascontiguousarray(image, dtype=np.uint8)


def _sharpness(gray: Gray, corners: Array) -> float:
    """Variance of the Laplacian over the board's bounding box, clipped to the frame."""
    height, width = gray.shape
    low = np.floor(corners.min(axis=0)).astype(int)
    high = np.ceil(corners.max(axis=0)).astype(int) + 1
    x0, y0 = max(int(low[0]), 0), max(int(low[1]), 0)
    x1, y1 = min(int(high[0]), width), min(int(high[1]), height)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return 0.0
    return float(cv2.Laplacian(gray[y0:y1, x0:x1], cv2.CV_64F).var())


def detect(image: NDArray) -> BoardObservation | None:
    """Find the board in a BGR or grayscale frame. None when too little is visible."""
    gray = _to_gray(image)
    corners, ids, marker_corners, _ = _detector().detectBoard(gray)
    if corners is None or ids is None or len(ids) < MIN_CORNERS:
        return None
    corner_px = np.asarray(corners, dtype=np.float64).reshape(-1, 2)
    corner_ids = np.asarray(ids, dtype=np.int32).reshape(-1)
    markers = (
        np.concatenate([np.asarray(m, dtype=np.float64).reshape(-1, 2) for m in marker_corners])
        if marker_corners is not None and len(marker_corners) > 0
        else corner_px
    )
    height, width = gray.shape
    return BoardObservation(
        corner_ids=corner_ids,
        corners_px=corner_px,
        marker_count=0 if marker_corners is None else len(marker_corners),
        frame_size=(width, height),
        sharpness=_sharpness(gray, corner_px),
        hull_px=_hull(np.concatenate([corner_px, markers])),
    )


def matched_points(observation: BoardObservation) -> tuple[Array, Array]:
    """Board millimeters (N, 3) and pixels (N, 2) of the detected chessboard corners."""
    corners = observation.corners_px.reshape(-1, 1, 2).astype(np.float32)
    ids = observation.corner_ids.reshape(-1, 1).astype(np.int32)
    # The stubs only describe the marker overload, which takes a list of quads.
    object_points, image_points = cast(Any, board()).matchImagePoints(corners, ids)
    return (
        np.asarray(object_points, dtype=np.float64).reshape(-1, 3),
        np.asarray(image_points, dtype=np.float64).reshape(-1, 2),
    )


@dataclass(frozen=True)
class BoardPose:
    """The board in camera millimeters, plus what the planar ambiguity costs us.

    `point_mm` is the designated corner, the only thing the rig calibration
    consumes. `ambiguity_mm` is how far the other IPPE solution would move it,
    and stays 0 when that solution fits clearly worse or does not exist: small
    means the ambiguity does not matter here, whatever the rest of the pose
    does. `tilt_deg` is the acute angle between the board normal and the camera
    axis, so 0 is a board facing the camera head on.
    """

    rvec: Array
    tvec: Array
    rms_px: float
    point_mm: Array
    ambiguity_mm: float
    tilt_deg: float


def _designated_in_camera(rvec: Array, tvec: Array) -> Array:
    rotation, _ = cv2.Rodrigues(rvec)
    return np.asarray(rotation, dtype=np.float64) @ DESIGNATED_POINT_MM + tvec


def _solution_error(
    object_points: Array, image_points: Array, camera: CameraModel, rvec: Array, tvec: Array
) -> float:
    projected, _ = cv2.projectPoints(
        object_points.reshape(-1, 1, 3), rvec, tvec, camera.matrix, camera.dist_coeffs
    )
    residual = np.asarray(projected, dtype=np.float64).reshape(-1, 2) - image_points
    return float(np.sqrt(np.mean(np.sum(residual**2, axis=1))))


def estimate_pose(observation: BoardObservation, camera: CameraModel) -> BoardPose | None:
    """Board pose from one observation, keeping both planar solutions to measure the ambiguity."""
    object_points, image_points = matched_points(observation)
    if len(object_points) < 4:
        return None
    ok, rvecs, tvecs, _ = cv2.solvePnPGeneric(
        object_points.reshape(-1, 1, 3).astype(np.float64),
        image_points.reshape(-1, 1, 2).astype(np.float64),
        camera.matrix,
        camera.dist_coeffs,
        flags=cv2.SOLVEPNP_IPPE,
    )
    if not ok or rvecs is None or len(rvecs) == 0:
        return None

    solutions: list[tuple[float, Array, Array, Array]] = []
    for rvec, tvec in zip(rvecs, tvecs, strict=True):
        rvec = np.asarray(rvec, dtype=np.float64).reshape(3)
        tvec = np.asarray(tvec, dtype=np.float64).reshape(3)
        rotation, _ = cv2.Rodrigues(rvec)
        depths = (object_points @ np.asarray(rotation).T + tvec)[:, 2]
        if depths.min() < MIN_DEPTH_MM:  # the board would be behind or inside the camera
            continue
        error = _solution_error(object_points, image_points, camera, rvec, tvec)
        solutions.append((error, rvec, tvec, _designated_in_camera(rvec, tvec)))
    if not solutions:
        return None

    solutions.sort(key=lambda s: s[0])
    error, rvec, tvec, point = solutions[0]
    ambiguity = 0.0
    if len(solutions) > 1:
        cutoff = AMBIGUITY_ERROR_RATIO * max(error, AMBIGUITY_ERROR_FLOOR_PX)
        if solutions[1][0] <= cutoff:
            ambiguity = float(np.linalg.norm(point - solutions[1][3]))
    rotation, _ = cv2.Rodrigues(rvec)
    normal = np.asarray(rotation, dtype=np.float64)[:, 2]
    tilt = math.degrees(math.acos(min(abs(float(normal[2])), 1.0)))
    return BoardPose(
        rvec=rvec,
        tvec=tvec,
        rms_px=error,
        point_mm=point,
        ambiguity_mm=ambiguity,
        tilt_deg=tilt,
    )


# Lens calibration. The thresholds are relative to the frame or to the running
# reference, because a fixed pixel or Laplacian number means nothing across
# cameras and resolutions.
CALIBRATION_MIN_CORNERS = 8
# A frame is sharp enough when it reaches this fraction of the recent best. The
# reference fades so one exceptionally sharp frame cannot block the session.
SHARPNESS_FRACTION = 0.5
SHARPNESS_DECAY = 0.98
# A view is new when it differs from every kept view in at least one of these.
MOVE_FRACTION = 0.10  # board center, as a fraction of the frame diagonal
SIZE_FRACTION = 0.15  # apparent size, relative
PERSPECTIVE_CHANGE = 0.10  # foreshortening signature, see `_perspective`
# A view counts as tilted when the far edge is this much farther than the near
# one, in relative depth across the board.
TILTED_PERSPECTIVE = 0.15

COVERAGE_CELLS = 4
VIEW_TARGET = 20
COVERAGE_TARGET = 0.75
TILTED_TARGET = 4

MIN_SOLVE_VIEWS = 8
MAX_SOLVE_RMS_PX = 1.5
MIN_HFOV_DEG = 30.0
MAX_HFOV_DEG = 120.0
# A view is an outlier when it is worse than both of these.
OUTLIER_PX = 1.0
OUTLIER_MEDIAN_RATIO = 2.0


class CalibrationError(RuntimeError):
    """The kept views do not give a usable lens."""


@dataclass(frozen=True)
class LensCalibration:
    camera: CameraModel
    rms_px: float
    views: int
    hfov_deg: float


def _perspective(object_points: Array, image_points: Array) -> Array:
    """How much the board is foreshortened, as relative depth change across it.

    The homography from board millimeters to pixels, normalized to `h22 = 1`,
    has a projective row `(h20, h21)`. The denominator `h20 * x + h21 * y + 1`
    is the depth relative to the origin corner, so scaling that row by the
    board's own size gives the depth change from edge to edge: 0 for a board
    facing the camera, 0.2 when the far edge is 20% farther. It needs no
    intrinsics, which is the point during lens calibration.
    """
    if len(object_points) < 4:
        return np.zeros(2)
    homography, _ = cv2.findHomography(
        object_points[:, :2].astype(np.float64), image_points.astype(np.float64), 0
    )
    if homography is None or abs(homography[2, 2]) < 1e-12:
        return np.zeros(2)
    row = np.asarray(homography, dtype=np.float64)[2] / homography[2, 2]
    return np.array([row[0] * BOARD_WIDTH_MM, row[1] * BOARD_HEIGHT_MM])


@dataclass(frozen=True)
class _View:
    """A kept observation with everything the novelty test and the solver need."""

    observation: BoardObservation
    object_points: Array
    image_points: Array
    center: Array
    size: float
    perspective: Array


class LensCalibrator:
    """Collects sharp, different-looking views of the board and solves for the lens.

    Pure state: no threads, no files, no camera. Feed it `detect` results and
    read `progress` and `hint` to drive the UI.
    """

    def __init__(self) -> None:
        self._views: list[_View] = []
        self._cells: NDArray[np.bool_] = np.zeros((COVERAGE_CELLS, COVERAGE_CELLS), dtype=bool)
        self._sharpness_reference: float = 0.0

    def reset(self) -> None:
        self._views.clear()
        self._cells[:] = False
        self._sharpness_reference = 0.0

    @property
    def views(self) -> int:
        return len(self._views)

    @property
    def frame_size(self) -> tuple[int, int] | None:
        return self._views[0].observation.frame_size if self._views else None

    def offer(self, observation: BoardObservation) -> bool:
        """Keep this view if it is sharp, well detected and unlike the kept ones."""
        self._sharpness_reference = max(
            observation.sharpness, self._sharpness_reference * SHARPNESS_DECAY
        )
        if observation.sharpness < SHARPNESS_FRACTION * self._sharpness_reference:
            return False
        if len(observation.corner_ids) < CALIBRATION_MIN_CORNERS:
            return False
        size = self.frame_size
        if size is not None and observation.frame_size != size:
            return False  # a resolution change invalidates the whole set

        object_points, image_points = matched_points(observation)
        if len(object_points) < CALIBRATION_MIN_CORNERS:
            return False
        view = _View(
            observation=observation,
            object_points=object_points,
            image_points=image_points,
            center=observation.center_px,
            size=observation.size_px,
            perspective=_perspective(object_points, image_points),
        )
        if not self._is_new(view):
            return False
        self._views.append(view)
        self._mark_coverage(observation)
        return True

    def _is_new(self, view: _View) -> bool:
        width, height = view.observation.frame_size
        diagonal = math.hypot(width, height)
        for kept in self._views:
            moved = float(np.linalg.norm(view.center - kept.center)) / diagonal
            resized = abs(view.size - kept.size) / max(kept.size, 1e-6)
            reshaped = float(np.linalg.norm(view.perspective - kept.perspective))
            if (
                moved <= MOVE_FRACTION
                and resized <= SIZE_FRACTION
                and reshaped <= PERSPECTIVE_CHANGE
            ):
                return False
        return True

    def _mark_coverage(self, observation: BoardObservation) -> None:
        width, height = observation.frame_size
        columns = np.clip(
            (observation.corners_px[:, 0] / max(width, 1) * COVERAGE_CELLS).astype(int),
            0,
            COVERAGE_CELLS - 1,
        )
        rows = np.clip(
            (observation.corners_px[:, 1] / max(height, 1) * COVERAGE_CELLS).astype(int),
            0,
            COVERAGE_CELLS - 1,
        )
        self._cells[rows, columns] = True

    @property
    def coverage(self) -> float:
        """Fraction of the 4 x 4 frame cells some kept corner landed in."""
        return float(self._cells.mean())

    @property
    def tilted_views(self) -> int:
        return sum(
            1 for v in self._views if float(np.linalg.norm(v.perspective)) >= TILTED_PERSPECTIVE
        )

    def _ratios(self) -> dict[str, float]:
        return {
            "more_views": min(self.views / VIEW_TARGET, 1.0),
            "cover_edges": min(self.coverage / COVERAGE_TARGET, 1.0),
            "tilt_board": min(self.tilted_views / TILTED_TARGET, 1.0),
        }

    @property
    def progress(self) -> float:
        return float(np.mean(list(self._ratios().values())))

    @property
    def hint(self) -> str:
        """What is missing: `more_views`, `cover_edges`, `tilt_board` or `ready`."""
        ratios = self._ratios()
        weakest = min(ratios, key=lambda key: ratios[key])
        return "ready" if ratios[weakest] >= 1.0 else weakest

    def solve(self) -> LensCalibration:
        """Calibrate on the kept views, drop the few that fit badly, calibrate once more."""
        if len(self._views) < MIN_SOLVE_VIEWS:
            raise CalibrationError(
                f"need at least {MIN_SOLVE_VIEWS} views, have {len(self._views)}; "
                "move the board around and let it collect more"
            )
        views = list(self._views)
        rms, camera, per_view = _calibrate(views)
        median = float(np.median(per_view))
        keep = [
            view
            for view, error in zip(views, per_view, strict=True)
            if error <= OUTLIER_PX or error <= OUTLIER_MEDIAN_RATIO * median
        ]
        if len(keep) < len(views):
            if len(keep) < MIN_SOLVE_VIEWS:
                raise CalibrationError(
                    f"only {len(keep)} of {len(views)} views fit a single lens; "
                    "recalibrate with a flat board and a steady camera"
                )
            views = keep
            rms, camera, _ = _calibrate(views)
        hfov = math.degrees(2.0 * math.atan(camera.width / (2.0 * camera.fx)))
        if rms > MAX_SOLVE_RMS_PX:
            raise CalibrationError(
                f"calibration residual {rms:.2f} px is too large; the board may be bent, "
                "out of focus or printed at the wrong scale"
            )
        if not MIN_HFOV_DEG <= hfov <= MAX_HFOV_DEG:
            raise CalibrationError(
                f"implausible horizontal field of view {hfov:.1f} degrees; "
                "collect views at more distances and tilts"
            )
        return LensCalibration(camera=camera, rms_px=rms, views=len(views), hfov_deg=hfov)


def _calibrate(views: Sequence[_View]) -> tuple[float, CameraModel, Array]:
    """One `calibrateCamera` pass: overall rms, the model, and the per-view rms."""
    object_points = [v.object_points.reshape(-1, 1, 3).astype(np.float32) for v in views]
    image_points = [v.image_points.reshape(-1, 1, 2).astype(np.float32) for v in views]
    width, height = views[0].observation.frame_size
    # k3 stays zero: a webcam's distortion is mild and one small board cannot
    # separate k3 from k1 and k2 without making the fit wander.
    rms, matrix, dist, rvecs, tvecs = cv2.calibrateCamera(
        object_points, image_points, (width, height), None, None, flags=cv2.CALIB_FIX_K3
    )
    matrix = np.asarray(matrix, dtype=np.float64)
    coefficients = np.asarray(dist, dtype=np.float64).reshape(-1)
    camera = CameraModel(
        width=float(width),
        height=float(height),
        fx=float(matrix[0, 0]),
        fy=float(matrix[1, 1]),
        cx=float(matrix[0, 2]),
        cy=float(matrix[1, 2]),
        dist=tuple(float(c) for c in coefficients[:4]),  # k1, k2, p1, p2
    )
    errors = []
    for view, rvec, tvec in zip(views, rvecs, tvecs, strict=True):
        errors.append(
            _solution_error(
                view.object_points,
                view.image_points,
                camera,
                np.asarray(rvec, dtype=np.float64),
                np.asarray(tvec, dtype=np.float64),
            )
        )
    return float(rms), camera, np.asarray(errors, dtype=np.float64)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the printable ChArUco calibration sheet.")
    parser.add_argument("--paper", choices=sorted(PAPER_MM), default="a4")
    parser.add_argument("--out", type=Path, default=Path("board.pdf"))
    parser.add_argument("--dpi", type=int, default=300)
    args = parser.parse_args(argv)
    paper: Paper = "letter" if args.paper == "letter" else "a4"
    data = sheet_pdf(paper, args.dpi)
    args.out.write_bytes(data)
    print(f"{args.out}: {len(data) / 1024:.0f} KB, {args.paper} at {args.dpi} dpi")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
