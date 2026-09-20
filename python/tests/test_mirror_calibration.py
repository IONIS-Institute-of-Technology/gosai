"""Synthetic checks of the `mirror_calibration` driver.

Nothing here touches a camera. Board frames are the printable sheet warped
into a known camera pose, the same way `test_charuco.py` builds its views, and
face frames are a rigid head model projected through the same camera. The eye
landmarks of that model lie on one plane through the pupils, so
`placement.locate_eyes` returns the pupils exactly and these tests measure the
driver rather than the head model.

The alignment round trip is built backwards from the answer: pick a rig, pick
an eye and a screen target, put the virtual image on the line between them,
fold it back through the mirror, and render the board so its designated corner
sits on the point the viewer would have to align. `test_mirror_rig.py` guards
that construction; here it feeds the driver.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import msgspec
import numpy as np
import pytest
from numpy.typing import NDArray

from fakes import RecordingContext, check_events, check_result
from gosai_py.clock import now_ms
from gosai_py.drivers.mirror_calibration import (
    MAX_AMBIGUITY_MM,
    MirrorCalibrationDriver,
)
from gosai_py.geometry import charuco, mirror_rig
from gosai_py.geometry.camera_model import CameraModel
from gosai_py.geometry.mirror_rig import Rig, pixels_to_mm, point_for_target, project_mm
from gosai_py.geometry.placement import (
    GENERIC_IRIS_MM,
    IRIS_DIAMETERS,
    LEFT_EYE_CORNERS,
    LEFT_IRIS,
    RIGHT_EYE_CORNERS,
    RIGHT_IRIS,
    calibrated_iris_mm,
)
from gosai_py.mirror_profiles import LensProfile

type Array = NDArray[np.float64]

FRAME_W, FRAME_H = 1280, 720
HFOV_DEG = 70.0
SHEET_DPI = 150

# The rig the tests recover: a portrait canvas with the camera above its top
# edge, tilted down, plus a little yaw and roll so no axis is exactly nominal.
SCREEN_W, SCREEN_H, GAP = 600.0, 1000.0, 10.0
CAMERA_IN_SCREEN = (15.0, -540.0, -GAP)
TILT_DEG = 12.0
CANVAS_W_PX, CANVAS_H_PX = 1080.0, 1920.0

IPD_MM = 63.0
FACE_LANDMARKS = 478
# What this camera's landmarks read the operator's iris as: above the 11.7 mm
# almost everybody has, either because the model reads large here or because
# the operator's own iris is. One run cannot tell the two apart, which is the
# whole point of the shrinkage.
OPERATOR_IRIS_MM = 12.6
# Every iris landmark, for the frames that are meant to carry none.
IRIS_BOUNDARY = [index for pairs in IRIS_DIAMETERS for pair in pairs for index in pair]

# Reachable targets, in millimeters from the canvas center. They stay in the
# upper half: with the camera above the screen, a target near the bottom edge
# puts the held board below the camera's field of view.
TARGETS_MM = (
    (-220.0, -420.0),
    (220.0, -420.0),
    (-240.0, -300.0),
    (240.0, -300.0),
    (0.0, -380.0),
    (-140.0, -180.0),
    (140.0, -180.0),
    (0.0, -160.0),
)

Rows = list[tuple[Array, Array, Array]]


# ---------------------------------------------------------------------------
# Camera, board and face fixtures
# ---------------------------------------------------------------------------


def _camera(dist: tuple[float, ...] = ()) -> CameraModel:
    base = CameraModel.from_hfov(FRAME_W, FRAME_H, HFOV_DEG)
    return CameraModel(base.width, base.height, base.fx, base.fy, base.cx, base.cy, dist)


def _lens(camera: CameraModel) -> Any:
    """A lens profile as the app would send it back, so the driver decodes it."""
    return msgspec.to_builtins(LensProfile.of(camera))


def _sheet() -> tuple[NDArray[np.uint8], charuco.SheetLayout]:
    return charuco.render_sheet("a4", SHEET_DPI), charuco.sheet_layout("a4", SHEET_DPI)


SHEET, LAYOUT = _sheet()


def _render_view(camera: CameraModel, rvec: Array, tvec: Array) -> NDArray[np.uint8]:
    """The printed sheet as the camera would see it.

    The sheet is shrunk to roughly its size in the frame first, because warping
    a 150 dpi page straight down to a few hundred pixels aliases the markers
    away.
    """
    scale = float(camera.fx / (tvec[2] * LAYOUT.px_per_mm))
    small = cv2.resize(SHEET, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    height, width = small.shape
    source = np.array(
        [[0.0, 0.0], [width - 1.0, 0.0], [width - 1.0, height - 1.0], [0.0, height - 1.0]]
    )
    corners_mm = LAYOUT.to_board_mm((source + 0.5) / scale - 0.5)
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
    return np.asarray(
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


def _board_rvec(camera: CameraModel, point: Array, tilt_deg: float, yaw_deg: float) -> Array:
    """A board pose whose designated corner is at `point`, rolled to stay in frame.

    The board grows from its origin corner along +x and +y, so the roll points
    it back toward the middle of the frame.
    """
    pixel = camera.project(point)
    right, low = bool(pixel[0] > camera.cx), bool(pixel[1] > camera.cy)
    # 0 grows right and down, then a quarter turn per quadrant.
    roll = {(False, False): 0.0, (True, False): 90.0, (True, True): 180.0}.get((right, low), 270.0)
    rotation = (
        cv2.Rodrigues(np.array([0.0, math.radians(yaw_deg), 0.0]))[0]
        @ cv2.Rodrigues(np.array([math.radians(tilt_deg), 0.0, 0.0]))[0]
        @ cv2.Rodrigues(np.array([0.0, 0.0, math.radians(roll)]))[0]
    )
    return np.asarray(cv2.Rodrigues(np.asarray(rotation))[0], dtype=np.float64).reshape(3)


def _observation(
    camera: CameraModel,
    rvec: Array,
    tvec: Array,
    noise_px: float = 0.0,
    seed: int = 0,
    sharpness: float = 300.0,
) -> charuco.BoardObservation:
    """Corners a perfect detector would report for this pose, with a little noise."""
    object_points = np.asarray(charuco.board().getChessboardCorners(), dtype=np.float64)
    pixels, _ = cv2.projectPoints(object_points, rvec, tvec, camera.matrix, camera.dist_coeffs)
    pixels = np.asarray(pixels, dtype=np.float64).reshape(-1, 2)
    if noise_px:
        pixels = pixels + np.random.default_rng(seed).normal(0.0, noise_px, pixels.shape)
    ids = np.arange(len(object_points), dtype=np.int32)
    return charuco.BoardObservation.from_corners(
        ids, pixels, len(object_points), (FRAME_W, FRAME_H), sharpness
    )


def _face_model() -> Array:
    """A rigid head in millimeters, with both pupils and the eye corners coplanar.

    Coplanar eye landmarks make `locate_eyes` exact, so a captured `eye_mm` can
    be compared with the position the test asked for.
    """
    rng = np.random.default_rng(21)
    model = rng.uniform([-70.0, -90.0, -20.0], [70.0, 90.0, 40.0], size=(FACE_LANDMARKS, 3))
    half = IPD_MM / 2.0
    for side, (inner, outer), iris in (
        (1.0, LEFT_EYE_CORNERS, LEFT_IRIS),
        (-1.0, RIGHT_EYE_CORNERS, RIGHT_IRIS),
    ):
        model[inner] = [side * (half - 15.0), 0.0, 0.0]
        model[outer] = [side * (half + 15.0), 0.0, 0.0]
        model[iris] = [side * half, 0.0, 0.0]
    return model


FACE_MODEL = _face_model()


def _frame_payload(frame: NDArray[np.uint8], capture_ts: float | None = None) -> dict[str, Any]:
    ts = now_ms() if capture_ts is None else capture_ts
    return {
        "_frame": frame,
        "width": frame.shape[1],
        "height": frame.shape[0],
        "capture_ts": ts,
        "ts": ts,
    }


def _iris_boundary(pupil: Array, iris_mm: float) -> Array:
    """One iris as a circle square to the ray it is seen along: across, then up and down.

    The operator faces the camera, so this is where their irises really are,
    and `placement.apparent_iris_mm` should read exactly `iris_mm` back.
    """
    radius = iris_mm / 2.0
    across = np.array([pupil[2], 0.0, -pupil[0]])
    across = radius * across / np.linalg.norm(across)
    up = np.cross(pupil, across)
    up = radius * up / np.linalg.norm(up)
    return np.array([pupil + across, pupil - across, pupil + up, pupil - up])


def _face_payload(
    camera: CameraModel,
    eye_mm: Array,
    *,
    eye: str = "right",
    flipped: bool = False,
    capture_ts: float | None = None,
    shift_mm: Array | None = None,
    irises: bool = True,
    iris_mm: float = OPERATOR_IRIS_MM,
) -> dict[str, Any]:
    """A `pose.raw_data` payload whose chosen pupil sits at `eye_mm`.

    `irises` of False leaves the eight boundary landmarks NaN, the way a
    tracker that never found them reports: the run then measures no iris.
    """
    iris = LEFT_IRIS if eye == "left" else RIGHT_IRIS
    points = FACE_MODEL + (np.asarray(eye_mm, dtype=np.float64) - FACE_MODEL[iris])
    if shift_mm is not None:
        points = points + np.asarray(shift_mm, dtype=np.float64)
    if irises:
        for center, (across, up) in (
            (RIGHT_IRIS, IRIS_DIAMETERS[0]),
            (LEFT_IRIS, IRIS_DIAMETERS[1]),
        ):
            points[[*across, *up]] = _iris_boundary(points[center], iris_mm)
    else:
        points[IRIS_BOUNDARY] = np.nan
    pixels = camera.project(points)
    if flipped:
        pixels[:, 0] = (FRAME_W - 1.0) - pixels[:, 0]
    # MediaPipe's face z is its x in pixels, measured from the mesh's own
    # reference depth, which here is the plane the pupils sit on.
    z_px = (points[:, 2] / float(points[iris, 2]) - 1.0) * camera.fx
    ts = now_ms() if capture_ts is None else capture_ts
    return {
        "_face_xyz": np.column_stack([pixels, z_px]),
        "frame_width": float(FRAME_W),
        "frame_height": float(FRAME_H),
        "flipped": flipped,
        "capture_ts": ts,
        "ts": ts,
    }


def _new_driver() -> tuple[MirrorCalibrationDriver, RecordingContext]:
    context = RecordingContext()
    instance = MirrorCalibrationDriver(context)
    # Deliver straight into `on_data`. The real subscription keeps only the
    # newest value, which would drop most of a short burst of frames.
    context.subscribe("camera", "frame", lambda data: instance.on_data("camera", "frame", data))
    context.subscribe("pose", "raw_data", lambda data: instance.on_data("pose", "raw_data", data))
    return instance, context


@pytest.fixture
def driver() -> tuple[MirrorCalibrationDriver, RecordingContext]:
    return _new_driver()


def _configure(instance: MirrorCalibrationDriver, **changes: Any) -> Any:
    return check_result(
        MirrorCalibrationDriver, "configure", instance.execute("configure", changes or None)
    )


def _set_stage(instance: MirrorCalibrationDriver, stage: str) -> Any:
    return check_result(
        MirrorCalibrationDriver, "set_stage", instance.execute("set_stage", {"stage": stage})
    )


def _fake_detect(
    monkeypatch: pytest.MonkeyPatch, observations: list[charuco.BoardObservation | None]
) -> None:
    """Serve prepared observations instead of running the detector."""
    queue = iter(observations)
    monkeypatch.setattr(charuco, "detect", lambda image: next(queue, None))


def _blank(width: int = FRAME_W, height: int = FRAME_H) -> NDArray[np.uint8]:
    return np.full((height, width), 255, np.uint8)


# ---------------------------------------------------------------------------
# Stages and the board event
# ---------------------------------------------------------------------------


def test_idle_stage_emits_nothing(driver: tuple[MirrorCalibrationDriver, RecordingContext]) -> None:
    instance, context = driver
    camera = _camera()
    tvec = np.array([-60.0, -110.0, 700.0])
    view = _render_view(camera, _board_rvec(camera, tvec, -25.0, 10.0), tvec)

    context.deliver("camera", "frame", _frame_payload(view))
    context.deliver("pose", "raw_data", _face_payload(camera, np.array([0.0, -100.0, 1200.0])))

    assert context.events == []
    assert _set_stage(instance, "align") == {"stage": "align"}


def test_board_event_reports_the_pose_of_the_printed_corner(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera))
    _set_stage(instance, "align")
    tvec = np.array([-90.0, -140.0, 750.0])
    rvec = _board_rvec(camera, tvec, -25.0, 12.0)
    captured = now_ms() - 20.0

    context.deliver("camera", "frame", _frame_payload(_render_view(camera, rvec, tvec), captured))

    [payload] = context.emitted("board")
    assert payload["detected"] is True
    assert payload["corners"] == 15 and payload["marker_count"] >= 8
    assert len(payload["hull_px"]) >= 4 and all(len(p) == 2 for p in payload["hull_px"])
    assert (payload["frame_width"], payload["frame_height"]) == (float(FRAME_W), float(FRAME_H))
    assert payload["sharpness"] > 0.0
    assert payload["point_mm"] == pytest.approx(tvec, abs=3.0)
    assert payload["distance_mm"] == pytest.approx(float(np.linalg.norm(tvec)), abs=3.0)
    assert payload["rms_px"] < 1.0
    assert payload["ambiguity_mm"] < MAX_AMBIGUITY_MM
    true_tilt = math.degrees(math.acos(abs(cv2.Rodrigues(rvec)[0][2, 2])))
    assert payload["tilt_deg"] == pytest.approx(true_tilt, abs=2.0)
    assert payload["capture_ts"] == captured and payload["ts"] >= captured
    # Lens progress belongs to the lens stage only.
    assert context.emitted("lens_progress") == []
    check_events(MirrorCalibrationDriver, context)


def test_board_event_without_a_board_in_view(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    _set_stage(instance, "align")

    context.deliver("camera", "frame", _frame_payload(_blank()))

    [payload] = context.emitted("board")
    assert payload["detected"] is False
    assert (payload["corners"], payload["marker_count"], payload["hull_px"]) == (0, 0, [])
    assert payload["sharpness"] == 0.0
    for field in ("point_mm", "distance_mm", "rms_px", "ambiguity_mm", "tilt_deg"):
        assert payload[field] is None
    check_events(MirrorCalibrationDriver, context)


def test_a_lens_of_another_aspect_ratio_warns_once(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    _configure(instance, lens=_lens(_camera()))
    _set_stage(instance, "align")

    for _ in range(3):
        context.deliver("camera", "frame", _frame_payload(_blank(640, 640)))
    context.deliver("camera", "frame", _frame_payload(_blank(320, 240)))

    warnings = [message for level, message in context.logs if level == "warn"]
    assert len(warnings) == 2
    assert "640x640" in warnings[0] and "320x240" in warnings[1]


# ---------------------------------------------------------------------------
# Lens stage
# ---------------------------------------------------------------------------


def _calibration_views(camera: CameraModel, count: int = 22) -> list[charuco.BoardObservation]:
    """Board poses spread over the frame, over depth and over tilt."""
    views: list[charuco.BoardObservation] = []
    for i in range(count):
        depth = 520.0 + 90.0 * (i % 5)
        rotation = (
            cv2.Rodrigues(np.array([0.0, math.radians(-30.0 + 12.0 * (i % 7)), 0.0]))[0]
            @ cv2.Rodrigues(np.array([math.radians(-35.0 + 14.0 * (i % 6)), 0.0, 0.0]))[0]
        )
        rvec = np.asarray(cv2.Rodrigues(np.asarray(rotation))[0], dtype=np.float64).reshape(3)
        center = np.array([charuco.BOARD_WIDTH_MM / 2.0, charuco.BOARD_HEIGHT_MM / 2.0, 0.0])
        # Put the board's middle on the optical axis, then slide it around so
        # the corners reach the frame edges.
        tvec = np.asarray(
            np.array([0.0, 0.0, depth])
            - np.asarray(rotation) @ center
            + np.array([0.30 * depth * math.cos(i * 1.9), 0.18 * depth * math.sin(i * 2.7), 0.0]),
            dtype=np.float64,
        )
        views.append(_observation(camera, rvec, tvec, noise_px=0.2, seed=i))
    return views


def test_lens_stage_collects_views_and_solves_the_lens(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    instance, context = driver
    truth = _camera(dist=(-0.24, 0.07, 0.0012, -0.0008))
    views = _calibration_views(truth)
    _fake_detect(monkeypatch, [*views, None])
    _set_stage(instance, "lens")

    for _ in range(len(views) + 1):
        context.deliver("camera", "frame", _frame_payload(_blank()))

    progress = context.emitted("lens_progress")
    assert len(progress) == len(views) + 1
    assert progress[-1]["accepted"] is False  # the frame with no board in it
    assert sum(1 for step in progress if step["accepted"]) == progress[-1]["views"]
    assert progress[-1]["views"] >= charuco.MIN_SOLVE_VIEWS
    assert progress[-1]["coverage"] > 0.5
    assert progress[-1]["tilted_views"] >= charuco.TILTED_TARGET
    assert progress[-1]["progress"] == pytest.approx(1.0)
    assert progress[-1]["hint"] == "ready"
    assert progress[0]["hint"] in {"more_views", "cover_edges", "tilt_board"}
    assert [step["views"] for step in progress] == sorted(step["views"] for step in progress)

    result = check_result(
        MirrorCalibrationDriver, "solve_lens", instance.execute("solve_lens", None)
    )
    assert result["rms_px"] < 0.5
    assert result["views"] >= charuco.MIN_SOLVE_VIEWS
    assert result["hfov_deg"] == pytest.approx(HFOV_DEG, abs=2.0)
    assert result["lens"]["fx"] == pytest.approx(truth.fx, rel=0.02)
    assert result["lens"]["cx"] == pytest.approx(truth.cx, abs=0.02 * FRAME_W)
    assert result["lens"]["dist"][0] == pytest.approx(truth.dist[0], abs=0.03)
    assert result["lens"]["rms_px"] == result["rms_px"]

    # The solved lens becomes the lens every later stage uses.
    assert _configure(instance)["lens"] == result["lens"]
    check_events(MirrorCalibrationDriver, context)


def test_reset_lens_starts_the_capture_over(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    instance, context = driver
    views = _calibration_views(_camera(), count=6)
    _fake_detect(monkeypatch, list(views))
    _set_stage(instance, "lens")
    for _ in range(4):
        context.deliver("camera", "frame", _frame_payload(_blank()))
    assert context.emitted("lens_progress")[-1]["views"] > 0

    assert (
        check_result(MirrorCalibrationDriver, "reset_lens", instance.execute("reset_lens", None))
        is None
    )
    context.deliver("camera", "frame", _frame_payload(_blank()))

    assert context.emitted("lens_progress")[-1]["views"] == 1
    with pytest.raises(charuco.CalibrationError, match="at least"):
        instance.execute("solve_lens", None)


def test_lens_capture_restarts_when_the_frame_size_changes(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    instance, context = driver
    camera = _camera()
    views = _calibration_views(camera, count=4)
    smaller = charuco.BoardObservation.from_corners(
        views[0].corner_ids, views[0].corners_px / 2.0, views[0].marker_count, (640, 360), 300.0
    )
    _fake_detect(monkeypatch, [*views, smaller])
    _set_stage(instance, "lens")

    for _ in range(len(views)):
        context.deliver("camera", "frame", _frame_payload(_blank()))
    collected = context.emitted("lens_progress")[-1]["views"]
    context.deliver("camera", "frame", _frame_payload(_blank(640, 360)))

    assert collected > 1
    assert context.emitted("lens_progress")[-1]["views"] == 1
    warnings = [message for level, message in context.logs if level == "warn"]
    assert len(warnings) == 1 and "resolution changed" in warnings[0]


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------


def _triple(values: Any) -> tuple[float, float, float]:
    x, y, z = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y, z


def _truth_rig() -> Rig:
    rotation = Rig.nominal(SCREEN_W, SCREEN_H, GAP, CAMERA_IN_SCREEN, TILT_DEG).rotation_matrix
    wobble, _ = cv2.Rodrigues(np.radians(np.array([0.0, 2.0, 1.0])))
    rotation = np.asarray(rotation @ wobble, dtype=np.float64)
    rotvec, _ = cv2.Rodrigues(rotation)
    center = -rotation @ np.asarray(CAMERA_IN_SCREEN, dtype=np.float64)
    return Rig(_triple(rotvec), _triple(center), SCREEN_W, SCREEN_H, GAP)


TRUTH_RIG = _truth_rig()


def _to_camera(screen: Any) -> Array:
    return TRUTH_RIG.rotation_matrix @ np.asarray(screen, dtype=np.float64) + np.asarray(
        TRUTH_RIG.center_mm
    )


def _alignment(eye_screen: Array, target_mm: Array, point_depth: float) -> tuple[Array, Array]:
    """Eye and board corner (camera mm) whose reflection covers `target_mm`."""
    eye = np.asarray(eye_screen, dtype=np.float64)
    aim = np.array([target_mm[0], target_mm[1], 0.0])
    distance = -eye[2]
    reach = (distance + point_depth - 2.0 * GAP) / distance
    virtual = eye + reach * (aim - eye)
    point = np.array([virtual[0], virtual[1], -2.0 * GAP - virtual[2]])
    return _to_camera(eye), _to_camera(point)


def _dataset(
    distances: tuple[float, ...], count: int = 8, arm_mm: float = 320.0, shift: bool = False
) -> Rows:
    rows: Rows = []
    for i in range(count):
        target = np.asarray(TARGETS_MM[i % len(TARGETS_MM)], dtype=np.float64)
        if shift:
            target = np.array([target[0] * 0.6 + 40.0 * (i % 3 - 1), target[1] * 0.7])
        distance = distances[i % len(distances)]
        eye = np.array([-150.0 + 45.0 * i, -200.0 + 12.0 * i, -distance])
        eye_mm, point_mm = _alignment(eye, target, distance - arm_mm)
        rows.append((eye_mm, point_mm, target))
    return rows


def _target_px(target_mm: Array) -> list[float]:
    """Canvas pixels of a target given in millimeters from the canvas center."""
    return [
        (float(target_mm[0]) / SCREEN_W + 0.5) * CANVAS_W_PX,
        (float(target_mm[1]) / SCREEN_H + 0.5) * CANVAS_H_PX,
    ]


def _feed_alignment(
    context: RecordingContext,
    camera: CameraModel,
    eye_mm: Array,
    point_mm: Array,
    frames: int = 5,
    *,
    eye: str = "right",
    flipped: bool = False,
    irises: bool = True,
    iris_mm: float = OPERATOR_IRIS_MM,
) -> None:
    """One target's worth of board frames and matching face frames."""
    view = _render_view(camera, _board_rvec(camera, point_mm, -28.0, 12.0), point_mm)
    for _ in range(frames):
        captured = now_ms()
        context.deliver("camera", "frame", _frame_payload(view, captured))
        context.deliver(
            "pose",
            "raw_data",
            _face_payload(
                camera,
                eye_mm,
                eye=eye,
                flipped=flipped,
                capture_ts=captured,
                irises=irises,
                iris_mm=iris_mm,
            ),
        )


