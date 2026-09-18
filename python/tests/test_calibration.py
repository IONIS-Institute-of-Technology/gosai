from __future__ import annotations

import base64

import cv2
import numpy as np
import pytest

from fakes import RecordingContext, check_events, check_result
from gosai_py.drivers.calibration import ARUCO_DICTIONARY, CalibrationDriver
from gosai_py.geometry.homography import (
    MarkerPlacement,
    compute_homographies,
    to_matrix,
    warp_points,
)

# Camera frame and marker placement: the display is the camera frame scaled by 2.
FRAME_W, FRAME_H = 800, 600
MARKER_PX = 100
CAMERA_CENTERS = [(150, 150), (650, 150), (650, 450), (150, 450), (400, 300)]
DISPLAY_SCALE = 2.0


def _frame() -> np.ndarray:
    image = np.full((FRAME_H, FRAME_W), 255, dtype=np.uint8)
    dictionary = cv2.aruco.getPredefinedDictionary(ARUCO_DICTIONARY)
    for marker_id, (cx, cy) in enumerate(CAMERA_CENTERS):
        marker = cv2.aruco.generateImageMarker(dictionary, marker_id, MARKER_PX)
        x0, y0 = cx - MARKER_PX // 2, cy - MARKER_PX // 2
        image[y0 : y0 + MARKER_PX, x0 : x0 + MARKER_PX] = marker
    return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)


def _layout() -> list[dict[str, float]]:
    return [
        {
            "id": i,
            "x": cx * DISPLAY_SCALE,
            "y": cy * DISPLAY_SCALE,
            "size": MARKER_PX * DISPLAY_SCALE,
        }
        for i, (cx, cy) in enumerate(CAMERA_CENTERS)
    ]


def _calibrated() -> tuple[CalibrationDriver, RecordingContext]:
    context = RecordingContext()
    driver = CalibrationDriver(context)
    driver.execute("set_marker_layout", _layout())
    driver.on_data(
        "camera", "frame", {"width": FRAME_W, "height": FRAME_H, "ts": 1.0, "_frame": _frame()}
    )
    return driver, context


def test_detects_markers_and_computes_both_homographies() -> None:
    driver, context = _calibrated()

    result = check_result(
        CalibrationDriver,
        "compute",
        driver.execute(
            "compute",
            {
                "focus_quad": [{"x": 0.25, "y": 0.25}, [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]],
                "surface_size": {"width": 1000, "height": 500},
            },
        ),
    )

    detection = context.emitted("detection")[0]
    assert sorted(detection["ids"]) == [0, 1, 2, 3, 4]
    assert result["markers"] == 5 and result["samples"] == 20
    assert result["reprojection_error_max"] < 4.0
    matrix = to_matrix(result["matrix"]) / result["matrix"][8]
    assert matrix[:2, :2] == pytest.approx(np.diag([DISPLAY_SCALE, DISPLAY_SCALE]), abs=0.02)
    assert result["frame_size"] == {"width": FRAME_W, "height": FRAME_H}
    assert result["surface_quad_display"][0] == pytest.approx({"x": 400.0, "y": 300.0}, abs=3.0)
    assert context.emitted("homography")[0]["surface_matrix"] == result["surface_matrix"]
    check_events(CalibrationDriver, context)

    point = check_result(
        CalibrationDriver, "reproject_point", driver.execute("reproject_point", {"x": 100, "y": 50})
    )
    assert (point["x"], point["y"]) == pytest.approx((200.0, 100.0), abs=3.0)
    corners = check_result(
        CalibrationDriver,
        "reproject_points",
        driver.execute(
            "reproject_points", {"points": [[200, 150], {"x": 600, "y": 450}], "space": "surface"}
        ),
    )
    assert [v for p in corners["points"] for v in (p["x"], p["y"])] == pytest.approx(
        [0, 0, 1000, 500], abs=1e-6
    )


def test_compute_needs_enough_markers() -> None:
    driver = CalibrationDriver(RecordingContext())
    with pytest.raises(ValueError, match="at least 4 markers"):
        driver.execute("compute", None)
    driver.execute("set_marker_layout", _layout())
    with pytest.raises(RuntimeError, match="only 0 markers detected"):
        driver.execute("compute", {})
    with pytest.raises(RuntimeError, match="not computed yet"):
        driver.execute("reproject_point", {"x": 1, "y": 2})


