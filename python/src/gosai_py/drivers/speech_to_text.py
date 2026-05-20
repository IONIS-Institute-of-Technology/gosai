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
            self.log("error", f"faster-whisper required: {exc}")
            return
        try:
            import torch  # type: ignore[import-not-found]
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            self._device = "cpu"
        try:
            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type="int8",
            )
        except Exception as exc:
            self.log("error", f"failed to load whisper model {self._model_size}: {exc!r}")
            return
        self.log("info", f"whisper model loaded: {self._model_size} on {self._device}")

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
