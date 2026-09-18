"""Speaker driver.

Plays audio through `sounddevice`. Each instance has its own output stream
and playback buffer: `play` appends samples, the output callback copies what
it needs and fills the rest of the block with silence. The callback only
counts underruns; a worker thread reports them as `underrun`, at most once a
second, so a starved stream can't flood the bridge from the audio thread.

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
from collections import deque
from collections.abc import Callable, Mapping
from typing import Annotated, Any, ClassVar

import msgspec
import numpy as np
from msgspec import Meta

from gosai_py import devices
from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.drivers.microphone import AudioSettingsPayload, DeviceResult, SamplerateResult
from gosai_py.payloads import AudioSamples, EpochMs, mono_samples

DEFAULT_SAMPLERATE = 44_100
BLOCKSIZE = 1024
CHANNELS = 1
# Shortest time between two `underrun` events.
UNDERRUN_INTERVAL_S = 1.0


class SpeakerConfig(msgspec.Struct, kw_only=True):
    device: int | None = None
    samplerate: int | None = None


class UnderrunPayload(msgspec.Struct, kw_only=True):
    count: Annotated[int, Meta(description="Underruns since the previous event.")]
    ts: EpochMs


class PlayResult(msgspec.Struct, kw_only=True):
    # Pending audio in blocks of 1024 samples, rounded up.
    queued: int
    queued_samples: int


class OutputDevice(msgspec.Struct, kw_only=True):
    index: int
    name: str
    max_output_channels: int
    default_samplerate: float


class OutputDevices(msgspec.Struct, kw_only=True):
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


class UnderrunCounter:
    """Counts underruns on the audio thread and reports them from a worker thread.

    `add` only bumps the count. The worker reports the first underrun at
    once, then waits `interval_s` before it reports the ones that came since.
    """

    def __init__(
        self,
        report: Callable[[int], None],
        *,
        name: str,
        interval_s: float,
        on_error: Callable[[BaseException], None],
    ) -> None:
        self._report = report
        self._interval_s = interval_s
        self._on_error = on_error
        self._cond = threading.Condition()
        self._count = 0
        self._closed = False
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    def add(self) -> None:
        with self._cond:
            self._count += 1
            self._cond.notify()

    def close(self) -> None:
        """Stop the worker. Underruns it hasn't reported yet are dropped."""
        with self._cond:
            self._closed = True
            self._cond.notify()

    def join(self, timeout: float | None = None) -> bool:
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def _run(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._count > 0 or self._closed)
                if self._closed:
                    return
                count, self._count = self._count, 0
            try:
                self._report(count)
            except Exception as exc:
                self._on_error(exc)
            with self._cond:
                if self._cond.wait_for(lambda: self._closed, self._interval_s):
                    return


class SpeakerDriver(BaseDriver):
    name = "speaker"
    description = "Audio output via sounddevice."
    events: ClassVar[Mapping[str, Event]] = {
        "settings": Event(AudioSettingsPayload, "Stream settings after each (re)open."),
        "underrun": Event(
            UnderrunPayload,
            "The output device ran out of data. At most once a second, with a count.",
        ),
    }
    config_type = SpeakerConfig
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device: int | None = None
        self._samplerate = DEFAULT_SAMPLERATE
        self._buffer = PlaybackBuffer()
        self._stream: Any = None
        self._underruns: UnderrunCounter | None = None

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
    def clear(self) -> None:
        self._buffer.clear()

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
        underruns = UnderrunCounter(
            lambda count: self.emit("underrun", {"count": count, "ts": now_ms()}),
            name=f"driver:{self.name}:underruns",
            interval_s=UNDERRUN_INTERVAL_S,
            on_error=lambda exc: self.log("error", f"underrun report failed: {exc!r}"),
        )

        def callback(outdata: np.ndarray, _frames: int, _time: Any, status: Any) -> None:
            self._buffer.read_into(outdata)
            if status.output_underflow:
                underruns.add()

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
            underruns.close()
            underruns.join(1.0)
            raise RuntimeError(f"cannot open speaker device={self._device}: {exc}") from exc

        self._stream, self._underruns = stream, underruns
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
        underruns, self._underruns = self._underruns, None
        if stream is not None:
            stream.stop()
            stream.close()
        if underruns is not None:
            underruns.close()
            underruns.join(1.0)
