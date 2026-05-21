"""Tests that exercise the new Phase 6 drivers without requiring native deps.

These verify:
- Bridge discovers all expected driver classes.
- Each declared driver has unique events/actions/dependencies.
- The hand_sign geometric classifier returns plausible labels.
- The interpolate driver lerps numeric points correctly.
"""

from __future__ import annotations

from gosai_py.bridge import Bridge


EXPECTED_DRIVERS = {
    "heartbeat",
    "camera",
    "calibration",
    "interpolate",
    "microphone",
    "speaker",
    "frequency_analysis",
    "hand_pose",
    "pose",
    "hand_sign",
    "ball",
    "speech_activity_detection",
    "speech_to_text",
}


def test_bridge_discovers_all_phase6_drivers() -> None:
    bridge = Bridge()
    bridge.discover_builtin()
    found = set(bridge._driver_classes.keys())
    missing = EXPECTED_DRIVERS - found
    assert not missing, f"missing drivers: {missing}"


def test_each_driver_has_unique_metadata() -> None:
    bridge = Bridge()
    bridge.discover_builtin()
    for name, cls in bridge._driver_classes.items():
        assert cls.name == name
        assert len(set(cls.events)) == len(cls.events), f"{name} has duplicate events"
        assert len(set(cls.actions)) == len(cls.actions), f"{name} has duplicate actions"
        for dep in cls.dependencies:
            assert dep in bridge._driver_classes, f"{name} depends on missing {dep}"


def test_calibration_driver_exposes_core_actions() -> None:
    bridge = Bridge()
    bridge.discover_builtin()
    cls = bridge._driver_classes["calibration"]
    assert "get_latest_frame" in cls.actions
    assert "render_marker" in cls.actions
    assert "compute" in cls.actions


def test_hand_sign_classifier_recognizes_fist_and_open_hand() -> None:
    from gosai_py.drivers.hand_sign import _classify_hand

    # Build a synthetic FIST: every tip is closer to the wrist than its PIP,
    # and the thumb is curled across the palm (tip close to the index MCP).
    wrist = (0.5, 0.9)
    fist = [wrist] * 21
    for tip, pip, mcp in [(8, 6, 5), (12, 10, 9), (16, 14, 13), (20, 18, 17)]:
        fist[mcp] = (0.5, 0.7)
        fist[pip] = (0.5, 0.75)
        fist[tip] = (0.5, 0.78)
    # Curled thumb: tip is at the index MCP (i.e. across the palm), much closer
    # than the thumb IP joint.
    fist[2] = (0.45, 0.78)  # thumb MCP
    fist[3] = (0.48, 0.74)  # thumb IP
    fist[4] = (0.5, 0.7)  # thumb tip - at index MCP, "shorter" than IP from there
    label, _ = _classify_hand(fist)
    assert label == "FIST"

    # Build an OPEN_HAND: all five tips far from wrist (extended).
    open_hand = [wrist] * 21
    open_hand[2] = (0.45, 0.85)
    open_hand[3] = (0.42, 0.8)
    open_hand[4] = (0.4, 0.7)  # thumb extended (away from wrist)
    for tip, pip, mcp, y_offset in [
        (8, 6, 5, 0.3),
        (12, 10, 9, 0.25),
        (16, 14, 13, 0.3),
        (20, 18, 17, 0.35),
    ]:
        open_hand[mcp] = (0.5, 0.75)
        open_hand[pip] = (0.5, 0.6)
        open_hand[tip] = (0.5, y_offset)
    label, _ = _classify_hand(open_hand)
    assert label == "OPEN_HAND"


def test_interpolate_lerp_basic() -> None:
    from gosai_py.drivers.interpolate import _interpolate

    prev = [[0.0, 0.0], [10.0, 10.0]]
    nxt = [[2.0, 2.0], [20.0, 20.0]]
    result = _interpolate(prev, nxt, factor=0.5, depth=1)
    # depth=1: each pair is treated as a leaf and lerped.
    assert result[0] == [1.0, 1.0]
    assert result[1] == [15.0, 15.0]


def test_interpolate_shape_mismatch_returns_current() -> None:
    from gosai_py.drivers.interpolate import _interpolate

    prev = [[0.0, 0.0]]
    nxt = [[1.0, 1.0], [2.0, 2.0]]
    assert _interpolate(prev, nxt, factor=0.5, depth=1) == nxt
