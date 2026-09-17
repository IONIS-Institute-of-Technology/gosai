"""The bridge as a real process: the stdio loop, shutdown and SIGTERM."""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from typing import Any

import msgspec
import pytest

from gosai_py.bridge import PROTOCOL_VERSION


class BridgeProcess:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "gosai_py.bridge"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.seen: list[dict[str, Any]] = []
        self._reader = threading.Thread(target=self._read, name="test:bridge-stdout", daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.messages.put(msgspec.json.decode(line))

    def send(self, **request: Any) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(msgspec.json.encode(request) + b"\n")
        self.proc.stdin.flush()

    def next_message(self, predicate: Any, timeout: float = 60.0) -> dict[str, Any]:
        for message in self.seen:
            if predicate(message):
                return message
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"no matching message; saw {self.seen!r}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty:
                continue
            self.seen.append(message)
            if predicate(message):
                return message

    def result(self, req_id: str, timeout: float = 60.0) -> dict[str, Any]:
        return self.next_message(lambda m: m.get("type") == "result" and m.get("id") == req_id, timeout)

    def drain(self) -> list[dict[str, Any]]:
        self._reader.join(10.0)
        while not self.messages.empty():
            self.seen.append(self.messages.get_nowait())
        return self.seen

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(10.0)
        for stream in (self.proc.stdin, self.proc.stdout):
            if stream is not None:
                stream.close()
        self._reader.join(10.0)


@pytest.fixture
def bridge_process() -> Iterator[BridgeProcess]:
    process = BridgeProcess()
    try:
        yield process
    finally:
        process.close()


def _start_heartbeat(bridge: BridgeProcess) -> None:
    bridge.send(type="start-driver", id="start", instance="system", driver="heartbeat")
    assert bridge.result("start")["ok"]


def test_ready_comes_first_and_ping_is_answered_during_discovery(
    bridge_process: BridgeProcess,
) -> None:
    ready = bridge_process.next_message(lambda m: True, timeout=15.0)
    assert ready["type"] == "ready"
    assert ready["protocol"] == PROTOCOL_VERSION

    bridge_process.send(type="ping", id="p")
    pong = bridge_process.next_message(lambda m: m.get("type") == "pong", timeout=15.0)
    assert pong["id"] == "p"


def test_stdio_round_trip_and_shutdown(bridge_process: BridgeProcess) -> None:
    bridge_process.send(type="list-drivers", id="list")
    names = {d["name"] for d in bridge_process.result("list")["data"]["drivers"]}
    assert "heartbeat" in names

    _start_heartbeat(bridge_process)
    bridge_process.send(type="subscribe", id="sub", instance="system", driver="heartbeat", event="tick")
    assert bridge_process.result("sub")["ok"]
    tick = bridge_process.next_message(lambda m: m.get("type") == "event", timeout=10.0)
    assert tick["instance"] == "system"
    assert tick["driver"] == "heartbeat"
    assert tick["ts"] > 1e12  # milliseconds

    bridge_process.send(type="execute", id="echo", instance="system", driver="heartbeat", action="echo", data=[1])
    assert bridge_process.result("echo")["data"]["echoed"] == [1]

    bridge_process.send(type="shutdown", id="bye")
    assert bridge_process.result("bye")["ok"]
    assert bridge_process.proc.wait(10.0) == 0
    states = [m["state"] for m in bridge_process.drain() if m.get("type") == "driver-state"]
    assert states[-2:] == ["stopping", "available"]


def test_sigterm_stops_drivers_and_exits(bridge_process: BridgeProcess) -> None:
    _start_heartbeat(bridge_process)
    bridge_process.proc.send_signal(signal.SIGTERM)
    assert bridge_process.proc.wait(10.0) == 0
    states = [m["state"] for m in bridge_process.drain() if m.get("type") == "driver-state"]
    assert states[-1] == "available"


def test_closing_stdin_exits(bridge_process: BridgeProcess) -> None:
    _start_heartbeat(bridge_process)
    assert bridge_process.proc.stdin is not None
    bridge_process.proc.stdin.close()
    assert bridge_process.proc.wait(10.0) == 0
