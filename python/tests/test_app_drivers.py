"""Drivers an app ships: package discovery, the app bridge and the schema dump."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import msgspec
import pytest

from conftest import Collector
from gosai_py import schemas
from gosai_py.app_drivers import (
    AppDriversError,
    app_driver_classes,
    load_package,
    read_app_manifest,
)
from gosai_py.bridge import Bridge

TEMPLATE_APP = Path(__file__).resolve().parents[2] / "templates" / "basic"

COUNTER = '''
from collections.abc import Mapping
from typing import ClassVar

import msgspec

from gosai_py import BaseDriver, Event, action


class Count(msgspec.Struct):
    count: int


class Counter(BaseDriver):
    name = "counter"
    description = "Counts."
    events: ClassVar[Mapping[str, Event]] = {"count": Event(Count, "The count.")}
    loop_interval_s = 0.01

    def __init__(self, context):
        super().__init__(context)
        self.value = 0

    def loop(self):
        self.value += 1
        self.emit("count", Count(self.value))

    @action("Set the count.")
    def reset(self, start: int) -> Count:
        self.value = start
        return Count(start)
'''

DOUBLER = '''
from gosai_py import BaseDriver
from gosai_py.drivers.heartbeat import HeartbeatDriver  # imported, not defined here


class Doubler(BaseDriver):
    name = "doubler"
    events = ("value",)
    dependencies = ("counter",)
    loop_interval_s = None


class Beat(HeartbeatDriver):
    name = "beat"
'''


def make_package(root: Path, modules: dict[str, str]) -> Path:
    """A driver package with a unique name, so tests never share `sys.modules` entries."""
    package = root / f"app_drivers_{uuid.uuid4().hex[:8]}"
    package.mkdir(parents=True)
    for name, source in modules.items():
        (package / name).write_text(source)
    return package


def fail_on_error(module: str, exc: Exception) -> None:
    raise AssertionError(f"{module} failed: {exc!r}")


def test_loads_the_drivers_the_package_defines(tmp_path: Path) -> None:
    package = make_package(
        tmp_path,
        {
            "__init__.py": "",
            "counter.py": COUNTER,
            "doubler.py": DOUBLER,
            "_helpers.py": "raise RuntimeError('private modules are not imported')",
        },
    )

    classes = app_driver_classes(package, fail_on_error)

    # `heartbeat` is imported by doubler.py but not defined in the package.
    assert sorted(cls.name for cls in classes) == ["beat", "counter", "doubler"]


def test_a_broken_module_does_not_hide_the_others(tmp_path: Path) -> None:
    package = make_package(
        tmp_path, {"__init__.py": "", "counter.py": COUNTER, "broken.py": "import nope_missing"}
    )
    errors: list[str] = []

    classes = app_driver_classes(package, lambda module, _exc: errors.append(module))

    assert [cls.name for cls in classes] == ["counter"]
    assert errors == [f"{package.name}.broken"]


def test_refuses_package_names_that_are_taken_or_invalid(tmp_path: Path) -> None:
    (tmp_path / "json").mkdir()
    with pytest.raises(AppDriversError, match="already taken"):
        load_package(tmp_path / "json")
    (tmp_path / "not-a-name").mkdir()
    with pytest.raises(AppDriversError, match="not a Python identifier"):
        load_package(tmp_path / "not-a-name")
    with pytest.raises(AppDriversError, match="not a directory"):
        load_package(tmp_path / "missing")


def test_the_app_bridge_runs_only_the_app_drivers(tmp_path: Path) -> None:
    package = make_package(tmp_path, {"__init__.py": "", "counter.py": COUNTER})
    collector = Collector()
    bridge = Bridge(collector, app_drivers=str(package))
    bridge.start()
    try:
        bridge.start_discovery()

        def request(req_id: str, **fields: Any) -> dict[str, Any]:
            bridge.handle({"id": req_id, **fields})
            return collector.result(req_id)

        listed = request("1", type="list-drivers")
        assert [d["name"] for d in listed["data"]["drivers"]] == ["counter"]

        assert request("2", type="start-driver", instance="app", driver="counter")["ok"]
        assert request("3", type="subscribe", instance="app", driver="counter", event="count")["ok"]
        event = collector.wait_for(lambda m: m.get("type") == "event")
        assert event["driver"] == "counter"
        assert event["data"]["count"] >= 1

        reset = request("4", type="execute", instance="app", driver="counter", action="reset", data=0)
        assert reset["data"] == {"count": 0}
    finally:
        bridge.close(timeout=5.0)


def test_the_app_bridge_reports_a_package_that_fails_to_import(tmp_path: Path) -> None:
    package = make_package(tmp_path, {"__init__.py": "raise ImportError('boom')"})
    collector = Collector()
    bridge = Bridge(collector, app_drivers=str(package))
    bridge.start()
    try:
        bridge.start_discovery()
        bridge.handle({"id": "1", "type": "list-drivers"})
        assert collector.result("1")["data"] == {"drivers": []}
        log = collector.wait_for(lambda m: m.get("type") == "log" and m.get("level") == "error")
        assert "boom" in log["message"]
    finally:
        bridge.close(timeout=5.0)


def write_app(root: Path, drivers: str) -> Path:
    app = root / "app"
    app.mkdir(exist_ok=True)
    manifest = {"slug": "hello-app", "python": {"drivers": drivers}}
    (app / "gosai.app.json").write_text(json.dumps(manifest))
    return app


def test_schema_dump_names_app_drivers_like_the_server(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    package = make_package(
        tmp_path / "app" / "python",
        {"__init__.py": "", "counter.py": COUNTER, "doubler.py": DOUBLER},
    )
    app = write_app(tmp_path, f"python/{package.name}")

    assert schemas.main(["--app", str(app)]) == 0

    dumped = msgspec.json.decode(capsys.readouterr().out)
    by_name = {entry["name"]: entry for entry in dumped["drivers"]}
    assert sorted(by_name) == ["hello-app/beat", "hello-app/counter", "hello-app/doubler"]
    assert by_name["hello-app/doubler"]["dependencies"] == ["hello-app/counter"]
    counter = by_name["hello-app/counter"]["schema"]
    assert counter["events"]["count"]["payload"] == {"$ref": "#/$defs/Count"}
    assert counter["actions"]["reset"]["params"] == {"type": "integer"}


def test_schema_dump_rejects_a_manifest_without_drivers(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    app = tmp_path / "app"
    app.mkdir()
    (app / "gosai.app.json").write_text(json.dumps({"slug": "hello-app"}))
    assert schemas.main(["--app", str(app)]) == 1
    assert "python.drivers" in capsys.readouterr().err


def test_manifest_driver_path_stays_inside_the_app(tmp_path: Path) -> None:
    app = write_app(tmp_path, "../elsewhere")
    with pytest.raises(AppDriversError, match="inside the app"):
        read_app_manifest(app)


def test_the_template_example_driver_describes_itself() -> None:
    package = TEMPLATE_APP / "python" / "hello_gosai_drivers"
    classes = app_driver_classes(package, fail_on_error)
    assert [cls.name for cls in classes] == ["counter"]
    schema = schemas.driver_schema(classes[0])
    assert list(schema["events"]) == ["count"]
    assert schema["actions"]["reset"]["params"] == {"type": "integer"}
