"""Voice Activity Detection driver (Silero VAD).

Lazily loads Silero VAD via `torch.hub` on first invocation, then exposes a
`predict` action that scores a 16 kHz mono float32 audio block. The score is
emitted as `activity` events. Apps can subscribe to the event stream OR call
`predict` synchronously for offline use.

The driver also auto-classifies live `microphone.audio_stream` frames if the
mic samplerate is 16 kHz; if not, it logs a one-shot warning telling the app
to resample first.
"""

from __future__ import annotations

import time
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor


class SpeechActivityDriver(BaseProcessor):
    name: ClassVar[str] = "speech_activity_detection"
    description: ClassVar[str] = "Silero-VAD voice activity detection."
    events: ClassVar[tuple[str, ...]] = ("activity",)
    actions: ClassVar[tuple[str, ...]] = ("predict",)
    dependencies: ClassVar[tuple[str, ...]] = ("microphone",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("microphone", "audio_stream"),)
    loop_interval_s: ClassVar[float | None] = None

    SAMPLE_RATE: ClassVar[int] = 16_000

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._model: Any = None
        self._warned_samplerate = False

    def pre_run(self) -> None:
        super().pre_run()
        self._load_model()

    def execute(self, action: str, data: Any) -> Any:
        if action == "predict":
            if isinstance(data, dict):
                buffer = data.get("audio_buffer") or data.get("block")
            else:
                buffer = data
            return self._predict(buffer)
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._model is None or not isinstance(data, dict):
            return
        samplerate = int(data.get("samplerate", 0) or 0)
        if samplerate != self.SAMPLE_RATE:
            if not self._warned_samplerate:
                self.log(
                    "warn",
                    f"VAD needs {self.SAMPLE_RATE} Hz audio, got {samplerate} Hz - skipping",
                )
                self._warned_samplerate = True
            return
        block = data.get("block")
        if not isinstance(block, list):
            return
        if isinstance(block[0], list):
            mono = [float(row[0]) for row in block]
        else:
            mono = [float(x) for x in block]
        self._predict(mono)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _load_model(self) -> None:
        try:
            import torch  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"torch required for VAD: {exc}")
            return
        try:
            model, _ = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
        except Exception as exc:
            self.log("error", f"failed to load Silero VAD: {exc!r}")
            return
        self._model = model
        self.log("info", "Silero VAD loaded")

    def _predict(self, audio: Any) -> dict[str, Any]:
        if self._model is None:
            return {"ok": False, "error": "model not loaded"}
        try:
            import numpy as np  # type: ignore[import-not-found]
            import torch  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"torch/numpy required: {exc}"}
        if audio is None:
            return {"ok": False, "error": "audio buffer is None"}
        arr = np.asarray(audio, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr[:, 0]
        tensor = torch.from_numpy(arr)
        score = float(self._model(tensor, self.SAMPLE_RATE).item())
        payload = {"confidence": score, "is_speech": score > 0.5, "ts": time.time()}
        self.emit("activity", payload)
        return {"ok": True, **payload}
