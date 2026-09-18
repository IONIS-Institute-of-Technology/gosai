"""Speech-to-text driver (faster-whisper).

`transcribe` takes a 16 kHz mono float32 buffer, returns the text and emits
it as `transcription`. The driver doesn't subscribe to the microphone, since
transcribing every block would be wasteful. Apps usually buffer
`microphone.audio_stream`, watch `speech_activity_detection.activity` for the
end of an utterance, then call `transcribe`.

faster-whisper and CTranslate2 come with the `speech` extra, so they load when
the driver starts.
"""

from __future__ import annotations

import ctypes
import sys
import time
from collections.abc import Mapping
from typing import Any, ClassVar

import msgspec

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.payloads import AudioSamples, EpochMs, mono_samples
from gosai_py.runtime import AcceleratorConfig, RuntimeInfo

# CTranslate2 4.x is built against CUDA 12. The gpu extra's onnxruntime-gpu
# brings CUDA 13 libraries, which don't satisfy it.
CUBLAS_12 = "cublas64_12.dll" if sys.platform == "win32" else "libcublas.so.12"


def cublas_12_loadable() -> bool:
    try:
        ctypes.CDLL(CUBLAS_12)
    except OSError:
        return False
    return True


def select_device(
    config: AcceleratorConfig, cuda_devices: int, cublas_12: bool
) -> tuple[str, str | None]:
    """Pick the CTranslate2 device and, when it is the CPU, say why.

    ``cuda_devices`` only needs the NVIDIA driver, so CUDA also needs
    ``cublas_12``: whether the CUDA 12 cuBLAS library loads.
    """
    if config.mode == "cpu":
        return "cpu", "CPU explicitly requested"
    has_device = cuda_devices > config.cuda_device_id
    if config.mode in ("auto", "cuda", "tensorrt") and has_device and cublas_12:
        return "cuda", None
    if config.mode == "cuda":
        if not has_device:
            raise RuntimeError(
                f"CUDA device {config.cuda_device_id} requested for faster-whisper, "
                f"but CTranslate2 found {cuda_devices} CUDA devices"
            )
        raise RuntimeError(
            f"CUDA requested for faster-whisper, but {CUBLAS_12} (cuBLAS for CUDA 12) "
            "doesn't load. Install the CUDA 12 cuBLAS and cuDNN 9 libraries."
        )
    if config.mode in ("auto", "tensorrt") and has_device:
        return "cpu", f"{CUBLAS_12} (cuBLAS for CUDA 12, needed by CTranslate2) doesn't load"
    if config.mode in ("coreml", "dml"):
        return "cpu", f"CTranslate2 has no {config.mode} backend"
    return "cpu", "CTranslate2 found no CUDA device"


class TranscriptionPayload(msgspec.Struct, kw_only=True):
    transcription: str
    audio_duration_s: float
    transcription_duration_s: float
    ts: EpochMs


class TranscribeParams(msgspec.Struct, kw_only=True):
    audio_buffer: AudioSamples | None = None
    samples: AudioSamples | None = None


class TranscribeResult(TranscriptionPayload, kw_only=True):
    ok: bool = True


class ModelResult(msgspec.Struct, kw_only=True):
    model: str
    ok: bool


class SpeechToTextDriver(BaseDriver):
    name = "speech_to_text"
    description = "Speech-to-text via faster-whisper."
    events: ClassVar[Mapping[str, Event]] = {
        "transcription": Event(TranscriptionPayload, "Text of each transcribed buffer."),
    }
    loop_interval_s = None

    DEFAULT_MODEL_SIZE: ClassVar[str] = "medium.en"
    SAMPLE_RATE: ClassVar[int] = 16_000

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._model: Any = None
        self._model_size = self.DEFAULT_MODEL_SIZE
        self._device = "cpu"

    def pre_run(self) -> None:
        self._load_model()

    @action("Transcribe 16 kHz mono audio: a sample list, or {audio_buffer} / {samples}.")
    def transcribe(self, params: TranscribeParams | AudioSamples) -> TranscribeResult:
        if self._model is None:
            raise RuntimeError("model not loaded")
        if isinstance(params, TranscribeParams):
            audio = params.audio_buffer or params.samples
            if audio is None:
                raise ValueError("transcribe needs audio_buffer or samples")
        else:
            audio = params
        samples = mono_samples(audio)
        start = time.perf_counter()
        segments, _info = self._model.transcribe(samples, beam_size=5)
        text = "".join(segment.text for segment in segments)
        payload = {
            "transcription": text,
            "audio_duration_s": len(samples) / self.SAMPLE_RATE,
            "transcription_duration_s": time.perf_counter() - start,
            "ts": now_ms(),
        }
        self.emit("transcription", payload)
        return TranscribeResult(**payload)

    @action("Load another Whisper model, such as `small.en` or `large-v3`.")
    def set_model(self, model: str) -> ModelResult:
        self._model_size = model
        self._model = None
        self._load_model()
        return ModelResult(model=self._model_size, ok=self._model is not None)

    def _load_model(self) -> None:
        try:
            import ctranslate2  # pyright: ignore[reportMissingImports]
            from faster_whisper import WhisperModel  # pyright: ignore[reportMissingImports]
        except ImportError as exc:
            raise RuntimeError(
                f"speech_to_text needs the speech extra (uv sync --extra speech): {exc}"
            ) from exc
        config = AcceleratorConfig.from_env()
        cuda_devices = ctranslate2.get_cuda_device_count()
        self._device, reason = select_device(
            config, cuda_devices, cuda_devices > 0 and cublas_12_loadable()
        )
        if reason is not None:
            self.log("info", f"faster-whisper runs on CPU: {reason}")
        compute_type = "float16" if self._device == "cuda" else "int8"
        self._model = WhisperModel(
            self._model_size,
            device=self._device,
            device_index=config.cuda_device_id if self._device == "cuda" else 0,
            compute_type=compute_type,
        )
        info = RuntimeInfo(
            backend="faster-whisper",
            provider="CTranslate2",
            device=self._device,
            model=self._model_size,
            accelerated=self._device == "cuda",
        )
        if self._device == "cuda":
            info["device_id"] = config.cuda_device_id
        if reason is not None:
            info["reason"] = reason
        self.set_runtime_info(info)
        self.log("info", f"whisper model loaded: {self._model_size} on {self._device}")
