from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import msgspec
import pytest

from conftest import BridgeFactory
from gosai_py import schemas
from gosai_py.driver import BaseDriver, Event, action
from gosai_py.drivers import builtin_driver_classes
from gosai_py.drivers.heartbeat import HeartbeatDriver


def _builtin() -> list[type[BaseDriver]]:
    def fail(module: str, exc: Exception) -> None:
        raise AssertionError(f"drivers.{module} failed to import: {exc!r}")

    return builtin_driver_classes(fail)


@pytest.mark.parametrize("cls", _builtin(), ids=lambda cls: cls.name)
def test_builtin_drivers_describe_every_event_and_action(cls: type[BaseDriver]) -> None:
    assert isinstance(cls.events, Mapping), "events must map names to Event"
    assert set(cls.stream_events) <= set(cls.events)
    assert set(cls.buffered_events) <= set(cls.events)
    specs = cls.action_specs()
    assert list(specs) == list(cls.actions), "every action must be an @action method"
    for spec in specs.values():
        assert spec.description, f"{cls.name}.{spec.name} needs a description"
        assert spec.result is not Any
    for name, event in cls.events.items():
        assert event.description, f"{cls.name}.{name} needs a description"

    schema = schemas.driver_schema(cls)

    assert list(schema["events"]) == list(cls.events)
    assert list(schema["actions"]) == list(cls.actions)
    assert all("." not in name for name in schema["$defs"]), "type names collide"
    encoded = msgspec.json.encode(schemas.describe_driver(cls))
    assert msgspec.json.decode(encoded)["schema"] == schema


def test_schema_shape() -> None:
    schema = schemas.driver_schema(HeartbeatDriver)

    assert schema == {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "config": None,
        "events": {
            "tick": {
                "description": "Every half second, with a running count.",
                "delivery": "ordered",
                "payload": {"$ref": "#/$defs/TickPayload"},
            }
        },
        "actions": {
            "echo": {
                "description": "Return the data unchanged, with the current tick count.",
                "params": {},
                "result": {"$ref": "#/$defs/EchoResult"},
                "requires_instance": True,
            }
        },
        "$defs": {
            "EchoResult": {
                "title": "EchoResult",
                "type": "object",
                "properties": {"echoed": {}, "count": {"type": "integer"}},
                "required": ["echoed", "count"],
            },
            "TickPayload": {
                "title": "TickPayload",
                "type": "object",
                "properties": {"count": {"type": "integer"}, "now": {"type": "number"}},
                "required": ["count", "now"],
            },
        },
    }


class Settings(msgspec.Struct, kw_only=True):
    level: int = 1


class Levels(msgspec.Struct, kw_only=True):
    level: int


class Declared(BaseDriver):
    name = "declared"
    events = {"level": Event(Levels, "Current level.")}  # noqa: RUF012
    config_type = Settings
    loop_interval_s = None

    def __init__(self, context: Any) -> None:
        super().__init__(context)
        self.level = 0

    def configure(self, config: Settings) -> None:
        self.level = config.level

    @action("Set the level.")
    def set_level(self, level: int) -> Levels:
        self.level = level
        return Levels(level=level)

    @action("Reset the level.")
    def reset(self) -> None:
        self.level = 0

    @action("Always available.", requires_instance=False)
    @staticmethod
    def version() -> str:
        return "1"


class Legacy(BaseDriver):
    name = "legacy"
    events = ("ping",)
    actions = ("poke",)

    def execute(self, action: str, data: Any) -> Any:
        return data


def test_actions_decode_params_and_encode_results() -> None:
    driver = Declared(None)  # type: ignore[arg-type]
    driver.apply_config({"level": "3"})
    assert driver.level == 3
    assert Declared.actions == ("set_level", "reset", "version")
    assert driver.execute("set_level", "7") == {"level": 7}
    assert driver.execute("reset", {"ignored": True}) is None and driver.level == 0
    with pytest.raises(msgspec.ValidationError, match="Expected `int`"):
        driver.execute("set_level", "high")

    schema = schemas.driver_schema(Declared)
    assert schema["config"] == {"$ref": "#/$defs/Settings"}
    assert schema["actions"]["reset"]["params"] is None
    assert schema["actions"]["reset"]["result"] == {"type": "null"}
    assert schema["actions"]["version"]["requires_instance"] is False


