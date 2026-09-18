"""CPU smoke tests for the bundled ONNX models.

CI checks the repo out without Git LFS, so the models are pointer files there
and these tests skip.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gosai_py.driver import DriverContext
from gosai_py.drivers import ball, slr
from gosai_py.runtime import AcceleratorConfig, create_onnx_session
from gosai_py.runtime.models import Model, is_lfs_pointer, resolve_model


def _log(level: str, message: str) -> None:
    pass


def _require_pulled(model: Model) -> None:
    assert model.path is not None
    if is_lfs_pointer(model.path):
        pytest.skip(f"{model.filename} is a Git LFS pointer; run `git lfs pull`")


class _Context(DriverContext):
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


@pytest.mark.parametrize(("actions", "features"), [(16, 158), (17, 150)])
def test_slr_model_classifies_a_window_on_cpu(
    actions: int, features: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    _require_pulled(slr.MODELS[actions])
    # auto mode with no accelerator installed: SLR is small enough for CPU.
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    monkeypatch.delenv("GOSAI_ALLOW_CPU_FALLBACK", raising=False)
    monkeypatch.setattr("onnxruntime.get_available_providers", lambda: ["CPUExecutionProvider"])
    context = _Context()
    driver = slr.SLRDriver(context)
    labels = [f"sign_{i}" for i in range(actions)]

    assert driver.execute("set_actions", labels) is None
    assert driver.runtime_info() is not None
    frame = {
        "body_pose": [[320.0, 240.0, 1.0]] * 33,
        "right_hand_pose": [[300.0, 200.0, 1.0]] * 21,
        "left_hand_pose": [[340.0, 200.0, 1.0]] * 21,
        "face_mesh": [[320.0, 100.0, 1.0]] * 468,
    }
    assert len(slr._adapt_frame(frame, driver._include_face)) == features
    for _ in range(slr.SEQUENCE_LENGTH):
        driver.on_data("pose", "raw_data", frame)

    event, payload = context.events[-1]
    assert event == "new_sign"
    assert payload["guessed_sign"] in labels
    assert 0.0 <= payload["probability"] <= 1.0


def test_ball_model_detects_on_cpu() -> None:
    _require_pulled(ball.MODEL)
    path = resolve_model(ball.MODEL, _log)
    session, info = create_onnx_session(path, log_fn=_log, config=AcceleratorConfig(mode="cpu"))
    name, size = ball._input_spec(session)
    frame = np.full((720, 1280, 3), 90, dtype=np.uint8)

    tensor, scale, pad = ball._preprocess(frame, size)
    outputs = session.run(None, {name: tensor})

    assert info.get("provider") == "CPUExecutionProvider"
    assert tensor.shape == (1, 3, *size)
    assert outputs[0].shape[0] == 1 and outputs[0].shape[-1] == 6
    detections = ball._postprocess(outputs, scale, pad, 0.7, 10.0, 100.0, 1.6)
    assert isinstance(detections, list)
