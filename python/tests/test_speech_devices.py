from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from gosai_py.drivers import speech_to_text
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


def test_whisper_uses_cuda_with_a_device_and_cublas_12() -> None:
    assert select_device(AcceleratorConfig(), 1, cublas_12=True) == ("cuda", None)
    assert select_device(AcceleratorConfig(mode="tensorrt"), 1, cublas_12=True) == ("cuda", None)


def test_whisper_falls_back_to_cpu_and_says_why() -> None:
    assert select_device(AcceleratorConfig(), 0, cublas_12=False) == (
        "cpu",
        "CTranslate2 found no CUDA device",
    )
    assert select_device(AcceleratorConfig(mode="cpu"), 2, cublas_12=True)[0] == "cpu"
    assert select_device(AcceleratorConfig(mode="coreml"), 0, cublas_12=False)[1] == (
        "CTranslate2 has no coreml backend"
    )


def test_whisper_needs_cuda_12_cublas_not_just_a_driver() -> None:
    device, reason = select_device(AcceleratorConfig(), 1, cublas_12=False)

    assert device == "cpu"
    assert reason is not None and "cuBLAS for CUDA 12" in reason


def test_whisper_cuda_mode_raises_instead_of_falling_back() -> None:
    with pytest.raises(RuntimeError, match="found 1 CUDA devices"):
        select_device(AcceleratorConfig(mode="cuda", cuda_device_id=1), 1, cublas_12=True)
    with pytest.raises(RuntimeError, match="cuBLAS for CUDA 12"):
        select_device(AcceleratorConfig(mode="cuda"), 1, cublas_12=False)


def test_cublas_probe_reports_a_missing_library(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(name: str) -> None:
        raise OSError(f"{name}: cannot open shared object file")

    monkeypatch.setattr(speech_to_text.ctypes, "CDLL", missing)

    assert speech_to_text.cublas_12_loadable() is False
