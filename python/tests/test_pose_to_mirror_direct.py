"""Direct mode and the parts of `pose_to_mirror` that no calibration reaches.

Direct mode is the webcam selfie overlay: landmarks are normalised by the
camera frame and fitted to the canvas, with no geometry at all. The smoothing,
the payload shapes and the settings validation are shared with the calibrated
path, so they are checked here on the simpler one.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from fakes import RecordingContext, check_events
from gosai_py.clock import now_ms
from gosai_py.drivers.pose_to_mirror import PoseToMirrorDriver

FRAME_W, FRAME_H = 720.0, 1280.0
CANVAS_W, CANVAS_H = 1080.0, 1920.0
FACE_POINTS = 478
BASE_MS = now_ms() - 5_000.0


def _hand(x: float, y: float) -> list[list[float]]:
    return [[x + i, y + i, 0.8] for i in range(21)]


def _frame(step: int = 0, shift: float = 0.0) -> dict[str, Any]:
    """One raw pose payload, stamped `step` frames into a steady 30 Hz stream.

    The output filter is time aware, so a frame without a capture time of its
    own would either restart it or see no elapsed time at all.
    """
    ts = BASE_MS + step * 1000.0 / 30.0
    return {
        "body_pose": [[200.0 + shift + 8.0 * i, 120.0 + 30.0 * i, 0.9] for i in range(33)],
        "body_world_pose": [[0.01 * i, 0.02 * i, 0.0, 0.9] for i in range(33)],
        "right_hand_pose": _hand(300.0 + shift, 500.0),
        "left_hand_pose": _hand(400.0 + shift, 500.0),
        "face_mesh": [[360.0 + i % 7, 300.0 + i % 5, 1.0] for i in range(FACE_POINTS)],
        "frame_width": FRAME_W,
        "frame_height": FRAME_H,
        "ts": ts,
        "capture_ts": ts,
    }


def test_emits_payloads_matching_the_schema() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)

    for step in range(3):
        driver.on_data("pose", "raw_data", _frame(step))

    check_events(PoseToMirrorDriver, context)
    mirrored = context.emitted("mirrored_data")
    assert len(mirrored) == 3
    assert len(mirrored[-1]["face_mesh"]) == FACE_POINTS
    assert len(mirrored[-1]["right_hand_pose"]) == 21
    assert all(len(point) == 4 for point in mirrored[-1]["body_pose"])
    # Millimeters mean nothing without a rig, so direct mode sends none.
    assert context.emitted("projected_data") == []
    assert context.emitted("viewer") == []


def test_direct_mode_fits_and_mirrors_the_frame() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    driver.execute("set_mirror_config", {"width": CANVAS_W, "height": CANVAS_H, "fit": "contain"})
    raw = _frame()
    raw["body_pose"] = [[0.0, 0.0, 0.5]] * 33

    driver.on_data("pose", "raw_data", raw)

    # 720x1280 scales by 1.5 to exactly fill 1080x1920; x flips to the right edge.
    x, y, depth, visibility = context.emitted("mirrored_data")[0]["body_pose"][0]
    assert (x, y, depth, visibility) == pytest.approx((1080.0, 0.0, 0.0, 0.5))


def test_smoothing_lags_a_step_without_stopping_at_it() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)

    driver.on_data("pose", "raw_data", _frame(0))
    for step in range(1, 12):
        driver.on_data("pose", "raw_data", _frame(step, shift=100.0))

    payloads = [payload["body_pose"][0] for payload in context.emitted("mirrored_data")]
    step_px = -100.0 * CANVAS_W / FRAME_W  # flipped, then scaled to the canvas
    moved = payloads[1][0] - payloads[0][0]
    # One Euro gives way to a fast move, but never all at once.
    assert step_px < moved < 0.0
    assert abs(moved) < abs(step_px)
    # Holding still, it arrives.
    assert payloads[-1][0] - payloads[0][0] == pytest.approx(step_px, abs=1.0)


def test_smoothing_recovers_immediately_after_a_missing_landmark() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    gap, full = _frame(0), _frame(1)
    gap["body_pose"] = [[], *gap["body_pose"][1:]]

    driver.on_data("pose", "raw_data", gap)
    driver.on_data("pose", "raw_data", full)

    fresh = RecordingContext()
    PoseToMirrorDriver(fresh).on_data("pose", "raw_data", _frame(0))

    missing, recovered = (p["body_pose"][0] for p in context.emitted("mirrored_data"))
    assert np.isnan(missing[:2]).all()
    # The landmark starts where it reappeared, with nothing to climb out of.
    assert recovered[:2] == pytest.approx(fresh.emitted("mirrored_data")[0]["body_pose"][0][:2])


def test_face_mesh_opt_out_sends_empty_meshes() -> None:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    settings = driver.execute("set_mirror_config", {"face_mesh": False})

    driver.on_data("pose", "raw_data", _frame())

    assert settings["face_mesh"] is False
    assert context.emitted("mirrored_data")[0]["face_mesh"] == []


def test_invalid_settings_are_rejected() -> None:
    driver = PoseToMirrorDriver(RecordingContext())
    with pytest.raises(ValueError, match="mode"):
        driver.execute("set_mirror_config", {"mode": "sideways"})
    with pytest.raises(ValueError, match="trim_px"):
        driver.execute("set_mirror_config", {"trim_px": [4.0]})
    # No adult's pupils are 20 mm apart; a typo there would move every drawing.
    with pytest.raises(ValueError, match="ipd_mm"):
        driver.execute("set_mirror_config", {"ipd_mm": 20.0})
