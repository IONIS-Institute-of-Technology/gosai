from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gosai_py.drivers.speech_activity_detection import MODEL, SileroVad
from gosai_py.drivers.speech_to_text import select_device
from gosai_py.runtime import AcceleratorConfig


class FakeSileroSession:
    """Records inputs and returns a score equal to the mean of the new samples."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run(self, _outputs: None, feeds: dict[str, Any]) -> list[Any]:
        self.calls.append({key: np.array(value, copy=True) for key, value in feeds.items()})
        score = feeds["input"][:, SileroVad.CONTEXT :].mean()
        return [np.array([[score]], dtype=np.float32), feeds["state"] + 1]


def test_silero_vad_carries_context_and_state() -> None:
    session = FakeSileroSession()
    vad = SileroVad(session)
    first = np.full(512, 0.25, dtype=np.float32)
    second = np.arange(512, dtype=np.float32)

    assert vad(first) == pytest.approx(0.25)
    vad(second)

    one, two = session.calls
    assert one["input"].shape == (1, 576)
    assert not one["input"][:, :64].any()
    assert np.array_equal(two["input"][0, :64], first[-64:])
    assert np.array_equal(two["state"], one["state"] + 1)
    assert two["sr"] == 16_000


def test_silero_vad_rejects_other_block_sizes() -> None:
    with pytest.raises(ValueError, match="512 samples"):
        SileroVad(FakeSileroSession())(np.zeros(480, dtype=np.float32))


def test_silero_model_is_pinned() -> None:
    assert MODEL.url is not None and "/v6.2.1/" in MODEL.url
    assert MODEL.sha256 is not None


def test_whisper_uses_cuda_when_ctranslate2_sees_a_device() -> None:
    assert select_device(AcceleratorConfig(), cuda_devices=1) == ("cuda", None)
    assert select_device(AcceleratorConfig(mode="tensorrt"), cuda_devices=1) == ("cuda", None)


def test_whisper_falls_back_to_cpu_and_says_why() -> None:
    assert select_device(AcceleratorConfig(), cuda_devices=0) == (
        "cpu",
        "CTranslate2 found no CUDA device",
    )
    assert select_device(AcceleratorConfig(mode="cpu"), cuda_devices=2)[0] == "cpu"
    assert select_device(AcceleratorConfig(mode="coreml"), cuda_devices=0)[1] == (
        "CTranslate2 has no coreml backend"
    )


def test_whisper_cuda_mode_needs_the_requested_device() -> None:
    with pytest.raises(RuntimeError, match="found 1 CUDA devices"):
        select_device(AcceleratorConfig(mode="cuda", cuda_device_id=1), cuda_devices=1)
