"""pose, hand_pose, hand_sign and slr with MediaPipe replaced by fakes."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from fakes import RecordingContext, check_events, check_result
from gosai_py.drivers import hand_pose, pose, slr
from gosai_py.drivers.hand_pose import HandPoseDriver
from gosai_py.drivers.hand_sign import HandSignDriver
from gosai_py.drivers.pose import PoseDriver
from gosai_py.drivers.slr import _adapt_frame


def _landmarks(count: int, x: float = 0.5, y: float = 0.25) -> list[SimpleNamespace]:
    return [SimpleNamespace(x=x, y=y, z=0.1, visibility=0.9) for _ in range(count)]


class FakeDetector:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.images: list[Any] = []

    def detect_for_video(self, image: Any, ts_ms: int) -> Any:
        self.images.append(image)
        return self.result

    def close(self) -> None:
        pass


def _frame(width: int, height: int) -> dict[str, Any]:
    return {"_frame": np.zeros((height, width, 3), dtype=np.uint8), "capture_ts": 1.0}


@pytest.fixture
def pose_driver(monkeypatch: pytest.MonkeyPatch) -> tuple[PoseDriver, RecordingContext]:
    result = SimpleNamespace(
        face_landmarks=_landmarks(478),
        pose_landmarks=_landmarks(33),
        left_hand_landmarks=_landmarks(21, x=0.1),
        right_hand_landmarks=_landmarks(21, x=0.9),
        pose_world_landmarks=_landmarks(33),
    )
    monkeypatch.setattr(pose, "resolve_model", lambda model, log: "holistic.task")
    monkeypatch.setattr(pose, "mediapipe_base_options", lambda *a, **k: (None, {"provider": "CPUDelegate"}))
    monkeypatch.setattr(pose.vision, "HolisticLandmarkerOptions", lambda **kwargs: kwargs)
    monkeypatch.setattr(pose.vision.HolisticLandmarker, "create_from_options", lambda options: FakeDetector(result))
    context = RecordingContext()
    driver = PoseDriver(context)
    driver.pre_run()
    return driver, context


def test_pose_emits_landmarks_in_frame_pixels(pose_driver: tuple[PoseDriver, RecordingContext]) -> None:
    driver, context = pose_driver
    driver.execute("set_window", 0.5)

    driver.on_data("camera", "frame", _frame(800, 400))

    payload = context.emitted("raw_data")[0]
    # The window keeps x in [200, 600); landmark x=0.5 of that crop is pixel 400.
    assert payload["body_pose"][0] == [400.0, 100.0, 0.9]
    # Hand keys are swapped relative to the model output.
    assert payload["right_hand_pose"][0][0] == pytest.approx(200 + 0.1 * 400)
    assert len(payload["face_mesh"]) == 478
    assert (payload["frame_width"], payload["frame_height"]) == (800.0, 400.0)
    check_events(PoseDriver, context)


def test_pose_face_mesh_opt_out_keeps_it_in_process(pose_driver: tuple[PoseDriver, RecordingContext]) -> None:
    driver, context = pose_driver
    assert check_result(PoseDriver, "set_face_mesh", driver.execute("set_face_mesh", False)) == {"face_mesh": False}

    driver.on_data("camera", "frame", _frame(640, 480))

    payload = context.emitted("raw_data")[0]
    assert payload["face_mesh"] == []
    assert len(payload["_face_mesh"]) == 478
    # slr still sees the face landmarks.
    assert _adapt_frame(payload, include_face=True)[:2] != [0.0, 0.0]
    check_events(PoseDriver, context)


def test_pose_config_applies_before_start(monkeypatch: pytest.MonkeyPatch) -> None:
    driver = PoseDriver(RecordingContext())
    driver.apply_config({"flip": True, "window": 7, "face_mesh": False})
    assert driver._config == pose.PoseConfig(flip=True, window=1.0, face_mesh=False)


@pytest.fixture
def hand_driver(monkeypatch: pytest.MonkeyPatch) -> tuple[HandPoseDriver, RecordingContext]:
    result = SimpleNamespace(
        hand_landmarks=[_landmarks(21)],
        handedness=[[SimpleNamespace(index=0, category_name="Left", score=0.8)]],
    )
    monkeypatch.setattr(hand_pose, "resolve_model", lambda model, log: "hand.task")
    monkeypatch.setattr(hand_pose, "mediapipe_base_options", lambda *a, **k: (None, {"provider": "CPUDelegate"}))
    monkeypatch.setattr(hand_pose.vision, "HandLandmarkerOptions", lambda **kwargs: kwargs)
    monkeypatch.setattr(hand_pose.vision.HandLandmarker, "create_from_options", lambda options: FakeDetector(result))
    context = RecordingContext()
    driver = HandPoseDriver(context)
    driver.pre_run()
    return driver, context


def test_hand_pose_emits_normalised_landmarks(hand_driver: tuple[HandPoseDriver, RecordingContext]) -> None:
    driver, context = hand_driver
    driver.execute("set_window", 0.5)

    driver.on_data("camera", "frame", _frame(800, 600))

    payload = context.emitted("raw_data")[0]
    assert payload["hands_landmarks"][0][0] == pytest.approx([0.5, 0.25])
    assert payload["hands_handedness"] == [(0, "Left", 0.8)]
    check_events(HandPoseDriver, context)


def test_hand_pose_warp_follows_the_live_frame_size(hand_driver: tuple[HandPoseDriver, RecordingContext]) -> None:
    driver, context = hand_driver
    identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    assert check_result(HandPoseDriver, "set_homography", driver.execute("set_homography", identity)) == {
        "ok": True,
        "cleared": False,
    }
    check_result(HandPoseDriver, "set_surface_size", driver.execute("set_surface_size", {"width": 400, "height": 300}))

    driver.on_data("camera", "frame", _frame(800, 600))
    driver.on_data("camera", "frame", _frame(400, 300))

    first, second = (p["hands_landmarks"][0][0] for p in context.emitted("raw_data"))
    assert first == pytest.approx([1.0, 0.5])
    assert second == pytest.approx([0.5, 0.25])

    driver.execute("set_frame_size", {"width": 800, "height": 600})
    driver.on_data("camera", "frame", _frame(400, 300))
    assert context.emitted("raw_data")[-1]["hands_landmarks"][0][0] == pytest.approx([1.0, 0.5])
    assert driver.execute("set_homography", None) == {"ok": True, "cleared": True}
    with pytest.raises(ValueError, match="Expected `int`"):
        driver.execute("set_surface_size", {"width": "wide", "height": 3})


def test_hand_sign_classifies_hand_pose_output() -> None:
    context = RecordingContext()
    driver = HandSignDriver(context)
    wrist = [0.5, 0.9]
    fist = [wrist] * 21
    for tip, pip, mcp in [(8, 6, 5), (12, 10, 9), (16, 14, 13), (20, 18, 17)]:
        fist[mcp], fist[pip], fist[tip] = [0.5, 0.7], [0.5, 0.75], [0.5, 0.78]
    fist[2], fist[3], fist[4] = [0.45, 0.78], [0.48, 0.74], [0.5, 0.7]

    driver.on_data("hand_pose", "raw_data", {"hands_landmarks": [fist, [[0.0, 0.0]] * 3]})

    assert context.emitted("sign")[0]["sign"] == [("FIST", 0.95), ("UNKNOWN", 0.0)]
    check_events(HandSignDriver, context)


def test_slr_classifies_a_full_window(monkeypatch: pytest.MonkeyPatch) -> None:
    class Session:
        inputs: list[np.ndarray] = []  # noqa: RUF012

        def get_inputs(self) -> list[SimpleNamespace]:
            return [SimpleNamespace(name="input", shape=[1, 30, 158])]

        def run(self, _outputs: None, feeds: dict[str, np.ndarray]) -> list[np.ndarray]:
            self.inputs.append(feeds["input"])
            logits = np.zeros((1, 16), dtype=np.float32)
            logits[0, 3] = 5.0
            return [logits]

    monkeypatch.setattr(slr, "resolve_model", lambda model, log: Path(model.filename))
    monkeypatch.setattr(slr, "create_onnx_session", lambda path, **_: (Session(), {"backend": "onnxruntime"}))
    context = RecordingContext()
    driver = slr.SLRDriver(context)
    labels = [f"sign_{i}" for i in range(16)]

    assert check_result(slr.SLRDriver, "set_actions", driver.execute("set_actions", labels)) == {"ok": True}
    frame = {"body_pose": [[320.0, 240.0, 1.0]] * 33, "face_mesh": [[1.0, 2.0, 1.0]] * 478}
    for _ in range(slr.SEQUENCE_LENGTH):
        driver.on_data("pose", "raw_data", frame)

    assert Session.inputs[0].shape == (1, 30, 158)
    sign = context.emitted("new_sign")[0]
    assert sign["guessed_sign"] == "sign_3" and sign["probability"] > 0.9
    check_events(slr.SLRDriver, context)
    with pytest.raises(ValueError, match="no model for 3 actions"):
        driver.execute("set_actions", ["a", "b", "c"])


def test_hand_pose_rate_limits_detection_failures(hand_driver: tuple[HandPoseDriver, RecordingContext]) -> None:
    driver, context = hand_driver

    class Broken(FakeDetector):
        def detect_for_video(self, image: Any, ts_ms: int) -> Any:
            raise RuntimeError("graph failed")

    driver._detector = Broken(None)
    for _ in range(20):
        driver.on_data("camera", "frame", _frame(64, 48))

    warnings = [message for level, message in context.logs if level == "warn"]
    assert len(warnings) == 1 and "graph failed" in warnings[0]
    assert context.emitted("raw_data") == []
