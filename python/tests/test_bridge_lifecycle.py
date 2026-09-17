"""Driver lifecycle, request threading and output behaviour of the bridge."""

from __future__ import annotations

import threading
import time
from typing import Any, ClassVar

import msgspec
import numpy as np
import pytest

from conftest import BridgeFactory, Collector
from gosai_py.bridge import (
    CLOSE_BUDGET_S,
    Bridge,
    _Metrics,
    _TerminateError,
    _Writer,
    public_payload,
    write_all,
)
from gosai_py.driver import BaseDriver, DriverContext
from gosai_py.workers import BoundedQueueWorker


class Source(BaseDriver):
    name = "source"
    events = ("value",)
    actions = ("emit", "echo", "fail", "wait")
    loop_interval_s = None
    gate: ClassVar[threading.Event] = threading.Event()

    def execute(self, action: str, data: Any) -> Any:
        if action == "emit":
            self.emit("value", data)
            return None
        if action == "echo":
            return {"echo": data}
        if action == "fail":
            raise ValueError("bad input")
        if action == "wait":
            type(self).gate.wait(5.0)
            return {"waited": True}
        return super().execute(action, data)


class Sink(BaseDriver):
    name = "sink"
    events = ()
    dependencies = ("source",)
    subscribed = (("source", "value"),)
    loop_interval_s = None
    gate: ClassVar[threading.Event] = threading.Event()
    received: ClassVar[list[Any]] = []
    first_call: ClassVar[threading.Event] = threading.Event()

    def on_data(self, driver: str, event: str, data: Any) -> None:
        type(self).first_call.set()
        type(self).gate.wait(5.0)
        type(self).received.append(data)


class SlowStart(BaseDriver):
    name = "slow_start"
    loop_interval_s = None
    gate: ClassVar[threading.Event] = threading.Event()

    def pre_run(self) -> None:
        type(self).gate.wait(5.0)


class Flaky(BaseDriver):
    name = "flaky"
    loop_interval_s = None
    fail: ClassVar[bool] = True
    cleanups: ClassVar[int] = 0

    def pre_run(self) -> None:
        if type(self).fail:
            raise RuntimeError("boom")

    def cleanup(self) -> None:
        type(self).cleanups += 1


class Stubborn(BaseDriver):
    name = "stubborn"
    loop_interval_s = None
    gate: ClassVar[threading.Event] = threading.Event()

    def cleanup(self) -> None:
        type(self).gate.wait(5.0)


@pytest.fixture(autouse=True)
def _reset_drivers() -> Any:
    for gated in (Source, Sink, SlowStart, Stubborn):
        gated.gate = threading.Event()
    Sink.received = []
    Sink.first_call = threading.Event()
    Flaky.fail = True
    Flaky.cleanups = 0
    yield
    # Never leave a driver thread parked on a gate.
    for gated in (Source, Sink, SlowStart, Stubborn):
        gated.gate.set()


def _send(bridge: Bridge, req_id: str, **fields: Any) -> None:
    bridge.handle({"id": req_id, **fields})


def _start(bridge: Bridge, collector: Collector, req_id: str, driver: str, instance: str = "app") -> dict[str, Any]:
    _send(bridge, req_id, type="start-driver", instance=instance, driver=driver)
    return collector.result(req_id)


def test_start_replies_only_after_pre_run(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([SlowStart])
    _send(bridge, "1", type="start-driver", instance="app", driver="slow_start")

    collector.wait_for(lambda m: m.get("type") == "driver-state" and m.get("state") == "starting")
    time.sleep(0.2)
    assert not [m for m in collector.of_type("result") if m["id"] == "1"]

    SlowStart.gate.set()
    assert collector.result("1")["ok"]
    assert collector.states("app", "slow_start") == ["starting", "running"]


def test_failed_start_removes_the_instance_and_can_be_retried(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Flaky])

    reply = _start(bridge, collector, "1", "flaky")
    assert reply == {"type": "result", "id": "1", "ok": False, "error": "boom"}
    assert Flaky.cleanups == 1
    _send(bridge, "2", type="list-instances")
    assert collector.result("2")["data"] == {"instances": []}

    Flaky.fail = False
    assert _start(bridge, collector, "3", "flaky")["ok"]
    assert collector.states("app", "flaky") == ["starting", "starting", "running"]


