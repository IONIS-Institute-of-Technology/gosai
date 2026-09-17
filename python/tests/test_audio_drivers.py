"""microphone, speaker, frequency_analysis and speech_to_text with sounddevice and models faked."""

from __future__ import annotations

import sys
import threading
from collections.abc import Iterator
from types import ModuleType, SimpleNamespace
from typing import Any

import numpy as np
import pytest

from fakes import FakeSoundDevice, RecordingContext, check_events, check_result, wait_until
from gosai_py import devices
from gosai_py.drivers.frequency_analysis import FrequencyAnalysisDriver
from gosai_py.drivers.microphone import MicrophoneDriver
from gosai_py.drivers.speaker import SpeakerDriver
from gosai_py.drivers.speech_to_text import SpeechToTextDriver


@pytest.fixture
def sd(monkeypatch: pytest.MonkeyPatch) -> FakeSoundDevice:
    fake = FakeSoundDevice()
    monkeypatch.setattr(devices, "sounddevice", lambda: fake)
    return fake


@pytest.fixture
def microphone(sd: FakeSoundDevice) -> Iterator[tuple[MicrophoneDriver, RecordingContext]]:
    context = RecordingContext()
    driver = MicrophoneDriver(context)
    driver.apply_config({"device": 1, "samplerate": None})
    driver._bridge_start()
    try:
        yield driver, context
    finally:
        assert driver._bridge_stop(5.0)


def test_microphone_callback_only_hands_blocks_to_a_worker(
    microphone: tuple[MicrophoneDriver, RecordingContext], sd: FakeSoundDevice
) -> None:
    _, context = microphone
    stream = sd.streams[-1]
    assert stream.kwargs["samplerate"] == 16_000 and stream.kwargs["device"] == 1
    emitters: list[str] = []
    original_emit = context.emit

    def emit(event: str, data: Any) -> None:
        emitters.append(threading.current_thread().name)
        original_emit(event, data)

    context.emit = emit  # type: ignore[method-assign]
    block = np.linspace(-1, 1, 1024, dtype=np.float32).reshape(-1, 1)
    for _ in range(3):
        stream.callback(block, 1024, None, None)

    wait_until(lambda: len(context.emitted("audio_stream")) == 3)
    payload = context.emitted("audio_stream")[0]
    assert payload["block"][0] == [-1.0] and payload["blocksize"] == 1024
    assert payload["_block"].shape == (1024, 1)
    assert set(emitters) == {"driver:microphone:blocks"}
    check_events(MicrophoneDriver, context)


def test_microphone_reopens_and_lists_devices(
    microphone: tuple[MicrophoneDriver, RecordingContext], sd: FakeSoundDevice
) -> None:
    driver, context = microphone

    assert driver.execute("set_samplerate", 48_000) == {"samplerate": 48_000}
    assert sd.streams[0].closed and sd.streams[-1].kwargs["samplerate"] == 48_000
    assert context.emitted("settings")[-1]["samplerate"] == 48_000

    sd.fail = True
    with pytest.raises(RuntimeError, match="cannot open microphone"):
        driver.execute("set_device", 4)
    sd.fail = False

    listing = check_result(MicrophoneDriver, "list_devices", driver.execute("list_devices", None))
    assert listing == {
        "ok": True,
        "default_input": 1,
        "devices": [{"index": 1, "name": "Mic", "max_input_channels": 1, "default_samplerate": 16000.0}],
    }


def test_microphone_start_fails_when_the_stream_does_not_open(sd: FakeSoundDevice) -> None:
    sd.fail = True
    driver = MicrophoneDriver(RecordingContext())
    with pytest.raises(RuntimeError, match="cannot open microphone"):
        driver._bridge_start()


def _speaker(sd: FakeSoundDevice) -> tuple[SpeakerDriver, RecordingContext]:
    context = RecordingContext()
    driver = SpeakerDriver(context)
    driver._bridge_start()
    return driver, context


def test_speaker_plays_queued_samples_across_blocks(sd: FakeSoundDevice) -> None:
    driver, context = _speaker(sd)
    try:
        callback = sd.streams[-1].callback
        result = check_result(SpeakerDriver, "play", driver.execute("play", [0.5] * 1500))
        assert result == {"ok": True, "queued": 2, "queued_samples": 1500}
        driver.execute("play", [[0.25, 1.0]] * 100)

        out = np.ones((1024, 1), dtype=np.float32)
        callback(out, 1024, None, SimpleNamespace(output_underflow=False))
        assert (out == 0.5).all()
        callback(out, 1024, None, SimpleNamespace(output_underflow=True))
        assert (out[:476] == 0.5).all() and (out[476:576] == 0.25).all() and (out[576:] == 0).all()

        assert driver.execute("play", [0.1] * 10)["queued_samples"] == 10
        assert driver.execute("clear", None) == {"ok": True}
        callback(out, 1024, None, SimpleNamespace(output_underflow=False))
        assert not out.any()
        assert context.emitted("underrun")
        check_events(SpeakerDriver, context)
    finally:
        assert driver._bridge_stop(5.0)