def test_clear_forgets_detections() -> None:
    driver, _ = _calibrated()
    assert driver.execute("clear", None) == {"ok": True}
    with pytest.raises(RuntimeError, match="only 0 markers"):
        driver.execute("compute", None)


def test_latest_frame_and_marker_rendering() -> None:
    driver = CalibrationDriver(RecordingContext())
    with pytest.raises(RuntimeError, match="no camera frame"):
        driver.execute("get_latest_frame", None)
    driver.on_data(
        "camera", "frame", {"width": FRAME_W, "height": FRAME_H, "ts": 2.0, "_frame": _frame()}
    )

    latest = check_result(
        CalibrationDriver, "get_latest_frame", driver.execute("get_latest_frame", None)
    )
    decoded = cv2.imdecode(
        np.frombuffer(base64.b64decode(latest["jpeg_base64"]), np.uint8), cv2.IMREAD_COLOR
    )
    assert decoded is not None
    assert decoded.shape == (FRAME_H, FRAME_W, 3)
    assert (latest["width"], latest["height"], latest["ts"]) == (FRAME_W, FRAME_H, 2.0)

    marker = check_result(CalibrationDriver, "render_marker", driver.execute("render_marker", 7))
    png = cv2.imdecode(
        np.frombuffer(base64.b64decode(marker["png_base64"]), np.uint8), cv2.IMREAD_GRAYSCALE
    )
    assert png is not None
    assert png.shape == (200, 200)
    assert driver.execute("render_marker", {"id": 3, "size": 64})["size"] == 64


def test_detects_in_jpeg_only_events() -> None:
    context = RecordingContext()
    driver = CalibrationDriver(context)
    _, buf = cv2.imencode(".png", _frame())
    driver.on_data("camera", "color", {"jpeg_base64": base64.b64encode(buf.tobytes()).decode()})
    assert context.emitted("detection")[0]["detected"] == 5


def test_compute_homographies_recovers_a_perspective_transform() -> None:
    truth = np.array([[1.2, 0.1, 30.0], [-0.05, 0.9, 12.0], [0.0002, 0.0001, 1.0]])
    layout = [
        MarkerPlacement(id=i, x=100.0 + 200 * i, y=100.0 + 50 * (i % 2), size=40.0)
        for i in range(4)
    ]
    inverse = np.linalg.inv(truth)
    detections = {m.id: warp_points(inverse, m.corners()) for m in layout}

    result = compute_homographies(
        layout,
        detections,
        focus_quad=[[0, 0], [1, 0], [1, 1], [0, 1]],
        frame_size=(640, 480),
        surface_size=(64, 48),
    )

    assert result.display / result.display[2, 2] == pytest.approx(truth, rel=1e-4, abs=1e-6)
    assert result.error_max < 1e-3
    assert result.surface is not None
    assert warp_points(result.surface, [[640, 480]])[0] == pytest.approx([64, 48])


# w = 1 - x / 640: camera points on the column x = 640 map to infinity.
TOWARDS_INFINITY = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [-1 / 640, 0.0, 1.0]])


def test_warp_points_returns_nan_for_points_at_infinity() -> None:
    warped = warp_points(TOWARDS_INFINITY, [[320, 100], [640, 100]])

    assert warped[0] == pytest.approx([640, 200])
    assert np.isnan(warped[1]).all()
    assert warp_points(TOWARDS_INFINITY, np.empty((0, 2))).shape == (0, 2)


def test_surface_quad_display_is_null_when_a_corner_maps_to_infinity() -> None:
    layout = [
        MarkerPlacement(id=i, x=100.0 + 150 * i, y=100.0 + 50 * (i % 2), size=40.0)
        for i in range(4)
    ]
    inverse = np.linalg.inv(TOWARDS_INFINITY)
    detections = {m.id: warp_points(inverse, m.corners()) for m in layout}

    result = compute_homographies(
        layout, detections, focus_quad=[[0, 0], [1, 0], [1, 1], [0, 1]], frame_size=(640, 480)
    )

    assert result.surface is not None
    assert result.surface_quad_display is None


def test_reprojection_reports_points_at_infinity() -> None:
    driver = CalibrationDriver(RecordingContext())
    driver._display = TOWARDS_INFINITY

    with pytest.raises(ValueError, match="maps to infinity"):
        driver.execute("reproject_point", {"x": 640, "y": 10})
    points = check_result(
        CalibrationDriver,
        "reproject_points",
        driver.execute("reproject_points", {"points": [[320, 0], [640, 0]]}),
    )
    assert points["points"] == [{"x": 640.0, "y": 0.0}, None]