def test_repeated_start_reports_running_again(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source])
    assert _start(bridge, collector, "1", "source")["ok"]
    assert _start(bridge, collector, "2", "source")["data"] == {"driver": "source", "state": "running"}
    assert collector.states("app", "source") == ["starting", "running", "running"]


def test_stop_timeout_keeps_the_instance_errored(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Stubborn], stop_timeout_s=0.2)
    assert _start(bridge, collector, "1", "stubborn")["ok"]

    _send(bridge, "2", type="stop-driver", instance="app", driver="stubborn")
    reply = collector.result("2")
    assert not reply["ok"]
    assert "did not stop within 0.2s" in reply["error"]
    assert collector.states("app", "stubborn")[-2:] == ["stopping", "errored"]
    _send(bridge, "3", type="list-instances")
    assert collector.result("3")["data"]["instances"] == [
        {"instance": "app", "driver": "stubborn", "state": "errored", "subscriptions": []}
    ]
    assert not _start(bridge, collector, "4", "stubborn")["ok"]

    Stubborn.gate.set()
    _send(bridge, "5", type="stop-driver", instance="app", driver="stubborn")
    assert collector.result("5")["ok"]
    assert collector.states("app", "stubborn")[-1] == "available"


def test_stop_reports_stopping_then_available(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source])
    assert _start(bridge, collector, "1", "source")["ok"]
    _send(bridge, "2", type="subscribe", instance="app", driver="source", event="value")
    collector.result("2")
    _send(bridge, "3", type="stop-driver", instance="app", driver="source")
    assert collector.result("3")["data"] == {"driver": "source", "state": "available"}
    assert collector.states("app", "source") == ["starting", "running", "stopping", "available"]
    assert not bridge._external_subscriptions


def test_action_errors_become_error_replies(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source])
    assert _start(bridge, collector, "1", "source")["ok"]

    _send(bridge, "2", type="execute", instance="app", driver="source", action="fail")
    assert collector.result("2") == {"type": "result", "id": "2", "ok": False, "error": "bad input"}
    _send(bridge, "3", type="execute", instance="app", driver="source", action="nope")
    assert "does not support action" in collector.result("3")["error"]
    _send(bridge, "4", type="execute", instance="other", driver="source", action="echo")
    assert collector.result("4")["error"] == "driver 'source' in 'other' is not running"


def test_slow_action_does_not_block_ping_or_other_instances(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source])
    assert _start(bridge, collector, "1", "source", instance="a")["ok"]
    assert _start(bridge, collector, "2", "source", instance="b")["ok"]

    _send(bridge, "3", type="execute", instance="a", driver="source", action="wait")
    _send(bridge, "4", type="ping")
    collector.wait_for(lambda m: m.get("type") == "pong" and m.get("id") == "4")
    _send(bridge, "5", type="execute", instance="b", driver="source", action="echo", data=1)
    assert collector.result("5")["data"] == {"echo": 1}
    # Requests for the busy instance wait their turn.
    _send(bridge, "6", type="execute", instance="a", driver="source", action="echo", data=2)
    time.sleep(0.1)
    assert not [m for m in collector.of_type("result") if m["id"] in ("3", "6")]

    Source.gate.set()
    assert [collector.result("3")["ok"], collector.result("6")["data"]] == [True, {"echo": 2}]
    ids = [m["id"] for m in collector.of_type("result")]
    assert ids.index("3") < ids.index("6")


def test_subscribers_get_the_latest_value_without_blocking_the_emitter(
    make_bridge: BridgeFactory,
) -> None:
    bridge, collector = make_bridge([Source, Sink])
    assert _start(bridge, collector, "1", "source")["ok"]
    assert _start(bridge, collector, "2", "sink")["ok"]
    source = bridge._instances[("app", "source")].driver

    source.emit("value", 1)
    assert Sink.first_call.wait(5.0)
    started = time.monotonic()
    for value in range(2, 6):
        source.emit("value", value)
    assert time.monotonic() - started < 0.5

    Sink.gate.set()
    deadline = time.monotonic() + 5.0
    while Sink.received != [1, 5] and time.monotonic() < deadline:
        time.sleep(0.01)
    assert Sink.received == [1, 5]


