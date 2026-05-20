"""Frequency-analysis driver (FFT).

Subscribes to `microphone.audio_stream` and emits an `frequency` event with:
- `max_frequency`: frequency (Hz) of the strongest bin
- `amplitude`: amplitude at the strongest bin
- `rfft`: magnitudes of bins below `max_frequency_hz` (truncated)
- `blocksize`: most recent input block size

The driver maintains a sliding buffer of N concatenated blocks (default 8)
to improve frequency resolution at low cost.
"""

from __future__ import annotations

from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor


class FrequencyAnalysisDriver(BaseProcessor):
    name: ClassVar[str] = "frequency_analysis"
    description: ClassVar[str] = "FFT-based frequency estimation on a microphone stream."
    events: ClassVar[tuple[str, ...]] = ("frequency",)
    actions: ClassVar[tuple[str, ...]] = ("set_max_frequency", "set_window_size")
    dependencies: ClassVar[tuple[str, ...]] = ("microphone",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("microphone", "audio_stream"),)
    loop_interval_s: ClassVar[float | None] = None

    MAX_FREQUENCY_HZ: ClassVar[float] = 2_100.0
    WINDOW_BLOCKS: ClassVar[int] = 8

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._buffer: list[float] = []
        self._max_frequency = float(self.MAX_FREQUENCY_HZ)
        self._window_blocks = int(self.WINDOW_BLOCKS)

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_max_frequency":
            self._max_frequency = float(data)
            return {"max_frequency": self._max_frequency}
        if action == "set_window_size":
            self._window_blocks = max(int(data), 1)
            return {"window_blocks": self._window_blocks}
        return super().execute(action, data)

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if driver != "microphone" or event != "audio_stream":
            return
        if not isinstance(data, dict):
            return
        block = data.get("block")
        if not isinstance(block, list) or not block:
            return
        samplerate = float(data.get("samplerate", 0) or 0)
        if samplerate <= 0:
            return
        # Extract the first channel from a (frames, channels) shaped block.
        if isinstance(block[0], list):
            samples = [float(row[0]) for row in block]
        else:
            samples = [float(x) for x in block]

        capacity = self._window_blocks * len(samples)
        if len(self._buffer) + len(samples) > capacity:
            overflow = len(self._buffer) + len(samples) - capacity
            del self._buffer[: max(overflow, 0)]
        self._buffer.extend(samples)

        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"numpy required: {exc}")
            return

        arr = np.asarray(self._buffer, dtype=np.float32)
        if arr.size < 4:
            return
        rfft = np.abs(np.fft.rfft(arr))
        freq = np.fft.rfftfreq(arr.size, 1.0 / samplerate)
        mask = freq < self._max_frequency
        if not mask.any():
            return
        rfft_masked = rfft[mask]
        peak_idx = int(np.argmax(rfft))
        self.emit(
            "frequency",
            {
                "max_frequency": float(freq[peak_idx]),
                "amplitude": float(rfft.max()),
                "rfft": [float(x) for x in rfft_masked.tolist()],
                "blocksize": len(samples),
                "samplerate": int(samplerate),
            },
        )
