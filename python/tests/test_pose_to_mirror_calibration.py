"""Synthetic round-trip test for the pose_to_mirror calibration solver.

Generates calibration samples from a ground-truth (tilt, scale, affine) using
the driver's own reflection math, then checks that capture + solve recovers the
parameters with near-zero residual.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any

import numpy as np
import pytest

from fakes import RecordingContext, check_events, check_result
from gosai_py.drivers.pose_to_mirror import RIGHT_INDEX, MirrorSettings, PoseToMirrorDriver
from gosai_py.geometry import mirror
from gosai_py.geometry.mirror import LEFT_SHOULDER, NOSE, RIGHT_SHOULDER

# MediaPipe hip/ankle indices (used by the physical-invariant test).
LEFT_HIP = 23
RIGHT_HIP = 24
LEFT_ANKLE = 27
RIGHT_ANKLE = 28

TRUE_TILT_DEG = 12.0
TRUE_SCALE = 1.0
# ax, bx, ay, by. The legacy above-the-mirror rig has ax > 0; a camera behind
# a one-way mirror (facing the user) needs ax < 0 -- both must be solvable.
TRUE_AFFINE = (2.4, 520.0, 2.6, 180.0)
TRUE_AFFINE_FLIPPED = (-2.4, 560.0, 2.6, 180.0)

FRAME_W = 720.0
FRAME_H = 1280.0
HFOV_DEG = 60.0  # matches the default settings


def _reflect(raw: dict[str, Any], index: int, tilt_deg: float, scale: float) -> np.ndarray:
    optics = MirrorSettings().optics(tilt_deg, scale)
    pose, world, sizes = mirror.stack_frames([raw])
    return mirror.reflect_landmark(pose, world, sizes, index, optics)[0]


def _project_px(x_mm: float, y_mm: float, z_mm: float) -> list[float]:
    """Pinhole projection of a camera-space mm point into frame pixels."""
    fx = (FRAME_W / 2.0) / math.tan(math.radians(HFOV_DEG) / 2.0)
    return [x_mm * fx / z_mm + FRAME_W / 2.0, y_mm * fx / z_mm + FRAME_H / 2.0]


def _make_raw(
    distance_mm: float,
    fingertip_mm: tuple[float, float],
) -> dict[str, Any]:
    """One synthetic pose payload: an upright subject at `distance_mm` with the
    right index fingertip at the given camera-space (x, y) mm position.

    All joints sit on the same depth plane with world z = 0, which makes the
    driver's weak-perspective distance estimate exact at scale=1.
    """
    joints_mm: dict[int, tuple[float, float]] = {
        NOSE: (0.0, -650.0),
        LEFT_SHOULDER: (200.0, -450.0),
        RIGHT_SHOULDER: (-200.0, -450.0),
        RIGHT_INDEX: fingertip_mm,
    }
    body_pose: list[list[float]] = []
    body_world: list[list[float]] = []
    for i in range(33):
        x_mm, y_mm = joints_mm.get(i, (0.0, 0.0))
        u, v = _project_px(x_mm, y_mm, distance_mm)
        body_pose.append([u, v, 0.9])
        body_world.append([x_mm / 1000.0, y_mm / 1000.0, 0.0, 0.9])
    return {
        "body_pose": body_pose,
        "body_world_pose": body_world,
        "frame_width": FRAME_W,
        "frame_height": FRAME_H,
        "ts": time.time(),
    }


def _target_for(
    raw: dict[str, Any],
    affine: tuple[float, float, float, float],
) -> list[float]:
    """Ground-truth target pixel: reflect with the true tilt/scale, then apply
    the true affine."""
    loc = _reflect(raw, RIGHT_INDEX, TRUE_TILT_DEG, TRUE_SCALE)
    assert np.isfinite(loc).all()
    ax, bx, ay, by = affine
    return [float(ax * loc[0] + bx), float(ay * loc[1] + by)]


@pytest.fixture()
def driver() -> PoseToMirrorDriver:
    return PoseToMirrorDriver(RecordingContext())


# Fingertip positions (camera-space mm) at two distances: spread over both
# axes so the affine is well conditioned, plus depth variation to pin tilt
# and scale.
SAMPLE_SPECS: list[tuple[float, tuple[float, float]]] = [
    (1200.0, (-350.0, -600.0)),
    (1200.0, (350.0, -550.0)),
    (1200.0, (-300.0, 100.0)),
    (1200.0, (320.0, 300.0)),
    (1200.0, (0.0, -150.0)),
    (2000.0, (-400.0, -500.0)),
    (2000.0, (380.0, 250.0)),
    (2000.0, (0.0, -700.0)),
]


def _capture_all(
    driver: PoseToMirrorDriver,
    affine: tuple[float, float, float, float] = TRUE_AFFINE,
) -> None:
    for distance, fingertip in SAMPLE_SPECS:
        raw = _make_raw(distance, fingertip)
        target = _target_for(raw, affine)
        for _ in range(6):
            driver.on_data("pose", "raw_data", _make_raw(distance, fingertip))
        result = check_result(
            PoseToMirrorDriver,
            "capture_calibration_sample",
            driver.execute("capture_calibration_sample", {"target": target}),
        )
        assert result["ok"], result
        assert result["landmark"] == RIGHT_INDEX


def test_capture_requires_recent_frames(driver: PoseToMirrorDriver) -> None:
    with pytest.raises(RuntimeError, match="recent pose frames"):
        driver.execute("capture_calibration_sample", {"target": [100, 100]})


@pytest.mark.parametrize("affine", [TRUE_AFFINE, TRUE_AFFINE_FLIPPED])
def test_solver_recovers_ground_truth(
    driver: PoseToMirrorDriver, affine: tuple[float, float, float, float]
) -> None:
    _capture_all(driver, affine)
    fit = driver.execute("solve_calibration", {})
    assert fit["ok"], fit

    assert fit["residual_px_mean"] < 3.0
    assert fit["residual_px_max"] < 6.0
    assert abs(fit["tilt_deg"] - TRUE_TILT_DEG) <= 1.0
    assert abs(fit["scale"] - TRUE_SCALE) <= 0.05
    ax, bx, ay, by = fit["affine"]
    assert ax == pytest.approx(affine[0], rel=0.05)
    assert ay == pytest.approx(affine[2], rel=0.05)
    assert bx == pytest.approx(affine[1], abs=25.0)
    assert by == pytest.approx(affine[3], abs=25.0)

    # The fit is applied to the live config/affine by default.
    cfg = check_result(
        PoseToMirrorDriver, "set_mirror_config", driver.execute("set_mirror_config", {})
    )
    assert cfg["affine"] == fit["affine"]
    assert cfg["tilt_deg"] == pytest.approx(fit["tilt_deg"])


def test_solver_respects_apply_false(driver: PoseToMirrorDriver) -> None:
    _capture_all(driver)
    before = driver.execute("set_mirror_config", None)
    fit = check_result(
        PoseToMirrorDriver, "solve_calibration", driver.execute("solve_calibration", {"apply": False})
    )
    assert fit["ok"], fit
    after = driver.execute("set_mirror_config", None)
    assert after["affine"] is None
    assert after["tilt_deg"] == before["tilt_deg"]


def test_clear_samples(driver: PoseToMirrorDriver) -> None:
    _capture_all(driver)
    assert driver.execute("clear_calibration_samples", None) == {"ok": True, "samples": 0}
    with pytest.raises(RuntimeError, match="need at least"):
        driver.execute("solve_calibration", {})


# ---------------------------------------------------------------------------
# Physical invariants of the reflection math
# ---------------------------------------------------------------------------

MIRROR_TILT_DEG = 17.0

# Mirror-frame joint positions (x right, y down, z = distance from the mirror
# plane, all mm). The camera center sits on the extended mirror plane (z = 0),
# tilted down by MIRROR_TILT_DEG. The person stands parallel to the mirror.
STANDING_JOINTS_MIRROR: dict[int, tuple[float, float]] = {
    NOSE: (0.0, 200.0),
    LEFT_SHOULDER: (200.0, 400.0),
    RIGHT_SHOULDER: (-200.0, 400.0),
    LEFT_HIP: (100.0, 1000.0),
    RIGHT_HIP: (-100.0, 1000.0),
    LEFT_ANKLE: (150.0, 1800.0),
    RIGHT_ANKLE: (-150.0, 1800.0),
}


def _make_standing_raw(distance_mm: float, tilt_deg: float) -> dict[str, Any]:
    """Raw pose payload for a person standing at `distance_mm` from the mirror.

    Joints are placed in the mirror frame, moved into the tilted camera frame,
    and projected through the same pinhole model the driver assumes. World
    coordinates follow the MediaPipe convention: metric, camera-aligned axes,
    origin at the mid-hip point.
    """
    theta = math.radians(tilt_deg)
    cos_t, sin_t = math.cos(theta), math.sin(theta)

    def to_camera(x: float, y: float, z: float) -> tuple[float, float, float]:
        return (x, y * cos_t - z * sin_t, y * sin_t + z * cos_t)

    cam = {
        i: to_camera(x, y, distance_mm) for i, (x, y) in STANDING_JOINTS_MIRROR.items()
    }
    mid_hip = tuple(
        (a + b) / 2.0 for a, b in zip(cam[LEFT_HIP], cam[RIGHT_HIP], strict=True)
    )
    body_pose: list[list[float]] = []
    body_world: list[list[float]] = []
    for i in range(33):
        x, y, z = cam.get(i, cam[NOSE])
        u, v = _project_px(x, y, z)
        body_pose.append([u, v, 0.9])
        body_world.append(
            [
                (x - mid_hip[0]) / 1000.0,
                (y - mid_hip[1]) / 1000.0,
                (z - mid_hip[2]) / 1000.0,
                0.9,
            ]
        )
    return {
        "body_pose": body_pose,
        "body_world_pose": body_world,
        "frame_width": FRAME_W,
        "frame_height": FRAME_H,
        "ts": time.time(),
    }


@pytest.mark.parametrize("distance_mm", [1000.0, 1500.0, 2500.0])
def test_reflection_matches_physical_mirror(
    driver: PoseToMirrorDriver, distance_mm: float
) -> None:
    """The trace of your reflection on the glass is half your size, at any
    distance: the glass point for body point P seen from eye E is (E + P) / 2
    in mirror-plane coordinates. The projected coordinates must therefore be
    independent of distance and match that midpoint exactly."""
    raw = _make_standing_raw(distance_mm, MIRROR_TILT_DEG)
    eye_x, eye_y = STANDING_JOINTS_MIRROR[NOSE]

    reflected: dict[int, np.ndarray] = {}
    for index, (px, py) in STANDING_JOINTS_MIRROR.items():
        loc = _reflect(raw, index, MIRROR_TILT_DEG, 1.0)
        assert np.isfinite(loc).all()
        assert loc[0] == pytest.approx((eye_x + px) / 2.0, abs=1e-3)
        assert loc[1] == pytest.approx((eye_y + py) / 2.0, abs=1e-3)
        reflected[index] = loc

    real_span = STANDING_JOINTS_MIRROR[LEFT_ANKLE][1] - STANDING_JOINTS_MIRROR[NOSE][1]
    glass_span = reflected[LEFT_ANKLE][1] - reflected[NOSE][1]
    assert glass_span == pytest.approx(real_span / 2.0, abs=1e-3)


def test_mirror_offset_shifts_intersection() -> None:
    """A camera offset along the mirror normal changes the interpolation
    weight when eye and point sit at different depths."""
    fx = 600.0
    ppx, ppy = FRAME_W / 2.0, FRAME_H / 2.0
    eye_depth, point_depth = 2000.0, 1000.0
    eye = (0.0, 0.0, eye_depth)
    point_mm = (100.0, 300.0)
    point_px = [
        point_mm[0] * fx / point_depth + ppx,
        point_mm[1] * fx / point_depth + ppy,
    ]

    for offset in (0.0, 100.0):
        t = (eye_depth - offset) / (eye_depth + point_depth - 2.0 * offset)
        point = mirror.deproject(point_px, point_depth, fx, ppx, ppy)
        loc = mirror.reflect(eye, point, 0.0, offset)
        assert loc[0] == pytest.approx(t * point_mm[0], abs=1e-6)
        assert loc[1] == pytest.approx(t * point_mm[1], abs=1e-6)


def test_mirror_offset_config_roundtrip(driver: PoseToMirrorDriver) -> None:
    cfg = driver.execute("set_mirror_config", {"mirror_offset_mm": 45.0})
    assert cfg["mirror_offset_mm"] == 45.0


def _hand(x: float, y: float) -> list[list[float]]:
    return [[x + i, y + i, 0.8] for i in range(21)]


def _live_frame() -> dict[str, Any]:
    raw = _make_standing_raw(1500.0, MIRROR_TILT_DEG)
    raw["right_hand_pose"] = _hand(300.0, 500.0)
    raw["left_hand_pose"] = _hand(400.0, 500.0)
    raw["face_mesh"] = [[360.0 + i % 7, 300.0 + i % 5, 1.0] for i in range(478)]
    return raw


@pytest.mark.parametrize("mode", ["direct", "reflection"])
def test_emits_payloads_matching_the_schema(mode: str) -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    driver.execute("set_mirror_config", {"mode": mode})

    for _ in range(3):
        driver.on_data("pose", "raw_data", _live_frame())

    check_events(PoseToMirrorDriver, context)
    mirrored = context.emitted("mirrored_data")
    assert len(mirrored) == 3
    assert len(mirrored[-1]["face_mesh"]) == 478
    assert len(mirrored[-1]["right_hand_pose"]) == 21
    assert all(len(point) == 4 for point in mirrored[-1]["body_pose"])
    assert len(context.emitted("projected_data")) == (3 if mode == "reflection" else 0)


def test_direct_mode_fits_and_mirrors_the_frame() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    driver.execute("set_mirror_config", {"width": 1080, "height": 1920, "fit": "contain"})
    raw = _live_frame()
    raw["body_pose"] = [[0.0, 0.0, 0.5]] * 33
    raw["frame_width"], raw["frame_height"] = 720.0, 1280.0

    driver.on_data("pose", "raw_data", raw)

    # 720x1280 scales by 1.5 to exactly fill 1080x1920; x flips to the right edge.
    x, y, depth, visibility = context.emitted("mirrored_data")[0]["body_pose"][0]
    assert (x, y, depth, visibility) == pytest.approx((1080.0, 0.0, 0.0, 0.5))


def test_smoothing_moves_part_of_the_way() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    first, second = _live_frame(), _live_frame()
    second["body_pose"] = [[u + 100.0, v, vis] for u, v, vis in first["body_pose"]]

    driver.on_data("pose", "raw_data", first)
    driver.on_data("pose", "raw_data", second)

    before, after = (payload["body_pose"][0] for payload in context.emitted("mirrored_data"))
    unsmoothed_shift = -100.0 * 1080.0 / 720.0  # flipped, then scaled to the canvas
    assert after[0] - before[0] == pytest.approx(0.4 * unsmoothed_shift)


def test_face_mesh_opt_out_sends_empty_meshes() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    settings = driver.execute("set_mirror_config", {"face_mesh": False})

    driver.on_data("pose", "raw_data", _live_frame())

    assert settings["face_mesh"] is False
    assert context.emitted("mirrored_data")[0]["face_mesh"] == []


def test_invalid_settings_are_rejected(driver: PoseToMirrorDriver) -> None:
    with pytest.raises(ValueError, match="mode"):
        driver.execute("set_mirror_config", {"mode": "sideways"})
    with pytest.raises(ValueError, match="affine"):
        driver.execute("set_mirror_config", {"affine": [1.0, 2.0]})


def test_capture_while_frames_arrive_on_another_thread(driver: PoseToMirrorDriver) -> None:
    stop = threading.Event()

    def feed() -> None:
        while not stop.is_set():
            driver.on_data("pose", "raw_data", _make_raw(1200.0, (0.0, -150.0)))

    thread = threading.Thread(target=feed)
    thread.start()
    try:
        captured = 0
        deadline = time.monotonic() + 5.0
        while captured < 20 and time.monotonic() < deadline:
            try:
                driver.execute("capture_calibration_sample", {"target": [100, 100]})
                captured += 1
            except RuntimeError as exc:
                assert "recent pose frames" in str(exc)
    finally:
        stop.set()
        thread.join()
    assert captured == 20