def test_shutdown_stops_drivers_dependents_first(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source, Sink])
    Sink.gate.set()

    def stdin() -> Any:
        # Node waits for each start reply before starting a dependent.
        yield msgspec.json.encode({"type": "start-driver", "id": "1", "instance": "app", "driver": "source"})
        collector.result("1")
        yield msgspec.json.encode({"type": "start-driver", "id": "2", "instance": "app", "driver": "sink"})
        collector.result("2")
        yield msgspec.json.encode({"type": "shutdown", "id": "3"})
        yield msgspec.json.encode({"type": "ping", "id": "4"})

    assert bridge.run(stdin()) == 0

    assert collector.messages[0]["type"] == "ready"
    assert collector.messages[0]["protocol"] == 2
    assert collector.result("3")["ok"]
    assert not [m for m in collector.of_type("pong")]
    states = [
        (m["driver"], m["state"]) for m in collector.of_type("driver-state") if m["state"] == "available"
    ]
    assert states == [("sink", "available"), ("source", "available")]


def test_writer_coalesces_events_but_keeps_every_ordered_message() -> None:
    written: list[bytes] = []
    first_write = threading.Event()
    release = threading.Event()

    def slow_sink(chunk: memoryview) -> int:
        first_write.set()
        release.wait(5.0)
        written.append(bytes(chunk))
        return len(chunk)

    writer = _Writer(slow_sink, _Metrics())
    writer.start()
    key = ("app", "source", "value")
    try:
        writer.post_latest(key, {"type": "event", "data": 0})
        assert first_write.wait(5.0)
        for value in range(1, 5):
            writer.post_latest(key, {"type": "event", "data": value})
            writer.post({"type": "log", "message": f"log {value}"})
        writer.post({"type": "result", "id": "r", "ok": True})
    finally:
        release.set()
        writer.close(5.0)

    messages = [msgspec.json.decode(line) for line in b"".join(written).splitlines()]
    assert [m["data"] for m in messages if m["type"] == "event"] == [0, 4]
    assert [m["message"] for m in messages if m["type"] == "log"] == [f"log {v}" for v in range(1, 5)]
    assert [m["id"] for m in messages if m["type"] == "result"] == ["r"]


def test_writer_replaces_unserializable_replies_with_errors() -> None:
    collector = Collector()
    writer = _Writer(collector, _Metrics())
    writer.post({"type": "result", "id": "x", "ok": True, "data": object()})
    writer.close()
    reply = collector.result("x")
    assert not reply["ok"]
    assert "not serializable" in reply["error"]


def test_write_all_loops_over_partial_writes() -> None:
    out = bytearray()

    def trickle(chunk: memoryview) -> int:
        out.extend(chunk[:3])
        return min(3, len(chunk))

    write_all(trickle, b"0123456789")
    assert bytes(out) == b"0123456789"


def test_payloads_strip_only_top_level_private_keys_and_encode_numpy() -> None:
    payload = public_payload({"_frame": object(), "a": {"_nested": 1}, "arr": np.arange(3), "f": np.float32(1.5)})
    assert set(payload) == {"a", "arr", "f"}

    collector = Collector()
    writer = _Writer(collector, _Metrics())
    writer.post_latest(("i", "d", "e"), {"type": "event", "data": payload})
    writer.close()
    assert collector.messages == [{"type": "event", "data": {"a": {"_nested": 1}, "arr": [0, 1, 2], "f": 1.5}}]


