"""Synthetic round-trip test for the pose_to_mirror calibration solver.

Generates calibration samples from a ground-truth (tilt, scale, affine) using
the driver's own reflection math, then checks that capture + solve recovers the
parameters with near-zero residual.
"""

from __future__ import annotations

import math
import time
from typing import Any

import pytest

from gosai_py.driver import DriverContext
from gosai_py.drivers.pose_to_mirror import (
    LEFT_SHOULDER,
    NOSE,
    RIGHT_INDEX,
    RIGHT_SHOULDER,
    PoseToMirrorDriver,
)

TRUE_TILT_DEG = 12.0
TRUE_SCALE = 1.0
TRUE_AFFINE = (2.4, 520.0, 2.6, 180.0)  # ax, bx, ay, by

FRAME_W = 720.0
FRAME_H = 1280.0
HFOV_DEG = 60.0  # matches DEFAULT_CONFIG


class _FakeContext(DriverContext):
    def __init__(self) -> None:
        self.events: list[tuple[str, Any]] = []

    def emit(self, event: str, data: Any) -> None:
        self.events.append((event, data))

    def log(self, level: str, message: str) -> None:
        pass

    def record_performance(self, metric: str, value: float) -> None:
        pass

    def set_state(self, state: str, runtime_info: dict[str, Any] | None = None) -> None:
        pass

    def subscribe(self, driver: str, event: str, callback: Any) -> None:
        pass

    def unsubscribe(self, driver: str, event: str, callback: Any) -> None:
        pass

    def get_event_data(self, driver: str, event: str) -> Any:
        return None

    def has_subscribers(self, event: str) -> bool:
        return True


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


def _target_for(driver: PoseToMirrorDriver, raw: dict[str, Any]) -> list[float]:
    """Ground-truth target pixel: reflect with the true tilt/scale, then apply
    the true affine."""
    loc = driver._reflect_body_landmark(raw, RIGHT_INDEX, TRUE_TILT_DEG, TRUE_SCALE)
    assert loc is not None
    ax, bx, ay, by = TRUE_AFFINE
    return [ax * loc[0] + bx, ay * loc[1] + by]


@pytest.fixture()
def driver() -> PoseToMirrorDriver:
    return PoseToMirrorDriver(_FakeContext())


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


def _capture_all(driver: PoseToMirrorDriver) -> None:
    for distance, fingertip in SAMPLE_SPECS:
        raw = _make_raw(distance, fingertip)
        target = _target_for(driver, raw)
        driver._raw_history.extend(_make_raw(distance, fingertip) for _ in range(6))
        result = driver.execute("capture_calibration_sample", {"target": target})
        assert result["ok"], result
        assert result["landmark"] == RIGHT_INDEX


def test_capture_requires_recent_frames(driver: PoseToMirrorDriver) -> None:
    result = driver.execute("capture_calibration_sample", {"target": [100, 100]})
    assert not result["ok"]
    assert "recent pose frames" in result["error"]


def test_solver_recovers_ground_truth(driver: PoseToMirrorDriver) -> None:
    _capture_all(driver)
    fit = driver.execute("solve_calibration", {})
    assert fit["ok"], fit

    assert fit["residual_px_mean"] < 3.0
    assert fit["residual_px_max"] < 6.0
    assert abs(fit["tilt_deg"] - TRUE_TILT_DEG) <= 1.0
    assert abs(fit["scale"] - TRUE_SCALE) <= 0.05
    ax, bx, ay, by = fit["affine"]
    assert ax == pytest.approx(TRUE_AFFINE[0], rel=0.05)
    assert ay == pytest.approx(TRUE_AFFINE[2], rel=0.05)
    assert bx == pytest.approx(TRUE_AFFINE[1], abs=25.0)
    assert by == pytest.approx(TRUE_AFFINE[3], abs=25.0)

    # The fit is applied to the live config/affine by default.
    assert driver._affine is not None
    cfg = driver.execute("set_mirror_config", {})
    assert cfg["affine"] == fit["affine"]
    assert cfg["tilt_deg"] == pytest.approx(fit["tilt_deg"])


def test_solver_respects_apply_false(driver: PoseToMirrorDriver) -> None:
    _capture_all(driver)
    before_tilt = driver._config["tilt_deg"]
    fit = driver.execute("solve_calibration", {"apply": False})
    assert fit["ok"], fit
    assert driver._affine is None
    assert driver._config["tilt_deg"] == before_tilt


def test_clear_samples(driver: PoseToMirrorDriver) -> None:
    _capture_all(driver)
    assert driver.execute("clear_calibration_samples", None) == {"ok": True, "samples": 0}
    result = driver.execute("solve_calibration", {})
    assert not result["ok"]
