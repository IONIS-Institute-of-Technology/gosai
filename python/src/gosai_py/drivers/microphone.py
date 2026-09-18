"""Microphone driver.

Captures audio with `sounddevice`. The stream callback only copies each block
into a bounded queue; a worker thread emits `audio_stream`, so subscribers
such as FFT and voice detection never run on the audio thread.

In-process subscribers also get `_block`, the float32 `(frames, channels)`
ndarray, and can skip the list conversion.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated, Any, ClassVar

import msgspec
import numpy as np
from msgspec import Meta

from gosai_py import devices
from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.workers import BoundedQueueWorker

DEFAULT_SAMPLERATE = 16_000
BLOCKSIZE = 1024
# Blocks waiting for the worker, about 4 s at the defaults.
QUEUE_BLOCKS = 64


class MicrophoneConfig(msgspec.Struct, kw_only=True):
    device: int | None = None
    samplerate: int | None = None
    channels: int | None = None


class AudioStreamPayload(msgspec.Struct, kw_only=True):
    # (frames, channels) float32 samples in [-1, 1].
    block: list[list[float]]
    samplerate: int
    channels: int
    blocksize: int
    ts: Annotated[
        float,
        Meta(
            description="When the block reached the driver, in milliseconds since the Unix epoch."
        ),
    ]


class AudioSettingsPayload(msgspec.Struct, kw_only=True):
    device: int | None
    samplerate: int
    channels: int
    blocksize: int


class InputDevice(msgspec.Struct, kw_only=True):
    index: int
    name: str
    max_input_channels: int
    default_samplerate: float


class InputDevices(msgspec.Struct, kw_only=True):
    default_input: int | None
    devices: list[InputDevice]


class DeviceResult(msgspec.Struct, kw_only=True):
    device: int | None


class SamplerateResult(msgspec.Struct, kw_only=True):
    samplerate: int


class MicrophoneDriver(BaseDriver):
    name = "microphone"
    description = "Audio input via sounddevice."
    events: ClassVar[Mapping[str, Event]] = {
        "audio_stream": Event(AudioStreamPayload, "Every captured block, in order."),
        "settings": Event(AudioSettingsPayload, "Stream settings after each (re)open."),
    }
    # About 4 s of blocks at 16 kHz while Node reads slowly.
    buffered_events: ClassVar[dict[str, int]] = {"audio_stream": 64}
    config_type = MicrophoneConfig
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device: int | None = None
        self._samplerate = DEFAULT_SAMPLERATE
        self._channels = 1
        self._stream: Any = None
        self._worker: BoundedQueueWorker | None = None

    def configure(self, config: MicrophoneConfig) -> None:
        self._device = config.device
        self._samplerate = config.samplerate or DEFAULT_SAMPLERATE
        self._channels = config.channels or 1

    def pre_run(self) -> None:
        self._open_stream()

    def cleanup(self) -> None:
        self._close_stream()

    @action("List input devices.")
    def list_devices(self) -> InputDevices:
        listing = devices.audio_devices()
        return InputDevices(
            default_input=listing.default_input,
            devices=[
                InputDevice(
                    index=d.index,
                    name=d.name,
                    max_input_channels=d.max_input_channels,
                    default_samplerate=d.default_samplerate,
                )
                for d in listing.devices
                if d.max_input_channels > 0
            ],
        )

    @action("Capture from another device; null picks the system default.")
    def set_device(self, device: int | None) -> DeviceResult:
        self._reopen(device, self._samplerate)
        return DeviceResult(device=self._device)

    @action("Capture at another sample rate.")
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
        samplerate, channels = self._samplerate, self._channels
        worker = BoundedQueueWorker(
            lambda item: self._publish(item, samplerate, channels),
            name=f"driver:{self.name}:blocks",
            maxsize=QUEUE_BLOCKS,
            on_error=lambda exc: self.log("error", f"audio block failed: {exc!r}"),
        )

        def callback(indata: Any, _frames: int, _time: Any, status: Any) -> None:
            worker.offer((indata.copy(), now_ms(), str(status) if status else None))

        try:
            stream = sd.InputStream(
                samplerate=samplerate,
                channels=channels,
                blocksize=BLOCKSIZE,
                callback=callback,
                device=self._device,
                dtype="float32",
            )
            stream.start()
        except Exception as exc:
            worker.close()
            worker.join(1.0)
            raise RuntimeError(f"cannot open microphone device={self._device}: {exc}") from exc

        self._stream, self._worker = stream, worker
        self.emit(
            "settings",
            {
                "device": self._device,
                "samplerate": samplerate,
                "channels": channels,
                "blocksize": BLOCKSIZE,
            },
        )
        self.log("info", f"microphone open device={self._device} sr={samplerate} ch={channels}")

    def _publish(
        self, item: tuple[np.ndarray, float, str | None], samplerate: int, channels: int
    ) -> None:
        block, ts, status = item
        if status:
            self.log("warn", f"microphone status: {status}")
        self.emit(
            "audio_stream",
            {
                "block": block.tolist(),
                "_block": block,
                "samplerate": samplerate,
                "channels": channels,
                "blocksize": len(block),
                "ts": ts,
            },
        )

    def _close_stream(self) -> None:
        stream, self._stream = self._stream, None
        worker, self._worker = self._worker, None
        if stream is not None:
            stream.stop()
            stream.close()
        if worker is not None:
            worker.close()
            worker.join(1.0)