def _capture(
    instance: MirrorCalibrationDriver, target_mm: Array, holdout: bool = False
) -> dict[str, Any]:
    return check_result(
        MirrorCalibrationDriver,
        "capture_alignment",
        instance.execute(
            "capture_alignment",
            {
                "target_px": _target_px(target_mm),
                "canvas_px": [CANVAS_W_PX, CANVAS_H_PX],
                "holdout": holdout,
            },
        ),
    )


def _collect(
    instance: MirrorCalibrationDriver,
    context: RecordingContext,
    camera: CameraModel,
    rows: Rows,
    holdout: bool = False,
    irises: bool = True,
    iris_mm: float = OPERATOR_IRIS_MM,
) -> list[dict[str, Any]]:
    captured = []
    for eye_mm, point_mm, target_mm in rows:
        _feed_alignment(context, camera, eye_mm, point_mm, irises=irises, iris_mm=iris_mm)
        captured.append(_capture(instance, target_mm, holdout))
    return captured


def _solve_rig(instance: MirrorCalibrationDriver) -> dict[str, Any]:
    return check_result(
        MirrorCalibrationDriver,
        "solve_rig",
        instance.execute("solve_rig", {"width_mm": SCREEN_W, "height_mm": SCREEN_H, "gap_mm": GAP}),
    )


