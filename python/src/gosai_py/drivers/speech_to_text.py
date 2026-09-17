"""Speech-to-text driver (faster-whisper).

Exposes a `transcribe` action that takes a 16 kHz mono float32 buffer and
returns the recognized text via the `transcription` event. Apps decide when
to call `transcribe` (typically after VAD flags end-of-utterance).

This driver does NOT auto-subscribe to the microphone because doing inference
per-block would be wasteful. The expected pattern is:

1. App subscribes to `microphone.audio_stream` and accumulates samples.
2. App subscribes to `speech_activity_detection.activity` to know when to
   transcribe.
3. App calls `driver.execute('speech_to_text', 'transcribe', { audio_buffer })`.
"""

from __future__ import annotations

import ctypes
import sys
import time
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext
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


class SpeechToTextDriver(BaseDriver):
    name: ClassVar[str] = "speech_to_text"
    description: ClassVar[str] = "Speech-to-text via faster-whisper."
    events: ClassVar[tuple[str, ...]] = ("transcription",)
    actions: ClassVar[tuple[str, ...]] = ("transcribe", "set_model")
    loop_interval_s: ClassVar[float | None] = None  # callback driven

    DEFAULT_MODEL_SIZE: ClassVar[str] = "medium.en"
    SAMPLE_RATE: ClassVar[int] = 16_000

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._model: Any = None
        self._model_size = self.DEFAULT_MODEL_SIZE
        self._device = "cpu"
        self._compute_type = "int8"

    def pre_run(self) -> None:
        self._load_model()

    def execute(self, action: str, data: Any) -> Any:
        if action == "transcribe":
            if isinstance(data, dict):
                buffer = data.get("audio_buffer") or data.get("samples")
            else:
                buffer = data
            return self._transcribe(buffer)
        if action == "set_model":
            self._model_size = str(data)
            self._model = None
            self._load_model()
            return {"model": self._model_size, "ok": self._model is not None}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _load_model(self) -> None:
        try:
            import ctranslate2  # type: ignore[import-not-found]
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(f"faster-whisper required: {exc}") from exc
        config = AcceleratorConfig.from_env()
        cuda_devices = ctranslate2.get_cuda_device_count()
        self._device, reason = select_device(
            config, cuda_devices, cuda_devices > 0 and cublas_12_loadable()
        )
        if reason is not None:
            self.log("info", f"faster-whisper runs on CPU: {reason}")
        self._compute_type = "float16" if self._device == "cuda" else "int8"
        try:
            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                device_index=config.cuda_device_id if self._device == "cuda" else 0,
                compute_type=self._compute_type,
            )
        except Exception as exc:
            self.log("error", f"failed to load whisper model {self._model_size}: {exc!r}")
            raise
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

    def _transcribe(self, audio: Any) -> dict[str, Any]:
        if self._model is None:
            raise RuntimeError("model not loaded")
        if audio is None:
            raise ValueError("audio buffer is None")
        import numpy as np  # type: ignore[import-not-found]

        arr = np.asarray(audio, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr[:, 0]

        start = time.time()
        segments, _info = self._model.transcribe(arr, beam_size=5)
        text = "".join(s.text for s in segments)
        elapsed = time.time() - start

        payload = {
            "transcription": text,
            "audio_duration_s": float(arr.shape[0]) / self.SAMPLE_RATE,
            "transcription_duration_s": elapsed,
            "ts": time.time(),
        }
        self.emit("transcription", payload)
        return {"ok": True, **payload}
