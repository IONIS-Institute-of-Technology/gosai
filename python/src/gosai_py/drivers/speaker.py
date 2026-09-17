"""Speaker driver.

Plays audio through `sounddevice`. Each instance has its own output stream
and playback buffer: `play` appends samples, the output callback copies what
it needs and fills the rest of the block with silence.

The driver is exclusive, so every app gets its own instance. A shared
instance would let one app's `clear` or `set_samplerate` cut another app's
audio, and the bridge can't tell apps apart inside one instance. Mixing
several streams is the OS's job: PipeWire, PulseAudio, CoreAudio and WASAPI
shared mode all do it, and plain ALSA's `default` device goes through dmix.
Only when an app picks a raw ALSA `hw` device can a second app fail to open
it, and then its start fails with that error instead of silently sharing.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Mapping
from typing import Any, ClassVar

import msgspec
import numpy as np

from gosai_py import devices
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.drivers.microphone import AudioSettingsPayload, DeviceResult, SamplerateResult
from gosai_py.payloads import AudioSamples, Ok, mono_samples

DEFAULT_SAMPLERATE = 44_100
BLOCKSIZE = 1024
CHANNELS = 1


class SpeakerConfig(msgspec.Struct, kw_only=True):
    device: int | None = None
    samplerate: int | None = None


class UnderrunPayload(msgspec.Struct, kw_only=True):
    ts: float


class PlayResult(msgspec.Struct, kw_only=True):
    ok: bool = True
    # Pending audio in blocks of 1024 samples, rounded up.
    queued: int
    queued_samples: int


class OutputDevice(msgspec.Struct, kw_only=True):
    index: int
    name: str
    max_output_channels: int
    default_samplerate: float


class OutputDevices(msgspec.Struct, kw_only=True):
    ok: bool = True
    default_output: int | None
    devices: list[OutputDevice]


class PlaybackBuffer:
    """Mono samples waiting to be played, filled by `play` and drained by the callback."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._chunks: deque[np.ndarray] = deque()
        self._offset = 0
        self._pending = 0

    def append(self, samples: np.ndarray) -> int:
        with self._lock:
            if len(samples):
                self._chunks.append(samples)
                self._pending += len(samples)
            return self._pending

    def clear(self) -> None:
        with self._lock:
            self._chunks.clear()
            self._offset = 0
            self._pending = 0

    def pending(self) -> int:
        with self._lock:
            return self._pending

    def read_into(self, out: np.ndarray) -> int:
        """Copy up to `len(out)` samples into every channel of `out`, zero the rest.

        Returns the number of samples copied.
        """
        filled = 0
        with self._lock:
            while filled < len(out) and self._chunks:
                chunk = self._chunks[0]
                take = min(len(chunk) - self._offset, len(out) - filled)
                out[filled : filled + take] = chunk[self._offset : self._offset + take, None]
                filled += take
                self._offset += take
                if self._offset == len(chunk):
                    self._chunks.popleft()
                    self._offset = 0
            self._pending -= filled
        out[filled:] = 0.0
        return filled


class SpeakerDriver(BaseDriver):
    name = "speaker"
    description = "Audio output via sounddevice."
    events: ClassVar[Mapping[str, Event]] = {
        "settings": Event(AudioSettingsPayload, "Stream settings after each (re)open."),
        "underrun": Event(UnderrunPayload, "The output device ran out of data."),
    }
    config_type = SpeakerConfig
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device: int | None = None
        self._samplerate = DEFAULT_SAMPLERATE
        self._buffer = PlaybackBuffer()
        self._stream: Any = None

    def configure(self, config: SpeakerConfig) -> None:
        self._device = config.device
        self._samplerate = config.samplerate or DEFAULT_SAMPLERATE

    def pre_run(self) -> None:
        self._open_stream()

    def cleanup(self) -> None:
        self._close_stream()

    @action("Queue samples in [-1, 1] at the stream's sample rate. Rows use their first column.")
    def play(self, samples: AudioSamples | None) -> PlayResult:
        pending = self._buffer.append(mono_samples(samples)) if samples else self._buffer.pending()
        return PlayResult(queued=math.ceil(pending / BLOCKSIZE), queued_samples=pending)

    @action("Drop queued audio.")
    def clear(self) -> Ok:
        self._buffer.clear()
        return Ok()

    @action("List output devices.")
    def list_devices(self) -> OutputDevices:
        listing = devices.audio_devices()
        return OutputDevices(
            default_output=listing.default_output,
            devices=[
                OutputDevice(
                    index=d.index,
                    name=d.name,
                    max_output_channels=d.max_output_channels,
                    default_samplerate=d.default_samplerate,
                )
                for d in listing.devices
                if d.max_output_channels > 0
            ],
        )

    @action("Play on another device; null picks the system default.")
    def set_device(self, device: int | None) -> DeviceResult:
        self._reopen(device, self._samplerate)
        return DeviceResult(device=self._device)

    @action("Play at another sample rate.")
    def set_samplerate(self, samplerate: int) -> SamplerateResult:
        self._reopen(self._device, samplerate)
        return SamplerateResult(samplerate=self._samplerate)

    def _reopen(self, device: int | None, samplerate: int) -> None:
        previous = (self._device, self._samplerate)
        self._close_stream()
        self._device, self._samplerate = device, samplerate
        try:
            self._open_stream()
        except Exception:
            self._device, self._samplerate = previous
            try:
                self._open_stream()
            except Exception as exc:
                self.log("error", f"could not restore {self.name} device={previous[0]}: {exc!r}")
                self.publish_state("errored")
            raise

    def _open_stream(self) -> None:
        sd = devices.sounddevice()

        def callback(outdata: np.ndarray, _frames: int, _time: Any, status: Any) -> None:
            self._buffer.read_into(outdata)
            if status.output_underflow:
                self.emit("underrun", {"ts": time.time()})

        try:
            stream = sd.OutputStream(
                samplerate=self._samplerate,
                channels=CHANNELS,
                blocksize=BLOCKSIZE,
                callback=callback,
                device=self._device,
                dtype="float32",
            )
            stream.start()
        except Exception as exc:
            raise RuntimeError(f"cannot open speaker device={self._device}: {exc}") from exc

        self._stream = stream
        self.emit(
            "settings",
            {
                "device": self._device,
                "samplerate": self._samplerate,
                "channels": CHANNELS,
                "blocksize": BLOCKSIZE,
            },
        )
        self.log("info", f"speaker open device={self._device} sr={self._samplerate} ch={CHANNELS}")

    def _close_stream(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            stream.stop()
            stream.close()