def test_events_logs_and_metrics_carry_instance_and_millisecond_timestamps(
    make_bridge: BridgeFactory,
) -> None:
    bridge, collector = make_bridge([Source])
    assert _start(bridge, collector, "1", "source")["ok"]
    _send(bridge, "2", type="subscribe", instance="app", driver="source", event="*")
    collector.result("2")
    source = bridge._instances[("app", "source")].driver
    source.emit("value", 3)
    source.log("info", "hello")
    for value in (1.0, 2.0, 6.0):
        source.record("latency_ms", value)

    event = collector.wait_for(lambda m: m.get("type") == "event")
    log = collector.wait_for(lambda m: m.get("type") == "log" and m.get("message") == "hello")
    metric = collector.wait_for(lambda m: m.get("type") == "performance", timeout=3.0)
    now = time.time() * 1000.0
    for message in (event, log, metric):
        assert abs(message["ts"] - now) < 5_000
    assert log["instance"] == "app"
    assert metric == {
        "type": "performance",
        "instance": "app",
        "source": "source",
        "metric": "latency_ms",
        "value": 3.0,
        "max": 6.0,
        "count": 3,
        "ts": metric["ts"],
    }


class _RecordingContext(DriverContext):
    def __init__(self) -> None:
        self.metrics: list[str] = []

    def emit(self, event: str, data: Any) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        pass

    def record_performance(self, metric: str, value: float) -> None:
        self.metrics.append(metric)

    def set_state(self, state: str, runtime_info: dict[str, Any] | None = None) -> None:
        pass


def test_idle_loop_iterations_are_not_recorded() -> None:
    iterations = threading.Semaphore(0)

    class Idle(BaseDriver):
        name = "idle"
        loop_interval_s = 0.0

        def loop(self) -> bool:
            iterations.release()
            time.sleep(0.001)
            return False

    context = _RecordingContext()
    driver = Idle(context)
    driver._bridge_start()
    try:
        for _ in range(5):
            assert iterations.acquire(timeout=5.0)
    finally:
        assert driver._bridge_stop(5.0)
    assert context.metrics == []


class Interpolator(BaseDriver):
    name = "interpolator"
    events = ("interpolated_data", "frame")
    stream_events = ("frame",)
    loop_interval_s = None


def test_only_declared_stream_events_are_coalesced() -> None:
    first_write = threading.Event()
    release = threading.Event()
    collector = Collector()

    def slow_sink(chunk: memoryview) -> int:
        first_write.set()
        release.wait(5.0)
        return collector(chunk)

    bridge = Bridge(slow_sink, drivers=[Interpolator])
    bridge.start()
    try:
        _send(bridge, "1", type="start-driver", instance="app", driver="interpolator")
        assert first_write.wait(5.0)
        release.set()
        collector.result("1")
        _send(bridge, "2", type="subscribe", instance="app", driver="interpolator", event="*")
        collector.result("2")
        driver = bridge._instances[("app", "interpolator")].driver

        release.clear()
        first_write.clear()
        driver.emit("frame", -1)
        assert first_write.wait(5.0)
        # The writer is now blocked: two interleaved jobs on one ordinary event,
        # and a burst of stream frames.
        for step in range(60):
            driver.emit("interpolated_data", {"name": "a", "step": step})
            driver.emit("interpolated_data", {"name": "b", "step": step})
            driver.emit("frame", step)
        release.set()
    finally:
        release.set()
        bridge.close(5.0)

    events = collector.of_type("event")
    jobs = [e["data"] for e in events if e["event"] == "interpolated_data"]
    assert [j["step"] for j in jobs if j["name"] == "a"] == list(range(60))
    assert [j["step"] for j in jobs if j["name"] == "b"] == list(range(60))
    assert [e["data"] for e in events if e["event"] == "frame"] == [-1, 59]


def test_sigterm_during_a_request_still_shuts_down() -> None:
    assert not issubclass(_TerminateError, Exception)
    collector = Collector()
    bridge = Bridge(collector, drivers=[Source])

    def interrupted(request: dict[str, Any]) -> None:
        raise _TerminateError

    bridge.handle = interrupted  # type: ignore[method-assign]
    assert bridge.run(iter([b'{"type": "ping", "id": "1"}', b'{"type": "ping", "id": "2"}'])) == 0
    assert bridge._closed


