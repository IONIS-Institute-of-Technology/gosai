"""Driver discovery, the metadata apps rely on, and small pure helpers."""

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
    "pose_to_mirror",
    "mirror_calibration",
    "hand_sign",
    "slr",
    "ball",
    "speech_activity_detection",
    "speech_to_text",
}


def test_bridge_discovers_all_builtin_drivers() -> None:
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


# Events, actions and dependencies apps rely on. Drivers may declare more.
EXPECTED_METADATA: dict[str, dict[str, tuple[str, ...]]] = {
    "heartbeat": {"events": ("tick",), "actions": ("echo",), "dependencies": ()},
    "camera": {
        "events": ("frame", "color", "frame_size", "fps"),
        "actions": (
            "set_device",
            "set_mode",
            "set_resolution",
            "set_fps",
            "snapshot",
            "list_formats",
        ),
        "dependencies": (),
    },
    "calibration": {
        "events": ("detection", "homography", "status"),
        "actions": (
            "set_marker_layout",
            "set_camera_event",
            "compute",
            "clear",
            "render_marker",
            "get_latest_frame",
            "reproject_point",
            "reproject_points",
        ),
        "dependencies": ("camera",),
    },
    "interpolate": {
        "events": ("interpolated_data",),
        "actions": ("interpolate_points", "reset"),
        "dependencies": (),
    },
    "microphone": {
        "events": ("audio_stream", "settings"),
        "actions": ("list_devices", "set_device", "set_samplerate"),
        "dependencies": (),
    },
    "speaker": {
        "events": ("settings", "underrun"),
        "actions": ("play", "clear", "list_devices", "set_device", "set_samplerate"),
        "dependencies": (),
    },
    "frequency_analysis": {
        "events": ("frequency",),
        "actions": ("set_max_frequency", "set_window_size"),
        "dependencies": ("microphone",),
    },
    "hand_pose": {
        "events": ("raw_data",),
        "actions": (
            "set_flip",
            "set_window",
            "set_homography",
            "set_frame_size",
            "set_surface_size",
        ),
        "dependencies": ("camera",),
    },
    "pose": {
        "events": ("raw_data",),
        "actions": ("set_flip", "set_window"),
        "dependencies": ("camera",),
    },
    "pose_to_mirror": {
        "events": ("mirrored_data", "projected_data", "viewer"),
        "actions": ("set_mirror_config", "reset_viewer"),
        "dependencies": ("pose",),
    },
    "mirror_calibration": {
        "events": ("board", "lens_progress"),
        "actions": (
            "configure",
            "set_stage",
            "reset_lens",
            "solve_lens",
            "capture_alignment",
            "remove_alignment",
            "clear_alignments",
            "list_alignments",
            "solve_rig",
            "check_rig",
        ),
        "dependencies": ("camera", "pose"),
    },
    "slr": {"events": ("new_sign",), "actions": ("set_actions",), "dependencies": ("pose",)},
    "hand_sign": {"events": ("sign",), "actions": (), "dependencies": ("hand_pose",)},
    "ball": {
        "events": ("balls", "fps"),
        "actions": (
            "set_homography",
            "set_output_size",
            "set_confidence",
            "set_max_ball_px",
            "set_min_ball_px",
            "set_frame_skip",
            "set_cuda_device",
        ),
        "dependencies": ("camera",),
    },
    "speech_activity_detection": {
        "events": ("activity",),
        "actions": ("predict", "reset"),
        "dependencies": ("microphone",),
    },
    "speech_to_text": {
        "events": ("transcription",),
        "actions": ("transcribe", "set_model"),
        "dependencies": (),
    },
}


def test_drivers_declare_the_metadata_apps_rely_on() -> None:
    bridge = Bridge()
    bridge.discover_builtin()
    for name, expected in EXPECTED_METADATA.items():
        cls = bridge._driver_classes[name]
        for field in ("events", "actions", "dependencies"):
            declared = getattr(cls, field)
            missing = [item for item in expected[field] if item not in declared]
            assert not missing, f"{name} is missing {field} {missing}; declares {declared}"


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