@pytest.fixture
def aligned(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]]:
    """Eight alignments over two standing distances, plus two holdouts."""
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera), ipd_mm=IPD_MM, eye="right")
    _set_stage(instance, "align")
    captured = _collect(instance, context, camera, _dataset((1000.0, 1500.0)))
    captured += _collect(
        instance,
        context,
        camera,
        _dataset((1200.0, 1700.0), count=2, arm_mm=350.0, shift=True),
        holdout=True,
    )
    return instance, context, camera, captured


def test_capture_reports_the_averaged_corner_and_eye(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    _, context, _, captured = aligned
    rows = _dataset((1000.0, 1500.0))

    assert [sample["index"] for sample in captured] == list(range(10))
    assert captured[7] == {**captured[7], "samples": 8, "holdouts": 0}
    assert captured[9]["holdouts"] == 2 and captured[9]["samples"] == 8
    for sample, (eye_mm, point_mm, _) in zip(captured, rows, strict=False):
        assert sample["point_mm"] == pytest.approx(point_mm, abs=4.0)
        # The eye comes back exactly: the face model's pupils are coplanar.
        assert sample["eye_mm"] == pytest.approx(eye_mm, abs=0.5)
        assert sample["board_spread_mm"] == 0.0 and sample["eye_spread_mm"] == 0.0
        assert sample["board_distance_mm"] == pytest.approx(np.linalg.norm(point_mm), abs=4.0)
        assert sample["eye_distance_mm"] == pytest.approx(np.linalg.norm(eye_mm), abs=1.0)
        # The operator's pupil spacing is measured, so their eye depth is metric
        # and what their iris reads there is a property of this camera.
        assert sample["iris_mm"] == pytest.approx(OPERATOR_IRIS_MM, rel=0.005)
    check_events(MirrorCalibrationDriver, context)


def test_solve_rig_shrinks_the_operators_iris_into_the_rig(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    instance, _, _, _ = aligned

    result = _solve_rig(instance)

    iris = result["iris"]
    # Every alignment saw the same operator, holdouts included.
    assert iris["samples"] == 10
    assert iris["apparent_mm"] == pytest.approx(OPERATOR_IRIS_MM, rel=0.005)
    # One reading cannot separate this camera from this operator's own iris, so
    # the rig keeps the share of it the camera is expected to own.
    assert result["rig"]["iris_mm"] == pytest.approx(calibrated_iris_mm(iris["apparent_mm"]))
    assert GENERIC_IRIS_MM < result["rig"]["iris_mm"] < iris["apparent_mm"]
    assert result["rig"]["iris_mm"] == pytest.approx(12.32, abs=0.02)
    # Near and far are a diagnostic only: a gap between them would say the
    # landmark model reads an iris differently as it shrinks in the image.
    assert iris["near_mm"] is not None and iris["far_mm"] is not None
    assert iris["near_mm"] == pytest.approx(iris["far_mm"], rel=0.02)


def test_a_reading_that_follows_the_range_shows_as_a_near_far_gap(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    """The one thing the operator's own iris cannot explain, and only a rig trial can."""
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera), ipd_mm=IPD_MM)
    _set_stage(instance, "align")
    rows = _dataset((1000.0, 1500.0))
    # The same operator, read larger where they stand closer to the camera.
    _collect(instance, context, camera, rows[0::2], iris_mm=12.6)
    _collect(instance, context, camera, rows[1::2], iris_mm=11.4)

    iris = _solve_rig(instance)["iris"]

    assert iris["near_mm"] == pytest.approx(12.6, rel=0.005)
    assert iris["far_mm"] == pytest.approx(11.4, rel=0.005)
    assert iris["apparent_mm"] == pytest.approx(12.0, rel=0.01)


def test_too_few_iris_readings_leave_the_generic_diameter(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    """Three glances are not a measurement of the camera."""
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera), ipd_mm=IPD_MM)
    _set_stage(instance, "align")
    rows = _dataset((1000.0, 1500.0))
    _collect(instance, context, camera, rows[:3])
    _collect(instance, context, camera, rows[3:], irises=False)

    result = _solve_rig(instance)

    assert result["iris"]["samples"] == 3
    assert result["iris"]["apparent_mm"] == pytest.approx(OPERATOR_IRIS_MM, rel=0.005)
    assert result["rig"]["iris_mm"] == GENERIC_IRIS_MM
    # With no reading at all the report says so rather than inventing one.
    listed = instance.execute("list_alignments", None)
    assert [row["iris_mm"] is None for row in listed["alignments"]] == [False] * 3 + [True] * 5


