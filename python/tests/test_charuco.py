"""Synthetic checks for the printed ChArUco board, its pose and lens calibration.

Nothing here touches a camera. Views are either the printable sheet warped into
a known camera pose, or corner pixels projected straight from a known camera.
"""

from __future__ import annotations

import math
import zlib

import cv2
import numpy as np
import pytest
from numpy.typing import NDArray

from gosai_py.geometry import charuco
from gosai_py.geometry.camera_model import CameraModel

FRAME_W, FRAME_H = 1280, 720
HFOV_DEG = 70.0
SHEET_DPI = 150

type Array = NDArray[np.float64]


def _camera(dist: tuple[float, ...] = ()) -> CameraModel:
    base = CameraModel.from_hfov(FRAME_W, FRAME_H, HFOV_DEG)
    return CameraModel(base.width, base.height, base.fx, base.fy, base.cx, base.cy, dist)


def _pose(distance_mm: float, tilt_deg: float = 0.0, yaw_deg: float = 0.0) -> tuple[Array, Array]:
    """Board pose that centers the board in the frame at `distance_mm`."""
    tilt = cv2.Rodrigues(np.array([math.radians(tilt_deg), 0.0, 0.0]))[0]
    yaw = cv2.Rodrigues(np.array([0.0, math.radians(yaw_deg), 0.0]))[0]
    rotation = np.asarray(yaw @ tilt, dtype=np.float64)
    rvec = np.asarray(cv2.Rodrigues(rotation)[0], dtype=np.float64).reshape(3)
    center = np.array([charuco.BOARD_WIDTH_MM / 2.0, charuco.BOARD_HEIGHT_MM / 2.0, 0.0])
    # Put the board's middle on the optical axis at the wanted depth.
    tvec = np.array([0.0, 0.0, distance_mm]) - rotation @ center
    return rvec, tvec