def test_undeclared_types_get_empty_schemas() -> None:
    schema = schemas.driver_schema(Legacy)
    assert schema["events"]["ping"] == {"description": "", "delivery": "ordered", "payload": {}}
    assert schema["actions"]["poke"]["params"] == {}


def test_action_decorator_rejects_the_wrong_kind_of_method() -> None:
    with pytest.raises(TypeError, match="staticmethod or classmethod"):
        action("x", requires_instance=False)(lambda self: None)


def test_list_drivers_reply_carries_schemas_and_static_actions_run_without_an_instance(
    make_bridge: BridgeFactory,
) -> None:
    bridge, collector = make_bridge([Declared, Legacy])

    bridge.handle({"type": "list-drivers", "id": "1"})
    bridge.handle({"type": "execute", "id": "2", "driver": "declared", "action": "version"})
    bridge.handle({"type": "execute", "id": "3", "driver": "declared", "action": "set_level", "data": 1})

    drivers = {d["name"]: d for d in collector.result("1")["data"]["drivers"]}
    assert drivers["declared"]["schema"] == msgspec.json.decode(
        msgspec.json.encode(schemas.driver_schema(Declared))
    )
    assert drivers["legacy"]["events"] == ["ping"]
    assert collector.result("2") == {"type": "result", "id": "2", "ok": True, "data": "1"}
    assert "not running" in collector.result("3")["error"]


def test_dump_prints_every_builtin_driver(capsysbinary: pytest.CaptureFixture[bytes]) -> None:
    assert schemas.main() == 0
    output = msgspec.json.decode(capsysbinary.readouterr().out)
    names = [d["name"] for d in output["drivers"]]
    assert names == sorted(cls.name for cls in _builtin())
    assert output["drivers"][names.index("ball")]["schema"]["$defs"]["Ball"]["required"] == [
        "x",
        "y",
        "diameter",
        "vx",
        "vy",
    ]


class Opaque:
    pass


class Undescribable(BaseDriver):
    name = "undescribable"

    @action("Takes something msgspec can't describe.")
    def take(self, value: Opaque) -> None:
        pass


def test_a_driver_without_a_schema_still_lists(make_bridge: BridgeFactory) -> None:
    bridge, collector = make_bridge([Undescribable, Legacy])

    bridge.handle({"type": "list-drivers", "id": "1"})

    drivers = {d["name"]: d for d in collector.result("1")["data"]["drivers"]}
    assert drivers["undescribable"]["schema"] is None
    assert drivers["undescribable"]["actions"] == ["take"]
    assert drivers["legacy"]["schema"] is not None
    collector.wait_for(lambda m: m.get("type") == "log" and "cannot describe undescribable" in m["message"])


def test_event_delivery_matches_the_bridge() -> None:
    from gosai_py.drivers.camera import CameraDriver
    from gosai_py.drivers.microphone import MicrophoneDriver

    camera_events = schemas.driver_schema(CameraDriver)["events"]
    microphone_events = schemas.driver_schema(MicrophoneDriver)["events"]

    assert camera_events["color"]["delivery"] == "latest"
    assert camera_events["frame_size"]["delivery"] == "ordered"
    assert "queue_size" not in camera_events["frame_size"]
    assert microphone_events["audio_stream"]["delivery"] == "buffered"
    assert microphone_events["audio_stream"]["queue_size"] == 64


def test_documented_input_conversions() -> None:
    from gosai_py.drivers.interpolate import InterpolateDriver

    driver = Declared(None)  # type: ignore[arg-type]
    assert driver.execute("set_level", 3.0) == {"level": 3}
    with pytest.raises(msgspec.ValidationError, match="got `float`"):
        driver.execute("set_level", 3.5)
    with pytest.raises(msgspec.ValidationError, match="got `null`"):
        driver.execute("set_level", None)
    with pytest.raises(msgspec.ValidationError, match=r"Expected `str \| null`, got `object`"):
        InterpolateDriver(None).execute("reset", {"name": "p"})  # type: ignore[arg-type]
