"""Voice Activity Detection driver (Silero VAD).

Runs the Silero VAD ONNX model with ONNX Runtime on CPU, one thread, as Silero
recommends. The model is downloaded on first use. A `predict` action scores a
512-sample, 16 kHz mono float32 audio block, keeping the model's recurrent
state across calls. The score is emitted as `activity` events. Apps can
subscribe to the event stream OR call `predict` synchronously for offline use.

The driver also auto-classifies live `microphone.audio_stream` frames if the
mic samplerate is 16 kHz; if not, it logs a one-shot warning telling the app
to resample first.
"""

from __future__ import annotations

import time
from typing import Any, ClassVar

import numpy as np

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor
from gosai_py.runtime import RuntimeInfo
from gosai_py.runtime.models import Model, resolve_model

MODEL = Model.download(
    "silero_vad.onnx",
    url=(
        "https://raw.githubusercontent.com/snakers4/silero-vad/"
        "v6.2.1/src/silero_vad/data/silero_vad.onnx"
    ),
    sha256="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
)


class SileroVad:
    """Stateful Silero VAD v5+ over ONNX Runtime, matching Silero's own OnnxWrapper."""

    SAMPLE_RATE: ClassVar[int] = 16_000
    CHUNK: ClassVar[int] = 512
    CONTEXT: ClassVar[int] = 64

    def __init__(self, session: Any) -> None:
        self._session = session
        self._sr = np.array(self.SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, self.CONTEXT), dtype=np.float32)

    def __call__(self, chunk: Any) -> float:
        samples = np.asarray(chunk, dtype=np.float32).reshape(1, -1)
        if samples.shape[1] != self.CHUNK:
            raise ValueError(
                f"Silero VAD needs {self.CHUNK} samples at {self.SAMPLE_RATE} Hz, "
                f"got {samples.shape[1]}"
            )
        x = np.concatenate([self._context, samples], axis=1)
        out, self._state = self._session.run(
            None, {"input": x, "state": self._state, "sr": self._sr}
        )
        self._context = x[:, -self.CONTEXT :]
        return float(out[0, 0])


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
        self._model: SileroVad | None = None
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
        import onnxruntime as ort

        model_path = resolve_model(MODEL, self.log)
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        session = ort.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._model = SileroVad(session)
        self.set_runtime_info(
            RuntimeInfo(
                backend="onnxruntime",
                provider="CPUExecutionProvider",
                device="cpu",
                model=MODEL.filename,
                accelerated=False,
                reason="Silero VAD is built for single-threaded CPU inference",
            )
        )
        self.log("info", "Silero VAD loaded")

    def _predict(self, audio: Any) -> dict[str, Any]:
        if self._model is None:
            return {"ok": False, "error": "model not loaded"}
        if audio is None:
            return {"ok": False, "error": "audio buffer is None"}
        arr = np.asarray(audio, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr[:, 0]
        score = self._model(arr)
        payload = {"confidence": score, "is_speech": score > 0.5, "ts": time.time()}
        self.emit("activity", payload)
        return {"ok": True, **payload}
