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

import time
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.runtime import accelerator_mode, runtime_info


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
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except ImportError as exc:
            raise RuntimeError(f"faster-whisper required: {exc}") from exc
        try:
            import torch  # type: ignore[import-not-found]
            self._device, reason = self._select_device(torch)
        except ImportError as exc:
            if accelerator_mode() == "cuda":
                raise RuntimeError("torch is required to verify CUDA for faster-whisper") from exc
            self._device, reason = "cpu", f"torch unavailable for accelerator detection: {exc}"
        self._compute_type = "float16" if self._device == "cuda" else "int8"
        try:
            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
        except Exception as exc:
            self.log("error", f"failed to load whisper model {self._model_size}: {exc!r}")
            raise
        self.set_runtime_info(
            runtime_info(
                backend="faster-whisper",
                provider="CTranslate2",
                device=self._device,
                model=self._model_size,
                accelerated=self._device == "cuda",
                reason=reason,
            )
        )
        self.log("info", f"whisper model loaded: {self._model_size} on {self._device}")

    def _select_device(self, torch: Any) -> tuple[str, str | None]:
        mode = accelerator_mode()
        if mode == "cpu":
            return "cpu", "CPU explicitly requested"
        if mode == "cuda":
            if torch.cuda.is_available():
                return "cuda", None
            raise RuntimeError("CUDA requested for faster-whisper but torch.cuda is unavailable")
        if mode == "auto" and torch.cuda.is_available():
            return "cuda", None
        if mode == "coreml":
            return "cpu", "faster-whisper/CTranslate2 has no CoreML backend in this runtime"
        return "cpu", "no supported faster-whisper accelerator available"

    def _transcribe(self, audio: Any) -> dict[str, Any]:
        if self._model is None:
            return {"ok": False, "error": "model not loaded"}
        if audio is None:
            return {"ok": False, "error": "audio buffer is None"}
        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"numpy required: {exc}"}
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
