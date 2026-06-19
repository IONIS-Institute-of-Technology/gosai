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
from gosai_py.runtime import accelerator_mode, runtime_info


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
        self._device = "cpu"
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
            raise RuntimeError(f"torch required for VAD: {exc}") from exc
        self._device, reason = self._select_device(torch)
        try:
            model, _ = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
            if hasattr(model, "to"):
                model = model.to(self._device)
        except Exception as exc:
            self.log("error", f"failed to load Silero VAD: {exc!r}")
            raise
        self._model = model
        self.set_runtime_info(
            runtime_info(
                backend="torch",
                provider="Silero VAD",
                device=self._device,
                model="silero_vad",
                accelerated=self._device in {"cuda", "mps"},
                reason=reason,
            )
        )
        self.log("info", f"Silero VAD loaded on {self._device}")

    def _select_device(self, torch: Any) -> tuple[str, str | None]:
        mode = accelerator_mode()
        if mode == "cpu":
            return "cpu", "CPU explicitly requested"
        if mode == "cuda":
            if torch.cuda.is_available():
                return "cuda", None
            raise RuntimeError("CUDA requested for VAD but torch.cuda is unavailable")
        if mode in {"auto", "coreml"}:
            if torch.cuda.is_available():
                return "cuda", None
            mps = getattr(getattr(torch, "backends", None), "mps", None)
            if mps is not None and mps.is_available():
                return "mps", None
        if mode == "coreml":
            return "cpu", "Torch MPS backend unavailable for VAD"
        return "cpu", "no supported Torch accelerator available"

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
        tensor = torch.from_numpy(arr).to(self._device)
        score = float(self._model(tensor, self.SAMPLE_RATE).item())
        payload = {"confidence": score, "is_speech": score > 0.5, "ts": time.time()}
        self.emit("activity", payload)
        return {"ok": True, **payload}
