"""Test doubles for drivers run without a bridge."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

import msgspec
import numpy as np

from gosai_py.bridge import public_payload
from gosai_py.driver import BaseDriver, DriverContext


class RecordingContext(DriverContext):
    """Records what a driver emits, logs and reports. Subscriptions are kept, not wired."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.events: list[tuple[str, Any]] = []
        self.logs: list[tuple[str, str]] = []
        self.metrics: list[tuple[str, float]] = []
        self.states: list[str] = []
        self.subscriptions: dict[tuple[str, str], list[Callable[[Any], None]]] = {}
        self.external: set[str] | None = None

    def emit(self, event: str, data: Any) -> None:
        with self.lock:
            self.events.append((event, data))

    def log(self, level: str, message: str) -> None:
        with self.lock:
            self.logs.append((level, message))

    def record_performance(self, metric: str, value: float) -> None:
        with self.lock:
            self.metrics.append((metric, value))

    def set_state(self, state: str, runtime_info: dict[str, Any] | None = None) -> None:
        with self.lock:
            self.states.append(state)

    def subscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        with self.lock:
            self.subscriptions.setdefault((driver, event), []).append(callback)

    def unsubscribe(self, driver: str, event: str, callback: Callable[[Any], None]) -> None:
        with self.lock:
            callbacks = self.subscriptions.get((driver, event), [])
            if callback in callbacks:
                callbacks.remove(callback)

    def get_event_data(self, driver: str, event: str) -> Any:
        return None

    def has_subscribers(self, event: str) -> bool:
        return self.external is None or event in self.external

    def deliver(self, driver: str, event: str, data: Any) -> None:
        """Offer `data` to every subscription callback, as the bridge would."""
        with self.lock:
            callbacks = list(self.subscriptions.get((driver, event), []))
        for callback in callbacks:
            callback(data)

    def emitted(self, event: str) -> list[Any]:
        with self.lock:
            return [data for name, data in self.events if name == event]


def check_events(cls: type[BaseDriver], context: RecordingContext) -> None:
    """Every emitted payload matches the type its event declares."""
    events = cls.events
    assert isinstance(events, Mapping), f"{cls.name} declares no event types"
    with context.lock:
        emitted = list(context.events)
    for event, data in emitted:
        assert event in events, f"{cls.name} emitted undeclared event {event!r}"
        msgspec.convert(public_payload(data), events[event].payload)


def check_result(cls: type[BaseDriver], action: str, result: Any) -> Any:
    """The action result matches its declared type. Returns the result."""
    msgspec.convert(result, cls.action_specs()[action].result)
    return result


def wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.005)


class FakeCameras:
    """Camera devices that allow one open handle each, like V4L2."""

    def __init__(self, modes: dict[int, list[tuple[int, int]]]) -> None:
        self.modes = modes
        self.lock = threading.Lock()
        self.open_handles: dict[int, FakeCapture] = {}
        self.opens: list[int] = []

    def open(self, device: int) -> FakeCapture:
        return FakeCapture(self, device)


class FakeCapture:
    def __init__(self, cameras: FakeCameras, device: int) -> None:
        self._cameras = cameras
        self.device = device
        self.settings: dict[int, float] = {}
        with cameras.lock:
            cameras.opens.append(device)
            self._opened = device in cameras.modes and device not in cameras.open_handles
            if self._opened:
                cameras.open_handles[device] = self

    def isOpened(self) -> bool:  # noqa: N802 - OpenCV API
        return self._opened

    def release(self) -> None:
        with self._cameras.lock:
            if self._cameras.open_handles.get(self.device) is self:
                del self._cameras.open_handles[self.device]
        self._opened = False

    def set(self, prop: int, value: float) -> bool:
        self.settings[prop] = value
        return True

    def get(self, prop: int) -> float:
        return self.settings.get(prop, 0.0)

    def read(self) -> tuple[bool, Any]:
        if not self._opened:
            return False, None
        time.sleep(0.002)
        modes = self._cameras.modes[self.device]
        requested = (int(self.settings.get(3, 0)), int(self.settings.get(4, 0)))
        width, height = requested if requested in modes else modes[0]
        return True, np.full((height, width, 3), 80, dtype=np.uint8)


class FakeStream:
    """A sounddevice stream whose callback the test drives."""

    def __init__(self, fail: bool, **kwargs: Any) -> None:
        if fail:
            raise RuntimeError("PortAudio: device unavailable")
        self.kwargs = kwargs
        self.callback = kwargs["callback"]
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False

    def close(self) -> None:
        self.closed = True


class FakeSoundDevice:
    """Stands in for the `sounddevice` module."""

    class _Default:
        device = (1, -1)

    def __init__(self) -> None:
        self.default = self._Default()
        self.streams: list[FakeStream] = []
        self.fail = False

    def query_devices(self) -> list[dict[str, Any]]:
        return [
            {"name": "Speakers", "max_input_channels": 0, "max_output_channels": 2, "default_samplerate": 48000.0},
            {"name": "Mic", "max_input_channels": 1, "max_output_channels": 0, "default_samplerate": 16000.0},
        ]

    def InputStream(self, **kwargs: Any) -> FakeStream:  # noqa: N802 - sounddevice API
        stream = FakeStream(self.fail, **kwargs)
        self.streams.append(stream)
        return stream

    def OutputStream(self, **kwargs: Any) -> FakeStream:  # noqa: N802 - sounddevice API
        return self.InputStream(**kwargs)