def test_speaker_instances_have_their_own_queues(sd: FakeSoundDevice) -> None:
    first, _ = _speaker(sd)
    second, _ = _speaker(sd)
    try:
        first.execute("play", [0.5] * 2048)
        assert second.execute("play", None)["queued_samples"] == 0
        second.execute("clear", None)
        assert first.execute("play", None)["queued_samples"] == 2048
    finally:
        assert first._bridge_stop(5.0) and second._bridge_stop(5.0)


def test_speaker_start_fails_when_the_stream_does_not_open(sd: FakeSoundDevice) -> None:
    sd.fail = True
    with pytest.raises(RuntimeError, match="cannot open speaker"):
        SpeakerDriver(RecordingContext())._bridge_start()


def test_audio_device_listing(sd: FakeSoundDevice) -> None:
    listing = devices.audio_devices()
    assert (listing.default_input, listing.default_output) == (1, None)
    assert [d.name for d in listing.devices] == ["Speakers", "Mic"]


def _audio(samplerate: int, seconds: float, *tones: tuple[float, float]) -> np.ndarray:
    t = np.arange(int(samplerate * seconds)) / samplerate
    signal = np.full(len(t), 0.3)
    for hz, amp in tones:
        signal += amp * np.sin(2 * np.pi * hz * t)
    return signal.astype(np.float32)


def test_frequency_analysis_finds_the_peak_below_the_cutoff() -> None:
    context = RecordingContext()
    driver = FrequencyAnalysisDriver(context)
    # A strong 3 kHz tone above the 2.1 kHz cutoff and a DC offset must not win.
    audio = _audio(16_000, 1.0, (440.0, 0.2), (3000.0, 0.6))
    for block in audio[: 1024 * 8].reshape(8, 1024):
        driver.on_data("microphone", "audio_stream", {"_block": block.reshape(-1, 1), "samplerate": 16_000})

    payload = context.emitted("frequency")[-1]
    assert payload["max_frequency"] == pytest.approx(440.0, abs=16_000 / 8192)
    assert len(payload["rfft"]) == int(np.ceil(2100 / (16_000 / 8192)))
    check_events(FrequencyAnalysisDriver, context)

    assert driver.execute("set_max_frequency", 4000) == {"max_frequency": 4000.0}
    driver.on_data("microphone", "audio_stream", {"block": audio[:1024].reshape(-1, 1).tolist(), "samplerate": 16_000})
    assert context.emitted("frequency")[-1]["max_frequency"] == pytest.approx(3000.0, abs=2.0)
    assert driver.execute("set_window_size", 0) == {"window_blocks": 1}


class _Segment(SimpleNamespace):
    text: str


@pytest.fixture
def whisper(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    loads: list[dict[str, Any]] = []

    class WhisperModel:
        def __init__(self, size: str, **kwargs: Any) -> None:
            loads.append({"size": size, **kwargs})

        def transcribe(self, audio: np.ndarray, beam_size: int) -> tuple[list[_Segment], None]:
            return [_Segment(text=f"{len(audio)} samples"), _Segment(text=".")], None

    faster_whisper = ModuleType("faster_whisper")
    faster_whisper.WhisperModel = WhisperModel  # type: ignore[attr-defined]
    ctranslate2 = ModuleType("ctranslate2")
    ctranslate2.get_cuda_device_count = lambda: 0  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", faster_whisper)
    monkeypatch.setitem(sys.modules, "ctranslate2", ctranslate2)
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    return loads


def test_speech_to_text_transcribes_buffers(whisper: list[dict[str, Any]]) -> None:
    context = RecordingContext()
    driver = SpeechToTextDriver(context)
    driver.pre_run()

    result = check_result(SpeechToTextDriver, "transcribe", driver.execute("transcribe", {"audio_buffer": [0.0] * 8000}))
    assert result["transcription"] == "8000 samples."
    assert result["audio_duration_s"] == 0.5
    assert driver.execute("transcribe", [[0.0, 1.0]] * 160)["transcription"] == "160 samples."
    with pytest.raises(ValueError, match="needs audio_buffer"):
        driver.execute("transcribe", {})
    assert driver.execute("set_model", "small.en") == {"model": "small.en", "ok": True}
    assert [load["size"] for load in whisper] == ["medium.en", "small.en"]
    assert whisper[0]["device"] == "cpu" and whisper[0]["compute_type"] == "int8"
    check_events(SpeechToTextDriver, context)


def test_speech_to_text_explains_the_missing_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    with pytest.raises(RuntimeError, match="speech extra"):
        SpeechToTextDriver(RecordingContext()).pre_run()