def _render_view(
    camera: CameraModel,
    rvec: Array,
    tvec: Array,
    paper: charuco.Paper = "a4",
    noise: bool = False,
) -> tuple[NDArray[np.uint8], Array]:
    """The printed sheet as the camera would see it, plus the sheet-to-frame homography.

    The sheet is first shrunk to roughly its size in the frame, because warping
    a 150 dpi page straight down to a few hundred pixels aliases the markers
    away.
    """
    layout = charuco.sheet_layout(paper, SHEET_DPI)
    sheet = charuco.render_sheet(paper, SHEET_DPI)
    scale = float(camera.fx / (tvec[2] * layout.px_per_mm))
    small = cv2.resize(sheet, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    height, width = small.shape
    source = np.array(
        [[0.0, 0.0], [width - 1.0, 0.0], [width - 1.0, height - 1.0], [0.0, height - 1.0]]
    )
    corners_mm = layout.to_board_mm((source + 0.5) / scale - 0.5)
    projected, _ = cv2.projectPoints(
        np.column_stack([corners_mm, np.zeros(4)]),
        rvec,
        tvec,
        camera.matrix,
        camera.dist_coeffs,
    )
    homography = cv2.getPerspectiveTransform(
        source.astype(np.float32), np.asarray(projected, dtype=np.float32).reshape(-1, 2)
    )
    view = np.asarray(
        cv2.warpPerspective(
            small,
            homography,
            (FRAME_W, FRAME_H),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        ),
        dtype=np.uint8,
    )
    if noise:
        # A perfectly sharp render flatters the corner detector. Soften the
        # edges and add sensor noise before measuring accuracy.
        rng = np.random.default_rng(int(abs(tvec[2])))
        blurred = cv2.GaussianBlur(view, (3, 3), 0.8).astype(np.float64)
        view = np.clip(blurred + rng.normal(0.0, 3.0, blurred.shape), 0, 255).astype(np.uint8)
    return view, np.asarray(homography, dtype=np.float64) @ _scale_matrix(scale)


def _scale_matrix(scale: float) -> Array:
    """Sheet pixels at full resolution to the shrunk sheet's pixels."""
    return np.array([[scale, 0.0, 0.5 * scale - 0.5], [0.0, scale, 0.5 * scale - 0.5], [0, 0, 1.0]])


def _apply(homography: Array, point: Array) -> Array:
    out = homography @ np.array([point[0], point[1], 1.0])
    return np.asarray(out[:2] / out[2], dtype=np.float64)


def _ink_center(sheet: NDArray[np.uint8], x0: float, y0: float, x1: float, y1: float) -> Array:
    """Centroid of the dark pixels in a sheet window, in sheet pixels."""
    window = sheet[round(float(y0)) : round(float(y1)), round(float(x0)) : round(float(x1))]
    weight = 255.0 - window.astype(np.float64)
    total = weight.sum()
    assert total > 0.0, "expected ink in this window"
    rows, columns = np.indices(window.shape)
    return np.array(
        [
            x0 + float((weight * columns).sum() / total),
            y0 + float((weight * rows).sum() / total),
        ]
    )


def test_board_constants() -> None:
    assert charuco.board().getChessboardSize() == (charuco.SQUARES_X, charuco.SQUARES_Y)
    assert charuco.board().getSquareLength() == pytest.approx(charuco.SQUARE_MM)
    assert charuco.board().getMarkerLength() == pytest.approx(charuco.MARKER_MM)
    # Every interior corner, and the outer origin corner, live in the same frame.
    corners = np.asarray(charuco.board().getChessboardCorners(), dtype=np.float64)
    assert corners.shape == ((charuco.SQUARES_X - 1) * (charuco.SQUARES_Y - 1), 3)
    assert np.all(corners[:, 2] == 0.0)
    # Every interior corner is strictly inside the grid, so the origin is an
    # outer corner and no interior corner shares its position.
    assert corners[:, :2].min() >= charuco.SQUARE_MM
    assert corners[:, 0].max() <= charuco.BOARD_WIDTH_MM - charuco.SQUARE_MM
    assert corners[:, 1].max() <= charuco.BOARD_HEIGHT_MM - charuco.SQUARE_MM
    assert np.all(charuco.DESIGNATED_POINT_MM == 0.0)


@pytest.mark.parametrize("paper", ["a4", "letter"])
def test_sheet_fits_the_paper_at_exact_scale(paper: charuco.Paper) -> None:
    layout = charuco.sheet_layout(paper, 300)
    page_w, page_h = charuco.PAPER_MM[paper]
    assert layout.width_px == pytest.approx(page_w * layout.px_per_mm, abs=1)
    assert layout.height_px == pytest.approx(page_h * layout.px_per_mm, abs=1)
    # The printed square must be the square the detector assumes, to 0.1%.
    assert layout.square_px / layout.px_per_mm == pytest.approx(charuco.SQUARE_MM, rel=1e-3)
    sheet = charuco.render_sheet(paper, SHEET_DPI)
    assert sheet.shape == (
        charuco.sheet_layout(paper, SHEET_DPI).height_px,
        charuco.sheet_layout(paper, SHEET_DPI).width_px,
    )
    # Margins stay inside what a desktop printer can put on the page.
    margins_mm = [
        layout.board_left / layout.px_per_mm,
        layout.board_top / layout.px_per_mm,
        (layout.width_px - layout.board_left - charuco.SQUARES_X * layout.square_px)
        / layout.px_per_mm,
        (layout.height_px - layout.board_top - charuco.SQUARES_Y * layout.square_px)
        / layout.px_per_mm,
    ]
    assert min(margins_mm) > 8.0


@pytest.mark.parametrize("paper", ["a4", "letter"])
def test_sheet_ruler_measures_100_mm(paper: charuco.Paper) -> None:
    layout = charuco.sheet_layout(paper, SHEET_DPI)
    sheet = charuco.render_sheet(paper, SHEET_DPI)
    axis, top, bottom = layout.ruler_px
    # The ruler's own axis column, windowed to the ruler's half of the margin:
    # its ink runs from the 0 mm tick to the 100 mm one.
    margin = round(20.0 * layout.px_per_mm)
    y0, y1 = round(top) - margin, round(bottom) + margin
    ink = np.argwhere(sheet[y0:y1, round(axis)] < 128).ravel()
    assert (ink.max() - ink.min()) / layout.px_per_mm == pytest.approx(
        charuco.RULER_LENGTH_MM, abs=0.5
    )
    assert (bottom - top) / layout.px_per_mm == pytest.approx(charuco.RULER_LENGTH_MM)
    assert "100 mm" in charuco.RULER_CAPTION and "100%" in charuco.RULER_CAPTION


def test_origin_mark_points_at_the_board_origin() -> None:
    """The printed crosshair is centered on the corner the board calls (0, 0, 0)."""
    layout = charuco.sheet_layout("a4", SHEET_DPI)
    sheet = charuco.render_sheet("a4", SHEET_DPI)
    mm = layout.px_per_mm
    cx, cy = layout.origin_px
    # The two arms live in the margin only, away from ring, label and ruler.
    horizontal = _ink_center(
        sheet,
        cx - charuco.MARK_ARM_OUTER_MM * mm,
        cy - 4.0 * mm,
        cx - charuco.MARK_ARM_INNER_MM * mm,
        cy + 4.0 * mm,
    )
    vertical = _ink_center(
        sheet,
        cx - 4.0 * mm,
        cy - charuco.MARK_ARM_OUTER_MM * mm,
        cx + 4.0 * mm,
        cy - charuco.MARK_ARM_INNER_MM * mm,
    )
    assert horizontal[1] == pytest.approx(cy, abs=1.0)
    assert vertical[0] == pytest.approx(cx, abs=1.0)


def test_designated_point_projects_onto_the_printed_mark() -> None:
    """Render the marked sheet, look at it from a known pose, and follow the corner back."""
    camera = _camera()
    rvec, tvec = _pose(600.0, tilt_deg=-18.0, yaw_deg=12.0)
    view, homography = _render_view(camera, rvec, tvec)
    layout = charuco.sheet_layout("a4", SHEET_DPI)

    observation = charuco.detect(view)
    assert observation is not None
    assert observation.marker_count >= 8
    pose = charuco.estimate_pose(observation, camera)
    assert pose is not None

    expected = _apply(homography, layout.origin_px)  # where the mark ended up in the frame
    projected = camera.project(pose.point_mm)
    assert np.linalg.norm(projected - expected) < 2.0
    # And the estimated 3D point is the true corner, not another one.
    assert np.linalg.norm(pose.point_mm - tvec) < 3.0


@pytest.mark.parametrize(
    ("distance_mm", "tolerance_mm"),
    [(800.0, 4.0), (1500.0, 1500.0 * 0.015)],
)
def test_pose_places_the_designated_point(distance_mm: float, tolerance_mm: float) -> None:
    camera = _camera()
    rvec, tvec = _pose(distance_mm, tilt_deg=-20.0, yaw_deg=15.0)
    view, _ = _render_view(camera, rvec, tvec, noise=True)
    observation = charuco.detect(view)
    assert observation is not None
    assert observation.sharpness > 0.0
    assert len(observation.hull_px) >= 4
    pose = charuco.estimate_pose(observation, camera)
    assert pose is not None
    assert pose.rms_px < 1.0
    assert np.linalg.norm(pose.point_mm - tvec) < tolerance_mm
    true_tilt = math.degrees(math.acos(abs(cv2.Rodrigues(rvec)[0][2, 2])))
    assert pose.tilt_deg == pytest.approx(true_tilt, abs=1.5)


def test_ambiguity_is_small_for_a_close_tilted_board() -> None:
    camera = _camera()
    rvec, tvec = _pose(500.0, tilt_deg=-35.0, yaw_deg=20.0)
    view, _ = _render_view(camera, rvec, tvec, noise=True)
    observation = charuco.detect(view)
    assert observation is not None
    pose = charuco.estimate_pose(observation, camera)
    assert pose is not None
    assert pose.tilt_deg > 30.0
    assert pose.ambiguity_mm < 5.0
    assert np.linalg.norm(pose.point_mm - tvec) < 3.0


def test_ambiguity_grows_when_the_board_is_far_and_flat() -> None:
    """The field has to react, otherwise a small `ambiguity_mm` proves nothing."""
    camera = _camera()
    rvec, tvec = _pose(2000.0, tilt_deg=-20.0, yaw_deg=15.0)
    view, _ = _render_view(camera, rvec, tvec)
    observation = charuco.detect(view)
    assert observation is not None
    pose = charuco.estimate_pose(observation, camera)
    assert pose is not None
    assert pose.ambiguity_mm > 20.0


def test_detect_returns_none_without_a_board() -> None:
    assert charuco.detect(np.full((FRAME_H, FRAME_W), 255, np.uint8)) is None
    assert charuco.detect(np.zeros((FRAME_H, FRAME_W, 3), np.uint8)) is None


def test_detect_accepts_bgr_and_gray() -> None:
    camera = _camera()
    rvec, tvec = _pose(700.0, tilt_deg=-10.0)
    view, _ = _render_view(camera, rvec, tvec)
    gray = charuco.detect(view)
    color = charuco.detect(cv2.cvtColor(view, cv2.COLOR_GRAY2BGR))
    assert gray is not None and color is not None
    assert np.allclose(gray.corners_px, color.corners_px)
    assert gray.frame_size == (FRAME_W, FRAME_H)


def _synthetic_observation(
    camera: CameraModel,
    rvec: Array,
    tvec: Array,
    rng: np.random.Generator,
    noise_px: float = 0.2,
    sharpness: float = 300.0,
) -> charuco.BoardObservation | None:
    """Corners a perfect detector would report for this pose, with a little noise."""
    object_points = np.asarray(charuco.board().getChessboardCorners(), dtype=np.float64)
    pixels, _ = cv2.projectPoints(object_points, rvec, tvec, camera.matrix, camera.dist_coeffs)
    pixels = np.asarray(pixels, dtype=np.float64).reshape(-1, 2)
    pixels += rng.normal(0.0, noise_px, pixels.shape)
    inside = (
        (pixels[:, 0] > 0)
        & (pixels[:, 0] < FRAME_W)
        & (pixels[:, 1] > 0)
        & (pixels[:, 1] < FRAME_H)
    )
    if inside.sum() < charuco.CALIBRATION_MIN_CORNERS:
        return None
    ids = np.arange(len(object_points), dtype=np.int32)[inside]
    return charuco.BoardObservation.from_corners(
        ids, pixels[inside], int(inside.sum()), (FRAME_W, FRAME_H), sharpness
    )


def _calibration_views(camera: CameraModel, count: int = 22) -> list[charuco.BoardObservation]:
    """Board poses spread over the frame, over depth and over tilt."""
    rng = np.random.default_rng(7)
    views: list[charuco.BoardObservation] = []
    for i in range(count):
        depth = 520.0 + 90.0 * (i % 5)
        tilt = -35.0 + 14.0 * (i % 6)
        yaw = -30.0 + 12.0 * (i % 7)
        rvec, tvec = _pose(depth, tilt_deg=tilt, yaw_deg=yaw)
        # Slide the board around so the corners reach the frame edges.
        tvec = tvec + np.array(
            [0.40 * depth * math.cos(i * 1.9), 0.22 * depth * math.sin(i * 2.7), 0.0]
        )
        observation = _synthetic_observation(camera, rvec, tvec, rng)
        if observation is not None:
            views.append(observation)
    return views


def test_calibrator_recovers_a_known_lens() -> None:
    truth = _camera(dist=(-0.24, 0.07, 0.0012, -0.0008))
    calibrator = charuco.LensCalibrator()
    for observation in _calibration_views(truth):
        calibrator.offer(observation)
    assert calibrator.views >= charuco.MIN_SOLVE_VIEWS
    assert calibrator.coverage > 0.5
    assert calibrator.hint == "ready"
    assert calibrator.progress == pytest.approx(1.0)

    result = calibrator.solve()
    assert result.rms_px < 0.5
    assert result.views >= charuco.MIN_SOLVE_VIEWS
    assert result.camera.fx == pytest.approx(truth.fx, rel=0.02)
    assert result.camera.fy == pytest.approx(truth.fy, rel=0.02)
    assert result.camera.cx == pytest.approx(truth.cx, abs=0.02 * FRAME_W)
    assert result.camera.cy == pytest.approx(truth.cy, abs=0.02 * FRAME_H)
    assert result.camera.dist[0] == pytest.approx(truth.dist[0], abs=0.03)
    assert result.camera.dist[1] == pytest.approx(truth.dist[1], abs=0.05)
    assert len(result.camera.dist) == 4  # k3 is fixed at zero and not carried around
    assert result.hfov_deg == pytest.approx(HFOV_DEG, abs=2.0)


def test_calibrator_rejects_duplicates_and_blur() -> None:
    camera = _camera()
    rng = np.random.default_rng(3)
    rvec, tvec = _pose(700.0, tilt_deg=-20.0, yaw_deg=10.0)
    first = _synthetic_observation(camera, rvec, tvec, rng)
    assert first is not None
    calibrator = charuco.LensCalibrator()
    assert calibrator.offer(first) is True

    nudged = _synthetic_observation(camera, rvec, tvec + np.array([6.0, 4.0, 3.0]), rng)
    assert nudged is not None
    assert calibrator.offer(nudged) is False  # same place, same size, same shape

    blurred = _synthetic_observation(camera, *_pose(900.0, yaw_deg=-25.0), rng, sharpness=40.0)
    assert blurred is not None
    assert calibrator.offer(blurred) is False  # different view, but out of focus

    moved = _synthetic_observation(camera, *_pose(1100.0, tilt_deg=25.0, yaw_deg=-25.0), rng)
    assert moved is not None
    assert calibrator.offer(moved) is True
    assert calibrator.views == 2

    small = charuco.BoardObservation.from_corners(
        first.corner_ids[:4], first.corners_px[:4], 4, (FRAME_W, FRAME_H), 300.0
    )
    assert calibrator.offer(small) is False


def test_calibrator_progress_and_hints() -> None:
    camera = _camera()
    calibrator = charuco.LensCalibrator()
    assert calibrator.views == 0
    assert calibrator.coverage == 0.0
    assert calibrator.progress == 0.0
    assert calibrator.hint in {"more_views", "cover_edges", "tilt_board"}

    rng = np.random.default_rng(11)
    flat = [_synthetic_observation(camera, *_pose(500.0 + 120.0 * i), rng) for i in range(5)]
    for observation in flat:
        assert observation is not None
        calibrator.offer(observation)
    assert calibrator.views > 0
    assert calibrator.hint == "tilt_board"  # nothing is foreshortened yet
    assert 0.0 < calibrator.progress < 1.0

    with pytest.raises(charuco.CalibrationError, match="at least"):
        calibrator.solve()

    calibrator.reset()
    assert calibrator.views == 0
    assert calibrator.coverage == 0.0
    assert calibrator.hint == "more_views"


@pytest.mark.parametrize("paper", ["a4", "letter"])
def test_pdf_is_a_true_size_single_page(paper: charuco.Paper) -> None:
    data = charuco.sheet_pdf(paper, dpi=100)
    assert data.startswith(b"%PDF")
    assert data.rstrip().endswith(b"%%EOF")
    page_w, page_h = charuco.PAPER_MM[paper]
    expected = f"/MediaBox [0 0 {page_w * charuco.PT_PER_MM:.4f} {page_h * charuco.PT_PER_MM:.4f}]"
    assert expected.encode("ascii") in data

    layout = charuco.sheet_layout(paper, 100)
    assert f"/Width {layout.width_px} /Height {layout.height_px}".encode("ascii") in data
    start = data.index(b"/Filter /FlateDecode")
    start = data.index(b"stream\n", start) + len(b"stream\n")
    end = data.index(b"\nendstream", start)
    pixels = zlib.decompress(data[start:end])
    assert len(pixels) == layout.width_px * layout.height_px

    decoded = np.frombuffer(pixels, np.uint8).reshape(layout.height_px, layout.width_px)
    assert np.array_equal(decoded, charuco.render_sheet(paper, 100))


def test_cli_writes_a_pdf(tmp_path) -> None:
    out = tmp_path / "board.pdf"
    assert charuco.main(["--paper", "letter", "--out", str(out), "--dpi", "100"]) == 0
    assert out.read_bytes().startswith(b"%PDF")
