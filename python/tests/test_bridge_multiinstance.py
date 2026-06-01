"""Multi-instance / binding behaviour of the Python bridge.

The bridge keeps drivers, subscriptions, and events keyed by an `(instance,
name)` pair so two app bindings can run the same driver class against different
physical devices without interfering. Node picks the instance namespace (an app
slug for exclusive drivers, or `shared`/`shared:dev<n>` for shareable ones); here
we drive the bridge directly and assert the isolation it provides.
"""

from __future__ import annotations

from typing import Any

from gosai_py.bridge import Bridge
from gosai_py.driver import BaseDriver


class FakeCamera(BaseDriver):
    name = "fakecam"
    events = ("frame",)
    actions = ("noop",)
    dependencies = ()
    loop_interval_s = None  # callback-only: no background loop in tests
    shared = False

    def execute(self, action: str, data: Any) -> Any:
        return {"echo": data}


class FakeSpeaker(BaseDriver):
    name = "fakespk"
    events = ("level",)
    dependencies = ()
    loop_interval_s = None
    shared = True


class FakeProc(BaseDriver):
    name = "fakeproc"
    events = ("out",)
    dependencies = ("fakecam",)
    loop_interval_s = None
    shared = False


def _make_bridge() -> tuple[Bridge, list[dict[str, Any]]]:
    bridge = Bridge()
    collected: list[dict[str, Any]] = []

    def _capture(msg: dict[str, Any]) -> None:
        collected.append(msg)

    bridge._write = _capture  # type: ignore[method-assign]
    bridge._driver_classes = {
        FakeCamera.name: FakeCamera,
        FakeSpeaker.name: FakeSpeaker,
        FakeProc.name: FakeProc,
    }
    return bridge, collected


def _events(collected: list[dict[str, Any]], instance: str | None = None) -> list[dict[str, Any]]:
    out = [m for m in collected if m.get("type") == "event"]
    if instance is not None:
        out = [m for m in out if m.get("instance") == instance]
    return out


def test_exclusive_driver_gets_one_instance_per_binding() -> None:
    bridge, _ = _make_bridge()
    bridge.handle({"type": "start-driver", "id": "1", "instance": "appA", "driver": "fakecam"})
    bridge.handle({"type": "start-driver", "id": "2", "instance": "appB", "driver": "fakecam"})

    a = bridge._driver_instances[("appA", "fakecam")]
    b = bridge._driver_instances[("appB", "fakecam")]
    assert a is not b

    bridge.handle({"type": "stop-driver", "id": "3", "instance": "appA", "driver": "fakecam"})
    assert ("appA", "fakecam") not in bridge._driver_instances
    assert ("appB", "fakecam") in bridge._driver_instances


def test_events_are_tagged_with_their_instance() -> None:
    bridge, collected = _make_bridge()
    bridge.handle({"type": "start-driver", "id": "1", "instance": "appA", "driver": "fakecam"})
    bridge.handle({"type": "start-driver", "id": "2", "instance": "appB", "driver": "fakecam"})
    bridge.handle(
        {"type": "subscribe", "id": "3", "instance": "appA", "driver": "fakecam", "event": "*"}
    )
    bridge.handle(
        {"type": "subscribe", "id": "4", "instance": "appB", "driver": "fakecam", "event": "*"}
    )

    bridge._driver_instances[("appA", "fakecam")].emit("frame", {"n": 1})

    evts = _events(collected)
    assert len(evts) == 1
    assert evts[0]["instance"] == "appA"
    assert evts[0]["driver"] == "fakecam"
    assert _events(collected, "appB") == []


def test_unsubscribed_instance_receives_no_events() -> None:
    bridge, collected = _make_bridge()
    bridge.handle({"type": "start-driver", "id": "1", "instance": "appA", "driver": "fakecam"})
    # No external subscribe for appA, so an emit must not be forwarded to Node.
    bridge._driver_instances[("appA", "fakecam")].emit("frame", {"n": 1})
    assert _events(collected) == []


def test_shared_instance_refcounts_subscribers() -> None:
    bridge, collected = _make_bridge()
    # Node sends the same `shared` namespace for every binding on a shared driver.
    bridge.handle({"type": "start-driver", "id": "1", "instance": "shared", "driver": "fakespk"})
    bridge.handle({"type": "start-driver", "id": "2", "instance": "shared", "driver": "fakespk"})
    assert sum(1 for k in bridge._driver_instances if k[1] == "fakespk") == 1

    bridge.handle(
        {"type": "subscribe", "id": "3", "instance": "shared", "driver": "fakespk", "event": "*"}
    )
    bridge.handle(
        {"type": "subscribe", "id": "4", "instance": "shared", "driver": "fakespk", "event": "*"}
    )
    assert bridge._external_subscribers[("shared", "fakespk", "*")] == 2

    bridge.handle(
        {"type": "unsubscribe", "id": "5", "instance": "shared", "driver": "fakespk", "event": "*"}
    )
    collected.clear()
    bridge._driver_instances[("shared", "fakespk")].emit("level", {"rms": 0.2})
    assert len(_events(collected)) == 1  # one subscriber still attached

    bridge.handle(
        {"type": "unsubscribe", "id": "6", "instance": "shared", "driver": "fakespk", "event": "*"}
    )
    collected.clear()
    bridge._driver_instances[("shared", "fakespk")].emit("level", {"rms": 0.2})
    assert _events(collected) == []  # no subscribers left


def test_dependencies_start_within_same_instance() -> None:
    bridge, _ = _make_bridge()
    bridge.handle({"type": "start-driver", "id": "1", "instance": "appA", "driver": "fakeproc"})
    assert ("appA", "fakeproc") in bridge._driver_instances
    assert ("appA", "fakecam") in bridge._driver_instances  # dependency in same namespace
    assert ("appB", "fakecam") not in bridge._driver_instances


def test_get_data_and_execute_are_instance_scoped() -> None:
    bridge, collected = _make_bridge()
    bridge.handle({"type": "start-driver", "id": "1", "instance": "appA", "driver": "fakecam"})
    bridge.handle({"type": "start-driver", "id": "2", "instance": "appB", "driver": "fakecam"})
    bridge._driver_instances[("appA", "fakecam")].emit("frame", {"who": "A"})
    bridge._driver_instances[("appB", "fakecam")].emit("frame", {"who": "B"})

    collected.clear()
    bridge.handle(
        {"type": "get-data", "id": "3", "instance": "appA", "driver": "fakecam", "event": "frame"}
    )
    result = next(m for m in collected if m.get("type") == "result" and m.get("id") == "3")
    assert result["data"] == {"who": "A"}

    collected.clear()
    bridge.handle(
        {
            "type": "execute",
            "id": "4",
            "instance": "appB",
            "driver": "fakecam",
            "action": "noop",
            "data": 7,
        }
    )
    result = next(m for m in collected if m.get("type") == "result" and m.get("id") == "4")
    assert result["ok"] is True
    assert result["data"] == {"echo": 7}


def test_list_drivers_reports_shared_flag() -> None:
    bridge, collected = _make_bridge()
    bridge.handle({"type": "list-drivers", "id": "1"})
    result = next(m for m in collected if m.get("type") == "result")
    by_name = {d["name"]: d for d in result["data"]["drivers"]}
    assert by_name["fakecam"]["shared"] is False
    assert by_name["fakespk"]["shared"] is True
