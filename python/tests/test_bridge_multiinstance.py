"""Multi-instance / binding behaviour of the Python bridge.

The bridge keeps drivers, subscriptions, and events keyed by an `(instance,
name)` pair so two app bindings can run the same driver class against different
physical devices without interfering. Node picks the instance namespace (an app
slug for exclusive drivers, or `shared`/`shared:dev<n>` for shareable ones); here
we drive the bridge directly and assert the isolation it provides.
"""

from __future__ import annotations

from typing import Any

from conftest import BridgeFactory
from gosai_py.driver import BaseDriver


class FakeCamera(BaseDriver):
    name = "fakecam"
    events = ("frame",)
    actions = ("noop",)
    loop_interval_s = None  # callback-only: no background loop in tests

    def execute(self, action: str, data: Any) -> Any:
        return {"echo": data}


class FakeSpeaker(BaseDriver):
    name = "fakespk"
    events = ("level",)
    loop_interval_s = None
    shared = True


class FakeProc(BaseDriver):
    name = "fakeproc"
    events = ("out",)
    dependencies = ("fakecam",)
    loop_interval_s = None


DRIVERS = (FakeCamera, FakeSpeaker, FakeProc)


def _request(bridge: Any, collector: Any, req_id: str, **fields: Any) -> dict[str, Any]:
    bridge.handle({"id": req_id, **fields})
    return collector.result(req_id)


def _start(bridge: Any, collector: Any, req_id: str, instance: str, driver: str) -> None:
    reply = _request(
        bridge, collector, req_id, type="start-driver", instance=instance, driver=driver
    )
    assert reply["ok"], reply


def _events(collector: Any, instance: str | None = None) -> list[dict[str, Any]]:
    out = collector.of_type("event")
    if instance is not None:
        out = [m for m in out if m.get("instance") == instance]
    return out


def test_exclusive_driver_gets_one_instance_per_binding(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "appA", "fakecam")
    _start(bridge, collector, "2", "appB", "fakecam")

    a = bridge._instances[("appA", "fakecam")].driver
    b = bridge._instances[("appB", "fakecam")].driver
    assert a is not b

    assert _request(bridge, collector, "3", type="stop-driver", instance="appA", driver="fakecam")[
        "ok"
    ]
    assert ("appA", "fakecam") not in bridge._instances
    assert ("appB", "fakecam") in bridge._instances


def test_events_are_tagged_with_their_instance(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "appA", "fakecam")
    _start(bridge, collector, "2", "appB", "fakecam")
    _request(bridge, collector, "3", type="subscribe", instance="appA", driver="fakecam", event="*")
    _request(bridge, collector, "4", type="subscribe", instance="appB", driver="fakecam", event="*")

    bridge._instances[("appA", "fakecam")].driver.emit("frame", {"n": 1})

    event = collector.wait_for(lambda m: m.get("type") == "event")
    assert event["instance"] == "appA"
    assert event["driver"] == "fakecam"
    assert event["data"] == {"n": 1}
    bridge._writer.close()
    assert _events(collector, "appB") == []


def test_unsubscribed_instance_receives_no_events(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "appA", "fakecam")
    # No external subscribe for appA, so an emit must not be forwarded to Node.
    bridge._instances[("appA", "fakecam")].driver.emit("frame", {"n": 1})
    bridge._writer.close()
    assert _events(collector) == []


def test_subscriptions_are_idempotent_per_event(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "shared", "fakespk")
    # Node reference-counts its own leases and sends one subscribe per event.
    for req_id in ("2", "3"):
        _request(
            bridge,
            collector,
            req_id,
            type="subscribe",
            instance="shared",
            driver="fakespk",
            event="level",
        )
    assert ("shared", "fakespk", "level") in bridge._external_subscriptions

    _request(
        bridge,
        collector,
        "4",
        type="unsubscribe",
        instance="shared",
        driver="fakespk",
        event="level",
    )
    bridge._instances[("shared", "fakespk")].driver.emit("level", {"rms": 0.2})
    bridge._writer.close()
    assert _events(collector) == []


def test_dependencies_must_run_in_the_same_instance(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "appB", "fakecam")

    reply = _request(
        bridge, collector, "2", type="start-driver", instance="appA", driver="fakeproc"
    )
    assert not reply["ok"]
    assert "needs fakecam running first" in reply["error"]
    assert ("appA", "fakeproc") not in bridge._instances

    _start(bridge, collector, "3", "appA", "fakecam")
    _start(bridge, collector, "4", "appA", "fakeproc")


def test_get_data_and_execute_are_instance_scoped(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    _start(bridge, collector, "1", "appA", "fakecam")
    _start(bridge, collector, "2", "appB", "fakecam")
    bridge._instances[("appA", "fakecam")].driver.emit("frame", {"who": "A", "_frame": object()})
    bridge._instances[("appB", "fakecam")].driver.emit("frame", {"who": "B"})

    result = _request(
        bridge, collector, "3", type="get-data", instance="appA", driver="fakecam", event="frame"
    )
    assert result["data"] == {"who": "A"}

    result = _request(
        bridge,
        collector,
        "4",
        type="execute",
        instance="appB",
        driver="fakecam",
        action="noop",
        data=7,
    )
    assert result["ok"] is True
    assert result["data"] == {"echo": 7}


def test_list_drivers_reports_shared_flag(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge(DRIVERS)
    result = _request(bridge, collector, "1", type="list-drivers")
    by_name = {d["name"]: d for d in result["data"]["drivers"]}
    assert by_name["fakecam"]["shared"] is False
    assert by_name["fakespk"]["shared"] is True
    assert by_name["fakeproc"]["dependencies"] == ["fakecam"]
