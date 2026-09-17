"""Frequency-analysis driver (FFT).

Subscribes to `microphone.audio_stream` and keeps the last `window_blocks`
blocks of the first channel. For each block it removes the DC offset, applies
a Hann window and emits the spectrum below `max_frequency` with its peak.

Magnitudes are unnormalised FFT magnitudes, rescaled by `N / sum(window)` so
the window doesn't shrink them: a sine of amplitude A filling the N-sample
window peaks near `A * N / 2`, as it did before the window was added.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, ClassVar

import msgspec
import numpy as np
from msgspec import Meta

from gosai_py.driver import BaseDriver, DriverContext, Event, action

MAX_FREQUENCY_HZ = 2_100.0
WINDOW_BLOCKS = 8


class FrequencyPayload(msgspec.Struct, kw_only=True):
    # Frequency (Hz) of the strongest bin below the cutoff.
    max_frequency: float
    amplitude: float
    # Magnitudes of the bins below the cutoff, from 0 Hz.
    rfft: list[float]
    blocksize: int
    samplerate: int


class MaxFrequencyResult(msgspec.Struct, kw_only=True):
    max_frequency: float


class WindowSizeResult(msgspec.Struct, kw_only=True):
    window_blocks: int


def spectrum(samples: np.ndarray, samplerate: float, max_frequency: float) -> tuple[np.ndarray, np.ndarray]:
    """Frequencies and magnitudes below `max_frequency`, after DC removal and a Hann window."""
    centered = samples - samples.mean()
    window = np.hanning(len(centered))
    magnitudes = np.abs(np.fft.rfft(centered * window)) * (len(window) / window.sum())
    frequencies = np.fft.rfftfreq(len(centered), 1.0 / samplerate)
    below = frequencies < max_frequency
    return frequencies[below], magnitudes[below]


class FrequencyAnalysisDriver(BaseDriver):
    name = "frequency_analysis"
    description = "FFT-based frequency estimation on a microphone stream."
    events: ClassVar[Mapping[str, Event]] = {
        "frequency": Event(FrequencyPayload, "Spectrum of the latest window, once per block."),
    }
    stream_events = ("frequency",)
    dependencies = ("microphone",)
    subscribed = (("microphone", "audio_stream"),)
    # The FFT window is built from consecutive blocks, so none may be skipped.
    subscription_queue_size = 64
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._buffer = np.empty(0, dtype=np.float32)
        self._samplerate = 0
        self._max_frequency = MAX_FREQUENCY_HZ
        self._window_blocks = WINDOW_BLOCKS

    @action("Only report bins below this frequency (Hz).")
    def set_max_frequency(self, hz: Annotated[float, Meta(gt=0)]) -> MaxFrequencyResult:
        self._max_frequency = hz
        return MaxFrequencyResult(max_frequency=hz)

    @action("Analyse this many consecutive blocks at once (at least 1).")
    def set_window_size(self, blocks: int) -> WindowSizeResult:
        self._window_blocks = max(blocks, 1)
        return WindowSizeResult(window_blocks=self._window_blocks)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        block = data.get("_block")
        if block is None:
            block = np.asarray(data.get("block") or [], dtype=np.float32)
        samplerate = int(data.get("samplerate") or 0)
        if block.size == 0 or samplerate <= 0:
            return
        samples = block[:, 0] if block.ndim > 1 else block
        if samplerate != self._samplerate:
            self._samplerate = samplerate
            self._buffer = np.empty(0, dtype=np.float32)
        capacity = self._window_blocks * len(samples)
        self._buffer = np.concatenate([self._buffer, samples])[-capacity:]
        if len(self._buffer) < 4:
            return

        frequencies, magnitudes = spectrum(self._buffer, samplerate, self._max_frequency)
        if not len(magnitudes):
            return
        peak = int(np.argmax(magnitudes))
        self.emit(
            "frequency",
            {
                "max_frequency": float(frequencies[peak]),
                "amplitude": float(magnitudes[peak]),
                "rfft": magnitudes.tolist(),
                "blocksize": len(samples),
                "samplerate": samplerate,
            },
        )