def test_close_fits_its_budget_when_a_driver_hangs(make_bridge: BridgeFactory) -> None:
    assert CLOSE_BUDGET_S < 10.0  # Node sends SIGKILL after 10 s.
    bridge, collector = make_bridge([Source, Stubborn], stop_timeout_s=30.0)
    assert _start(bridge, collector, "1", "stubborn")["ok"]
    assert _start(bridge, collector, "2", "source")["ok"]
    _send(bridge, "3", type="execute", instance="app", driver="source", action="wait")

    started = time.monotonic()
    bridge.close(timeout=1.5)
    assert time.monotonic() - started < 2.5
    # The healthy driver still stopped cleanly and was reported.
    assert collector.states("app", "source")[-1] == "available"
    Stubborn.gate.set()
    Source.gate.set()


def test_requests_queued_at_shutdown_do_not_start_drivers(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Source, SlowStart])
    _send(bridge, "1", type="start-driver", instance="app", driver="slow_start")
    collector.wait_for(lambda m: m.get("type") == "driver-state" and m.get("state") == "starting")
    _send(bridge, "2", type="start-driver", instance="app", driver="source")
    SlowStart.gate.set()
    bridge.close(timeout=5.0)
    assert not collector.result("2")["ok"]
    assert "shutting down" in collector.result("2")["error"]
    assert bridge._instances == {}


class AudioConsumer(BaseDriver):
    name = "audio_consumer"
    dependencies = ("source",)
    subscribed = (("source", "value"),)
    subscription_queue_size = 3
    loop_interval_s = None
    gate: ClassVar[threading.Event] = threading.Event()
    received: ClassVar[list[Any]] = []

    def on_data(self, driver: str, event: str, data: Any) -> None:
        type(self).gate.wait(5.0)
        type(self).received.append(data)


def test_queued_subscriptions_keep_order_and_drop_the_oldest_when_full(
    make_bridge: BridgeFactory,
) -> None:
    AudioConsumer.gate = threading.Event()
    AudioConsumer.received = []
    bridge, collector = make_bridge([Source, AudioConsumer])
    try:
        assert _start(bridge, collector, "1", "source")["ok"]
        assert _start(bridge, collector, "2", "audio_consumer")["ok"]
        source = bridge._instances[("app", "source")].driver

        source.emit("value", 0)
        deadline = time.monotonic() + 5.0
        worker = bridge._instances[("app", "audio_consumer")].driver._subscriptions[("source", "value")]
        assert isinstance(worker, BoundedQueueWorker)
        while worker._queue and time.monotonic() < deadline:
            time.sleep(0.01)
        for value in range(1, 6):
            source.emit("value", value)
        AudioConsumer.gate.set()

        deadline = time.monotonic() + 5.0
        while len(AudioConsumer.received) < 4 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert AudioConsumer.received == [0, 3, 4, 5]
        warning = collector.wait_for(lambda m: m.get("type") == "log" and "queue is full" in m["message"])
        assert warning["instance"] == "app"
        metric = collector.wait_for(
            lambda m: m.get("type") == "performance" and m["metric"] == "subscription_dropped", 3.0
        )
        assert metric["count"] == 2
    finally:
        AudioConsumer.gate.set()


def test_bounded_queue_worker_delivers_every_value_in_order() -> None:
    received: list[int] = []
    done = threading.Event()

    def consume(value: int) -> None:
        received.append(value)
        if value == 99:
            done.set()

    worker = BoundedQueueWorker(consume, name="bridge:test-queue", maxsize=100)
    try:
        for value in range(100):
            worker.offer(value)
        assert done.wait(5.0)
    finally:
        worker.close()
        assert worker.join(5.0)
    assert received == list(range(100))


def test_audio_and_sequence_consumers_queue_their_inputs() -> None:
    from gosai_py.drivers.ball import BallDriver
    from gosai_py.drivers.frequency_analysis import FrequencyAnalysisDriver
    from gosai_py.drivers.hand_pose import HandPoseDriver
    from gosai_py.drivers.slr import SLRDriver
    from gosai_py.drivers.speech_activity_detection import SpeechActivityDriver

    for cls in (FrequencyAnalysisDriver, SpeechActivityDriver, SLRDriver):
        assert cls.subscription_queue_size, cls.name
    for cls in (BallDriver, HandPoseDriver):
        assert cls.subscription_queue_size is None, cls.name
