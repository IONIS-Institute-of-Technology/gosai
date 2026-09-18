"""Shared fixtures for bridge and driver tests."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from typing import Any

import msgspec
import pytest

from gosai_py.bridge import Bridge
from gosai_py.driver import BaseDriver

# Thread name prefixes owned by the bridge runtime. Tests must not leave any of
# these running.
_RUNTIME_THREAD_PREFIXES = ("bridge:", "driver:", "camera:", "interp:")


class Collector:
    """Bridge sink that decodes and records every protocol message."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._partial = bytearray()
        self.messages: list[dict[str, Any]] = []

    def __call__(self, chunk: memoryview) -> int:
        with self._cond:
            self._partial.extend(chunk)
            *lines, rest = bytes(self._partial).split(b"\n")
            self._partial = bytearray(rest)
            self.messages.extend(msgspec.json.decode(line) for line in lines if line)
            self._cond.notify_all()
        return len(chunk)

    def wait_for(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 5.0
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                for message in self.messages:
                    if predicate(message):
                        return message
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError(f"no matching message; got {self.messages!r}")
                self._cond.wait(remaining)

    def result(self, req_id: str, timeout: float = 5.0) -> dict[str, Any]:
        return self.wait_for(lambda m: m.get("type") == "result" and m.get("id") == req_id, timeout)

    def states(self, instance: str, driver: str) -> list[str]:
        with self._cond:
            return [
                m["state"]
                for m in self.messages
                if m.get("type") == "driver-state"
                and m.get("instance") == instance
                and m.get("driver") == driver
            ]

    def of_type(self, kind: str) -> list[dict[str, Any]]:
        with self._cond:
            return [m for m in self.messages if m.get("type") == kind]


BridgeFactory = Callable[..., tuple[Bridge, Collector]]


@pytest.fixture
def make_bridge() -> Iterator[BridgeFactory]:
    """Build started bridges around test drivers and close them afterwards."""
    bridges: list[Bridge] = []

    def factory(drivers: Iterable[type[BaseDriver]], **kwargs: Any) -> tuple[Bridge, Collector]:
        collector = Collector()
        bridge = Bridge(collector, drivers=drivers, **kwargs)
        bridge.start()
        bridges.append(bridge)
        return bridge, collector

    yield factory
    for bridge in bridges:
        bridge.close(timeout=10.0)


@pytest.fixture(autouse=True)
def _no_leaked_runtime_threads() -> Iterator[None]:
    before = set(threading.enumerate())
    yield
    deadline = time.monotonic() + 5.0
    while True:
        leaked = [
            t
            for t in threading.enumerate()
            if t not in before and t.is_alive() and t.name.startswith(_RUNTIME_THREAD_PREFIXES)
        ]
        if not leaked or time.monotonic() > deadline:
            break
        time.sleep(0.02)
    assert not leaked, f"test left runtime threads running: {[t.name for t in leaked]}"


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _field(number: int, payload: bytes | int) -> bytes:
    if isinstance(payload, int):
        return _varint(number << 3) + _varint(payload)
    return _varint(number << 3 | 2) + _varint(len(payload)) + payload


def _float_tensor_value(name: str, dims: tuple[int, ...]) -> bytes:
    shape = b"".join(_field(1, _field(1, dim)) for dim in dims)
    tensor_type = _field(1, 1) + _field(2, shape)  # elem_type FLOAT, shape
    return _field(1, name.encode()) + _field(2, _field(1, tensor_type))


@pytest.fixture
def identity_model(tmp_path: Path) -> Path:
    """Write a float32 [1, 3] Identity model, encoded by hand to avoid the onnx package."""
    node = _field(1, b"x") + _field(2, b"y") + _field(4, b"Identity")
    graph = (
        _field(1, node)
        + _field(2, b"identity")
        + _field(11, _float_tensor_value("x", (1, 3)))
        + _field(12, _float_tensor_value("y", (1, 3)))
    )
    model = _field(1, 8) + _field(7, graph) + _field(8, _field(2, 17))
    path = tmp_path / "identity.onnx"
    path.write_bytes(model)
    return path
