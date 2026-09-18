"""Voice Activity Detection driver (Silero VAD).

Runs the Silero VAD ONNX model with ONNX Runtime on CPU, one thread, as Silero
recommends. The model is downloaded on first use and keeps recurrent state
across windows of 512 samples at 16 kHz.

Live `microphone.audio_stream` blocks of any size are buffered and scored one
512-sample window at a time; the leftover waits for the next block. Each score
is emitted as `activity`. Audio at another sample rate is skipped with a
warning. `predict` scores audio directly, for offline use, and `reset` clears
the model state and the buffer.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from typing import Any, ClassVar

import msgspec
import numpy as np
import onnxruntime as ort

from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.payloads import AudioSamples, Ok, mono_samples
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
SPEECH_THRESHOLD = 0.5


class SileroVad:
    """Stateful Silero VAD v5+ over ONNX Runtime, matching Silero's own OnnxWrapper.

    Thread-safe: the bridge thread (`predict`) and the subscription worker
    share the recurrent state.
    """

    SAMPLE_RATE: ClassVar[int] = 16_000
    CHUNK: ClassVar[int] = 512
    CONTEXT: ClassVar[int] = 64

    def __init__(self, session: Any) -> None:
        self._session = session
        self._sr = np.array(self.SAMPLE_RATE, dtype=np.int64)
        self._lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self._state = np.zeros((2, 1, 128), dtype=np.float32)
            self._context = np.zeros((1, self.CONTEXT), dtype=np.float32)
            self._pending = np.empty(0, dtype=np.float32)

    def __call__(self, chunk: Any) -> float:
        """Score exactly one 512-sample window."""
        samples = np.asarray(chunk, dtype=np.float32).reshape(1, -1)
        if samples.shape[1] != self.CHUNK:
            raise ValueError(
                f"Silero VAD needs {self.CHUNK} samples at {self.SAMPLE_RATE} Hz, "
                f"got {samples.shape[1]}"
            )
        with self._lock:
            return self._score(samples)

    def feed(self, samples: np.ndarray) -> list[float]:
        """Score every complete window in the buffered stream, keeping the leftover."""
        with self._lock:
            pending = np.concatenate([self._pending, np.asarray(samples, dtype=np.float32)])
            complete = len(pending) // self.CHUNK * self.CHUNK
            self._pending = pending[complete:]
            return [
                self._score(pending[start : start + self.CHUNK].reshape(1, -1))
                for start in range(0, complete, self.CHUNK)
            ]

    def _score(self, window: np.ndarray) -> float:
        x = np.concatenate([self._context, window], axis=1)
        out, self._state = self._session.run(
            None, {"input": x, "state": self._state, "sr": self._sr}
        )
        self._context = x[:, -self.CONTEXT :]
        return float(out[0, 0])


class ActivityPayload(msgspec.Struct, kw_only=True):
    confidence: float
    is_speech: bool
    ts: float


class PredictParams(msgspec.Struct, kw_only=True):
    audio_buffer: AudioSamples | None = None
    block: AudioSamples | None = None


class PredictResult(ActivityPayload, kw_only=True):
    ok: bool = True
    # One score per 512-sample window; `confidence` is the last.
    scores: list[float]


class SpeechActivityDriver(BaseDriver):
    name = "speech_activity_detection"
    description = "Silero-VAD voice activity detection."
    events: ClassVar[Mapping[str, Event]] = {
        "activity": Event(ActivityPayload, "Speech probability of one 512-sample window."),
    }
    dependencies = ("microphone",)
    subscribed = (("microphone", "audio_stream"),)
    # Silero keeps state across chunks and needs contiguous audio.
    subscription_queue_size = 64
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._model: SileroVad | None = None
        self._samplerate: int | None = None

    def pre_run(self) -> None:
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

    @action("Score 16 kHz mono audio whose length is a multiple of 512 samples.")
    def predict(self, params: PredictParams | AudioSamples) -> PredictResult:
        model = self._require_model()
        if isinstance(params, PredictParams):
            audio = params.audio_buffer or params.block
            if audio is None:
                raise ValueError("predict needs audio_buffer or block")
        else:
            audio = params
        samples = mono_samples(audio)
        if not len(samples) or len(samples) % SileroVad.CHUNK:
            raise ValueError(
                f"predict needs a positive multiple of {SileroVad.CHUNK} samples, got {len(samples)}"
            )
        scores = [model(window) for window in samples.reshape(-1, SileroVad.CHUNK)]
        payload = {}
        for score in scores:
            payload = self._emit_score(score)
        return PredictResult(**payload, scores=scores)

    @action("Clear the model state and the buffered stream.")
    def reset(self) -> Ok:
        self._require_model().reset()
        return Ok()

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if self._model is None or not isinstance(data, dict):
            return
        samplerate = int(data.get("samplerate") or 0)
        if samplerate != self._samplerate:
            self._model.reset()
            if samplerate != SileroVad.SAMPLE_RATE:
                self.log(
                    "warn",
                    f"VAD needs {SileroVad.SAMPLE_RATE} Hz audio, got {samplerate} Hz - skipping",
                )
            self._samplerate = samplerate
        if samplerate != SileroVad.SAMPLE_RATE:
            return
        block = data.get("_block")
        if block is None:
            block = np.asarray(data.get("block") or [], dtype=np.float32)
        for score in self._model.feed(block[:, 0] if block.ndim > 1 else block):
            self._emit_score(score)

    def _emit_score(self, score: float) -> dict[str, Any]:
        payload = {"confidence": score, "is_speech": score > SPEECH_THRESHOLD, "ts": time.time()}
        self.emit("activity", payload)
        return payload

    def _require_model(self) -> SileroVad:
        if self._model is None:
            raise RuntimeError("model not loaded")
        return self._model
