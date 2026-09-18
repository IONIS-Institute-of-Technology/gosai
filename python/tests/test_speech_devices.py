from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from fakes import RecordingContext, check_events, check_result
from gosai_py.drivers import speech_activity_detection as vad_module
from gosai_py.drivers import speech_to_text
from gosai_py.drivers.speech_activity_detection import MODEL, SileroVad, SpeechActivityDriver
from gosai_py.drivers.speech_to_text import select_device
from gosai_py.runtime import AcceleratorConfig
from gosai_py.runtime.models import models_dir


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


def _vad_driver(
    monkeypatch: pytest.MonkeyPatch, session: Any
) -> tuple[SpeechActivityDriver, RecordingContext]:
    context = RecordingContext()
    driver = SpeechActivityDriver(context)
    driver._model = SileroVad(session)
    return driver, context


def _block(samples: np.ndarray) -> dict[str, Any]:
    return {"_block": samples.reshape(-1, 1), "samplerate": 16_000}


def test_vad_scores_microphone_blocks_in_512_sample_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = FakeSileroSession()
    driver, context = _vad_driver(monkeypatch, session)
    audio = np.arange(1024 + 700 + 700, dtype=np.float32)

    driver.on_data("microphone", "audio_stream", _block(audio[:1024]))
    driver.on_data("microphone", "audio_stream", _block(audio[1024:1724]))
    driver.on_data(
        "microphone",
        "audio_stream",
        {"block": audio[1724:].reshape(-1, 1).tolist(), "samplerate": 16_000},
    )

    # 2424 samples make four full windows; 376 wait for the next block.
    windows = [call["input"][0, SileroVad.CONTEXT :] for call in session.calls]
    assert len(windows) == 4
    assert np.array_equal(np.concatenate(windows), audio[:2048])
    assert [e["confidence"] for e in context.emitted("activity")] == pytest.approx(
        [float(w.mean()) for w in windows]
    )
    check_events(SpeechActivityDriver, context)


def test_vad_resets_when_the_samplerate_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakeSileroSession()
    driver, context = _vad_driver(monkeypatch, session)
    driver.on_data("microphone", "audio_stream", _block(np.ones(700, dtype=np.float32)))

    driver.on_data(
        "microphone",
        "audio_stream",
        {"_block": np.ones((700, 1), np.float32), "samplerate": 44_100},
    )
    driver.on_data("microphone", "audio_stream", _block(np.full(512, 2.0, dtype=np.float32)))

    assert any("44100 Hz" in message for _, message in context.logs)
    last = session.calls[-1]
    assert not last["input"][:, : SileroVad.CONTEXT].any()
    assert not last["state"].any()
    assert np.all(last["input"][0, SileroVad.CONTEXT :] == 2.0)


def test_vad_predict_and_reset(monkeypatch: pytest.MonkeyPatch) -> None:
    session = FakeSileroSession()
    driver, context = _vad_driver(monkeypatch, session)

    result = check_result(
        SpeechActivityDriver, "predict", driver.execute("predict", {"audio_buffer": [0.25] * 1024})
    )
    assert result["scores"] == pytest.approx([0.25, 0.25])
    assert result["confidence"] == pytest.approx(0.25) and result["is_speech"] is False
    assert len(context.emitted("activity")) == 2
    with pytest.raises(ValueError, match="multiple of 512"):
        driver.execute("predict", [0.0] * 600)
    assert driver.execute("reset", None) is None
    driver.execute("predict", [0.0] * 512)
    assert not session.calls[-1]["input"][:, : SileroVad.CONTEXT].any()


def test_vad_state_is_safe_across_threads() -> None:
    class SlowSession(FakeSileroSession):
        def run(self, _outputs: None, feeds: dict[str, Any]) -> list[Any]:
            time.sleep(0.0005)
            return super().run(_outputs, feeds)

    session = SlowSession()
    vad = SileroVad(session)

    def stream() -> None:
        for _ in range(40):
            vad.feed(np.zeros(300, dtype=np.float32))

    thread = threading.Thread(target=stream)
    thread.start()
    for _ in range(20):
        vad(np.ones(512, dtype=np.float32))
    thread.join()

    # Each call must see the state the previous call returned.
    states = [int(call["state"][0, 0, 0]) for call in session.calls]
    assert states == list(range(len(states)))


def _silero_path() -> Path:
    path = models_dir() / MODEL.filename
    if not path.exists():
        pytest.skip("silero_vad.onnx is not downloaded")
    return path


def test_real_silero_model_streams_like_direct_scoring(monkeypatch: pytest.MonkeyPatch) -> None:
    path = _silero_path()
    monkeypatch.setattr(vad_module, "resolve_model", lambda model, log: path)
    context = RecordingContext()
    driver = SpeechActivityDriver(context)
    driver.pre_run()
    rng = np.random.default_rng(0)
    t = np.arange(16_000 * 2) / 16_000
    # A second of near silence, then a second of a 140 Hz harmonic buzz with a 4 Hz
    # rhythm. Only the silence has a known score; the point is that buffering
    # blocks of any size gives exactly the scores of direct 512-sample windows.
    voiced = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 12))
    voiced *= 0.5 * (1 + np.sin(2 * np.pi * 4 * t)) * 0.2
    audio = np.concatenate([rng.normal(0, 0.001, 16_000), voiced]).astype(np.float32)
    usable = len(audio) // 512 * 512

    offset = 0
    for size in (1024, 700, 333, 1500):
        while offset + size <= usable:
            driver.on_data("microphone", "audio_stream", _block(audio[offset : offset + size]))
            offset += size
    streamed = [e["confidence"] for e in context.emitted("activity")]
    driver.execute("reset", None)
    direct = driver.execute("predict", audio[: len(streamed) * 512].tolist())["scores"]

    assert streamed == pytest.approx(direct, abs=1e-5)
    silence = streamed[: 16_000 // 512]
    assert max(silence) < 0.5
