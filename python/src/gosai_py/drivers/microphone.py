"""Microphone driver.

Captures audio from the system input device using `sounddevice` and emits
PCM blocks on the `audio_stream` event.

The driver is callback-driven (no loop): `sounddevice` calls our callback
from its own thread whenever a fresh block arrives. We forward the block,
metadata, and a timestamp.

Audio buffer payload:
- `block`: list[list[float]] - shape (frames, channels), float32 normalized
  to ~[-1, 1].
- `samplerate`: int - samples per second.
- `channels`: int - number of channels.
- `blocksize`: int - frames per block.
- `ts`: float - capture timestamp.
"""

from __future__ import annotations

import contextlib
from typing import Any, ClassVar

from gosai_py.driver import BaseDriver, DriverContext


class MicrophoneDriver(BaseDriver):
    name: ClassVar[str] = "microphone"
    description: ClassVar[str] = "Audio input via sounddevice."
    events: ClassVar[tuple[str, ...]] = ("audio_stream", "settings")
    actions: ClassVar[tuple[str, ...]] = ("list_devices", "set_device", "set_samplerate")
    loop_interval_s: ClassVar[float | None] = None  # callback driven

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._device: int | None = None
        self._samplerate = 16_000
        self._channels = 1
        self._blocksize = 1024
        self._stream: Any = None

    def apply_config(self, cfg: dict[str, Any]) -> None:
        """Apply persisted settings before the input stream opens."""
        if "device" in cfg:
            self._device = None if cfg["device"] is None else int(cfg["device"])
        if "samplerate" in cfg and cfg["samplerate"] is not None:
            self._samplerate = int(cfg["samplerate"])
        if "channels" in cfg and cfg["channels"] is not None:
            self._channels = int(cfg["channels"])

    def pre_run(self) -> None:
        self._open_stream()

    def cleanup(self) -> None:
        self._close_stream()

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def execute(self, action: str, data: Any) -> Any:
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
    # Stream management
    # ------------------------------------------------------------------

    def _list_devices(self) -> dict[str, Any]:
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as exc:
            return {"ok": False, "error": f"sounddevice not available: {exc}"}
        devices = sd.query_devices()
        defaults = sd.default.device
        return {
            "ok": True,
            "default_input": defaults[0] if isinstance(defaults, (list, tuple)) else defaults,
            "devices": [
                {
                    "index": idx,
                    "name": d.get("name"),
                    "max_input_channels": d.get("max_input_channels", 0),
                    "default_samplerate": d.get("default_samplerate", 0),
                }
                for idx, d in enumerate(devices)
                if d.get("max_input_channels", 0) > 0
            ],
        }

    def _open_stream(self) -> None:
        try:
            import sounddevice as sd  # type: ignore[import-not-found]
        except ImportError as exc:
            self.log("error", f"sounddevice not available: {exc}")
            return

        def callback(indata: Any, frames: int, _time: Any, status: Any) -> None:
            if status:
                self.log("warn", f"microphone status: {status!s}")
            self.emit(
                "audio_stream",
                {
                    "block": indata.tolist(),
                    "samplerate": self._samplerate,
                    "channels": self._channels,
                    "blocksize": frames,
                },
            )

        try:
            stream = sd.InputStream(
                samplerate=self._samplerate,
                channels=self._channels,
                blocksize=self._blocksize,
                callback=callback,
                device=self._device,
                dtype="float32",
            )
            stream.start()
        except Exception as exc:
            self.log("error", f"cannot open microphone: {exc!r}")
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
            f"microphone open device={self._device} sr={self._samplerate} ch={self._channels}",
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
