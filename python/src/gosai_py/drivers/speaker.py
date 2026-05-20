"""Speaker driver.

Streams audio samples from a thread-safe buffer to the system output device
using `sounddevice`.

Actions:
- `play(samples)`: enqueue audio (list of floats in [-1, 1] OR a list of
  lists where the first column is the sample value).
- `clear()`: empty the playback buffer.
- `list_devices()`: enumerate output devices.
- `set_device(index)` / `set_samplerate(sr)`: reconfigure the output stream.
"""

from __future__ import annotations

import contextlib
import queue
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext


class SpeakerDriver(BaseDriver):
    name: ClassVar[str] = "speaker"
    description: ClassVar[str] = "Audio output via sounddevice."
    events: ClassVar[tuple[str, ...]] = ("settings", "underrun")
    actions: ClassVar[tuple[str, ...]] = (
        "play",
        "clear",
        "list_devices",
        "set_device",
        "set_samplerate",
    )
    loop_interval_s: ClassVar[float | None] = None  # callback driven

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device: int | None = None
        self._samplerate = 44_100
        self._channels = 1
        self._blocksize = 1024
        self._buffer: queue.Queue[Any] = queue.Queue()
        self._stream: Any = None

    def pre_run(self) -> None:
        self._open_stream()

    def cleanup(self) -> None:
        self._close_stream()

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def execute(self, action: str, data: Any) -> Any:
        if action == "play":
            self._play(data)
            return {"ok": True, "queued": self._buffer.qsize()}
        if action == "clear":
            with contextlib.suppress(Exception):
                while True:
                    self._buffer.get_nowait()
            return {"ok": True}
        if action == "list_devices":
            return self._list_devices()
        if action == "set_device":
            self._device = None if data is None else int(data)
            self._reopen()
            return {"device": self._device}
        if action == "set_samplerate":
            self._samplerate = int(data)
            self._reopen()
            return {"samplerate": self._samplerate}
        return super().execute(action, data)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _play(self, data: Any) -> None:
        try:
            import numpy as np  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"numpy required: {exc}")
            return
        if data is None:
            return
        samples = np.asarray(data, dtype=np.float32)
        if samples.ndim > 1:
            samples = samples[:, 0]
        # Push in blocksize chunks (zero-padded if the tail is short).
        bs = self._blocksize
        n = samples.shape[0]
        i = 0
        while i < n:
            chunk = samples[i : i + bs]
            if chunk.shape[0] < bs:
                chunk = np.concatenate([chunk, np.zeros(bs - chunk.shape[0], dtype=np.float32)])
            self._buffer.put(chunk)
            i += bs

    def _list_devices(self) -> dict[str, Any]:
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"sounddevice not available: {exc}"}
        devices = sd.query_devices()
        defaults = sd.default.device
        return {
            "ok": True,
            "default_output": defaults[1] if isinstance(defaults, (list, tuple)) else defaults,
            "devices": [
                {
                    "index": idx,
                    "name": d.get("name"),
                    "max_output_channels": d.get("max_output_channels", 0),
                    "default_samplerate": d.get("default_samplerate", 0),
                }
                for idx, d in enumerate(devices)
                if d.get("max_output_channels", 0) > 0
            ],
        }

    def _open_stream(self) -> None:
        try:
            import numpy as np  # type: ignore[import-not-found]
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"sounddevice/numpy required: {exc}")
            return

        def callback(outdata: Any, frames: int, _time: Any, _status: Any) -> None:
            try:
                block = self._buffer.get_nowait()
            except queue.Empty:
                outdata[:] = np.zeros((frames, self._channels), dtype=np.float32)
                return
            if block.shape[0] != frames:
                # Shouldn't happen if _play pads correctly, but be defensive.
                if block.shape[0] > frames:
                    block = block[:frames]
                else:
                    block = np.concatenate(
                        [block, np.zeros(frames - block.shape[0], dtype=np.float32)]
                    )
            outdata[:] = block.reshape(-1, self._channels)

        try:
            stream = sd.OutputStream(
                samplerate=self._samplerate,
                channels=self._channels,
                blocksize=self._blocksize,
                callback=callback,
                device=self._device,
                dtype="float32",
            )
            stream.start()
        except Exception as exc:
            self.log("error", f"cannot open speaker: {exc!r}")
            return

        self._stream = stream
        self.emit(
            "settings",
            {
                "device": self._device,
                "samplerate": self._samplerate,
                "channels": self._channels,
                "blocksize": self._blocksize,
            },
        )
        self.log(
            "info",
            f"speaker open device={self._device} sr={self._samplerate} ch={self._channels}",
        )

    def _close_stream(self) -> None:
        if self._stream is None:
            return
        with contextlib.suppress(Exception):
            self._stream.stop()
            self._stream.close()
        self._stream = None

    def _reopen(self) -> None:
        self._close_stream()
        self._open_stream()