def test_solve_rig_recovers_the_rig_and_reports_the_holdout(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    instance, _, _, _ = aligned

    result = _solve_rig(instance)

    assert result["quality"] == "good"
    assert result["predicted_error_mm"] < 15.0
    assert result["rms_mm"] < 3.0
    assert [row["index"] for row in result["residuals_mm"]] == list(range(8))
    assert max(row["error_mm"] for row in result["residuals_mm"]) < 5.0
    # The pose itself comes back, not only its predictions.
    fitted = mirror_rig.Rig(
        _triple(result["rig"]["rotation"]),
        _triple(result["rig"]["center_mm"]),
        SCREEN_W,
        SCREEN_H,
        GAP,
    )
    assert np.asarray(fitted.center_mm) == pytest.approx(np.asarray(TRUTH_RIG.center_mm), abs=15.0)
    assert fitted.rotation_matrix == pytest.approx(TRUTH_RIG.rotation_matrix, abs=0.02)
    assert result["tilt_deg"] == pytest.approx(TILT_DEG, abs=1.0)
    assert result["camera_in_screen_mm"] == pytest.approx(CAMERA_IN_SCREEN, abs=15.0)
    assert result["distances_mm"] == pytest.approx([990.0, 1490.0], abs=5.0)
    assert result["condition"] > 1.0

    holdout = result["holdout"]
    assert holdout["count"] == 2
    assert [row["index"] for row in holdout["residuals_mm"]] == [8, 9]
    assert holdout["max_mm"] < 8.0
    assert holdout["mean_mm"] <= holdout["max_mm"]


def test_check_rig_scores_every_stored_alignment(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    instance, _, _, _ = aligned
    solved = _solve_rig(instance)

    result = check_result(
        MirrorCalibrationDriver, "check_rig", instance.execute("check_rig", {"rig": solved["rig"]})
    )

    assert result["samples"] == 10
    assert [row["index"] for row in result["residuals_mm"]] == list(range(10))
    assert result["max_mm"] < 8.0
    assert result["rms_mm"] is not None and result["rms_mm"] <= result["max_mm"]
    assert result["mean_mm"] <= result["max_mm"]

    # A rig turned away from the mirror draws everything in the wrong place.
    wrong = {**solved["rig"], "center_mm": [c + 200.0 for c in solved["rig"]["center_mm"]]}
    off = check_result(
        MirrorCalibrationDriver, "check_rig", instance.execute("check_rig", {"rig": wrong})
    )
    assert off["max_mm"] is None or off["max_mm"] > result["max_mm"]


def test_one_standing_distance_is_reported_as_worse(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    """The residuals cannot tell the wizard that the fit is badly constrained."""
    two_distances = _solve_rig(aligned[0])

    instance, context = _new_driver()
    camera = _camera()
    _configure(instance, lens=_lens(camera), ipd_mm=IPD_MM)
    _set_stage(instance, "align")
    _collect(instance, context, camera, _dataset((1500.0,)))
    one_distance = _solve_rig(instance)

    # One group, and further out than the fit itself is trustworthy here.
    assert one_distance["distances_mm"] == pytest.approx([1490.0], abs=20.0)
    assert one_distance["predicted_error_mm"] > 2.5 * two_distances["predicted_error_mm"]
    assert one_distance["quality"] != "good"
    assert one_distance["condition"] > two_distances["condition"]
    # The residuals look just as good, which is why quality ignores them.
    assert one_distance["rms_mm"] < 3.0


def test_holdout_only_alignments_cannot_be_fitted(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera))
    _set_stage(instance, "align")
    _collect(instance, context, camera, _dataset((1000.0, 1500.0), count=3), holdout=True)

    with pytest.raises(RuntimeError, match=r"^no_valid_rig: need at least"):
        instance.execute("solve_rig", {"width_mm": SCREEN_W, "height_mm": SCREEN_H, "gap_mm": GAP})


def test_alignments_can_be_listed_removed_and_cleared(
    aligned: tuple[MirrorCalibrationDriver, RecordingContext, CameraModel, list[dict[str, Any]]],
) -> None:
    instance, _, _, _ = aligned

    listed = check_result(
        MirrorCalibrationDriver, "list_alignments", instance.execute("list_alignments", None)
    )
    assert (listed["samples"], listed["holdouts"]) == (8, 2)
    assert [row["index"] for row in listed["alignments"]] == list(range(10))
    first = listed["alignments"][0]
    assert first["target_px"] == _target_px(np.asarray(TARGETS_MM[0]))
    assert first["canvas_px"] == [CANVAS_W_PX, CANVAS_H_PX]
    assert first["holdout"] is False and listed["alignments"][8]["holdout"] is True
    assert first["ambiguity_mm"] < MAX_AMBIGUITY_MM
    assert first["iris_mm"] == pytest.approx(OPERATOR_IRIS_MM, rel=0.005)

    removed = check_result(
        MirrorCalibrationDriver,
        "remove_alignment",
        instance.execute("remove_alignment", {"index": 0}),
    )
    assert removed == {"samples": 7, "holdouts": 2}
    # Indices are stable, so what is left keeps its own number.
    kept = instance.execute("list_alignments", None)
    assert [row["index"] for row in kept["alignments"]] == list(range(1, 10))
    with pytest.raises(RuntimeError, match=r"^unknown_alignment:"):
        instance.execute("remove_alignment", {"index": 0})

    cleared = check_result(
        MirrorCalibrationDriver, "clear_alignments", instance.execute("clear_alignments", None)
    )
    assert cleared == {"samples": 0, "holdouts": 0}
    assert instance.execute("list_alignments", None)["alignments"] == []


def test_a_capture_never_reuses_the_frames_of_the_previous_target(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera))
    _set_stage(instance, "align")
    eye_mm, point_mm, target_mm = _dataset((1000.0,), count=1)[0]
    _feed_alignment(context, camera, eye_mm, point_mm)

    assert _capture(instance, target_mm)["index"] == 0
    with pytest.raises(RuntimeError, match=r"^board_missing:"):
        _capture(instance, target_mm)


def test_a_flipped_pose_frame_gives_the_same_eye(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, context = driver
    camera = _camera()
    _configure(instance, lens=_lens(camera), eye="left")
    _set_stage(instance, "align")
    eye_mm, point_mm, target_mm = _dataset((1200.0,), count=1)[0]

    _feed_alignment(context, camera, eye_mm, point_mm, eye="left")
    straight = _capture(instance, target_mm)
    _feed_alignment(context, camera, eye_mm, point_mm, eye="left", flipped=True)
    mirrored = _capture(instance, target_mm)

    assert straight["eye_mm"] == pytest.approx(eye_mm, abs=0.5)
    assert mirrored["eye_mm"] == pytest.approx(straight["eye_mm"], abs=0.2)


# ---------------------------------------------------------------------------
# Rejections
# ---------------------------------------------------------------------------


def _align_stage(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], camera: CameraModel
) -> tuple[MirrorCalibrationDriver, RecordingContext]:
    instance, context = driver
    _configure(instance, lens=_lens(camera), ipd_mm=IPD_MM)
    _set_stage(instance, "align")
    return instance, context


def _feed_faces(
    context: RecordingContext,
    camera: CameraModel,
    eye_mm: Array,
    count: int = 5,
    jitter_mm: float = 0.0,
    seed: int = 0,
) -> None:
    rng = np.random.default_rng(seed)
    for _ in range(count):
        shift = rng.normal(0.0, jitter_mm, 3) if jitter_mm else None
        context.deliver("pose", "raw_data", _face_payload(camera, eye_mm, shift_mm=shift))


def _feed_boards(
    context: RecordingContext,
    observations: list[charuco.BoardObservation | None],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_detect(monkeypatch, observations)
    for _ in observations:
        context.deliver("camera", "frame", _frame_payload(_blank()))


def _board_at(camera: CameraModel, depth: float, tilt_deg: float, seed: int = 0) -> Any:
    tvec = np.array([-60.0, -110.0, depth])
    rvec = _board_rvec(camera, tvec, tilt_deg, 3.0)
    return _observation(camera, rvec, tvec, noise_px=0.15, seed=seed)


EYE_MM = np.array([40.0, -160.0, 1100.0])


def test_capture_needs_the_board(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_faces(context, camera, EYE_MM)

    with pytest.raises(RuntimeError, match=r"^board_missing: only 0 board poses"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_capture_needs_the_face(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(context, [_board_at(camera, 800.0, -28.0, seed=i) for i in range(5)], monkeypatch)

    with pytest.raises(RuntimeError, match=r"^face_missing: only 0 face frames"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_capture_rejects_a_moving_board(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(
        context,
        [_board_at(camera, 800.0 + 12.0 * i, -28.0, seed=i) for i in range(6)],
        monkeypatch,
    )
    _feed_faces(context, camera, EYE_MM)

    with pytest.raises(RuntimeError, match=r"^unstable_board: the board moved"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_capture_rejects_a_moving_head(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(context, [_board_at(camera, 800.0, -28.0, seed=i) for i in range(5)], monkeypatch)
    _feed_faces(context, camera, EYE_MM, count=6, jitter_mm=25.0, seed=3)

    with pytest.raises(RuntimeError, match=r"^unstable_eye: your head moved"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_capture_rejects_an_ambiguous_board_pose(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A far, nearly frontal board has two poses that explain the image equally well."""
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(context, [_board_at(camera, 1500.0, -8.0, seed=i) for i in range(5)], monkeypatch)
    _feed_faces(context, camera, EYE_MM)

    with pytest.raises(RuntimeError, match=r"^ambiguous_board: the board pose is uncertain"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_capture_rejects_an_empty_canvas(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, _ = _align_stage(driver, _camera())
    with pytest.raises(ValueError, match="canvas_px must be positive"):
        instance.execute(
            "capture_alignment", {"target_px": [10.0, 10.0], "canvas_px": [0.0, 1920.0]}
        )


def test_settings_round_trip(driver: tuple[MirrorCalibrationDriver, RecordingContext]) -> None:
    instance, _ = driver
    assert _configure(instance) == {
        "lens": None,
        "hfov_deg": 60.0,
        "ipd_mm": 63.0,
        "eye": "right",
    }
    updated = _configure(instance, ipd_mm=68.0, eye="left")
    assert (updated["ipd_mm"], updated["eye"], updated["hfov_deg"]) == (68.0, "left", 60.0)
    # Omitted fields keep their value; an out-of-range one is refused whole.
    with pytest.raises(ValueError, match="ipd_mm"):
        instance.execute("configure", {"ipd_mm": 120.0})
    assert _configure(instance)["ipd_mm"] == 68.0
    assert _configure(instance, lens=None)["lens"] is None


def test_changing_stage_drops_the_history(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(context, [_board_at(camera, 800.0, -28.0, seed=i) for i in range(5)], monkeypatch)
    _feed_faces(context, camera, EYE_MM)

    _set_stage(instance, "idle")
    _set_stage(instance, "align")

    with pytest.raises(RuntimeError, match=r"^board_missing:"):
        _capture(instance, np.array(TARGETS_MM[0]))


def test_new_optics_drop_the_history(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stored frames were measured through the old lens and head scale."""
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_boards(context, [_board_at(camera, 800.0, -28.0, seed=i) for i in range(5)], monkeypatch)
    _feed_faces(context, camera, EYE_MM)

    # The open eye is chosen at capture time, so it keeps both histories.
    _configure(instance, eye="left")
    kept = _capture(instance, np.array(TARGETS_MM[0]))
    assert kept["index"] == 0

    _feed_boards(context, [_board_at(camera, 800.0, -28.0, seed=i) for i in range(5)], monkeypatch)
    _feed_faces(context, camera, EYE_MM)
    _configure(instance, ipd_mm=IPD_MM + 3.0)

    with pytest.raises(RuntimeError, match=r"^board_missing:"):
        _capture(instance, np.array(TARGETS_MM[1]))


# ---------------------------------------------------------------------------
# Target suggestions
# ---------------------------------------------------------------------------


def _suggest(instance: MirrorCalibrationDriver, **params: Any) -> Any:
    request = {
        "canvas_px": [CANVAS_W_PX, CANVAS_H_PX],
        "width_mm": SCREEN_W,
        "height_mm": SCREEN_H,
        "gap_mm": GAP,
        **params,
    }
    return check_result(
        MirrorCalibrationDriver, "suggest_targets", instance.execute("suggest_targets", request)
    )


def test_suggestions_need_an_eye_and_a_frame(
    driver: tuple[MirrorCalibrationDriver, RecordingContext],
) -> None:
    instance, _ = _align_stage(driver, _camera())
    result = _suggest(instance, candidates_px=[[540.0, 300.0]])
    assert result["eye_distance_mm"] is None
    assert result["reason"] == "no_face"
    assert [t["reachable"] for t in result["targets"]] == [False]


def test_suggestions_match_where_the_board_would_have_to_be(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    eye = _to_camera(np.array([0.0, -350.0, -1200.0]))
    _feed_faces(context, camera, eye)
    _feed_boards(context, [None], monkeypatch)

    columns = [200.0, 540.0, 880.0]
    rows = [200.0, 600.0, 1000.0, 1400.0, 1800.0]
    candidates = [[x, y] for y in rows for x in columns]
    result = _suggest(instance, candidates_px=candidates, rig=_rig_payload(TRUTH_RIG))
    assert result["eye_distance_mm"] == pytest.approx(1200.0 - GAP, abs=1.0)

    reach = 350.0
    for suggestion in result["targets"]:
        target_mm = pixels_to_mm(TRUTH_RIG, suggestion["target_px"], CANVAS_W_PX, CANVAS_H_PX)
        corner = point_for_target(TRUTH_RIG, eye, target_mm, 1200.0 - GAP - reach)
        # The construction is the inverse of the projection.
        assert project_mm(TRUTH_RIG, eye, corner) == pytest.approx(target_mm, abs=1e-6)
        seen = {}
        for hold, sign in (("corner_up", 1.0), ("corner_down", -1.0)):
            far = corner + sign * np.array([charuco.BOARD_WIDTH_MM, charuco.BOARD_HEIGHT_MM, 0.0])
            pixels = camera.project(np.array([corner, far]))
            seen[hold] = bool(
                (pixels[:, 0] >= FRAME_W * 0.04).all()
                and (pixels[:, 0] <= FRAME_W * 0.96).all()
                and (pixels[:, 1] >= FRAME_H * 0.04).all()
                and (pixels[:, 1] <= FRAME_H * 0.96).all()
            )
        assert suggestion["reachable"] == any(seen.values())
        if suggestion["reachable"]:
            assert seen[suggestion["hold"]]

    reachable = [t for t in result["targets"] if t["reachable"]]
    # A camera above the screen loses the board for targets low on the canvas.
    assert reachable and len(reachable) < len(candidates)
    assert max(t["target_px"][1] for t in reachable) < 1800.0


def test_suggestions_are_empty_when_standing_too_close(
    driver: tuple[MirrorCalibrationDriver, RecordingContext], monkeypatch: pytest.MonkeyPatch
) -> None:
    camera = _camera()
    instance, context = _align_stage(driver, camera)
    _feed_faces(context, camera, _to_camera(np.array([0.0, -350.0, -450.0])))
    _feed_boards(context, [None], monkeypatch)
    result = _suggest(instance, candidates_px=[[540.0, 300.0]], rig=_rig_payload(TRUTH_RIG))
    assert not result["targets"][0]["reachable"]
    assert result["reason"] == "too_close"


def _rig_payload(rig: Rig) -> dict[str, Any]:
    return {
        "rotation": list(rig.rotation),
        "center_mm": list(rig.center_mm),
        "width_mm": rig.width_mm,
        "height_mm": rig.height_mm,
        "gap_mm": rig.gap_mm,
    }
