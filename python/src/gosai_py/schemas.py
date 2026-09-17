"""Driver descriptions and their JSON Schema.

`describe_driver(cls)` builds the entry the bridge returns for each driver in
its `list-drivers` reply:

    {
      "name": str, "description": str, "events": [str], "actions": [str],
      "dependencies": [str], "shared": bool,
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "config": <schema> | null,
        "events": {<event>: {"description": str, "stream": bool, "payload": <schema>}},
        "actions": {<action>: {"description": str, "params": <schema> | null,
                               "result": <schema>, "requires_instance": bool}},
        "$defs": {<name>: <schema>}
      }
    }

`$ref`s point at `#/$defs/<name>` inside the same `schema` object. `params` is
null when the action takes no data. Events and actions declared without types
get the empty schema `{}`. `schema` is null when a driver's types can't be
turned into JSON Schema; the bridge logs why.

Run `python -m gosai_py.schemas` to print `{"drivers": [...]}` for every
built-in driver, in the same shape.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from functools import cache
from typing import Any

import msgspec

from gosai_py.driver import BaseDriver
from gosai_py.drivers import builtin_driver_classes

JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"


@cache
def driver_schema(cls: type[BaseDriver]) -> dict[str, Any]:
    events = cls.events
    event_payloads = [
        events[name].payload if isinstance(events, Mapping) else Any for name in events
    ]
    specs = cls.action_specs()
    action_names = list(cls.actions)
    params = [specs[name].params if name in specs else Any for name in action_names]
    results = [specs[name].result if name in specs else Any for name in action_names]
    types: list[Any] = [cls.config_type or Any, *event_payloads]
    types += [Any if p is None else p for p in params]
    types += results
    schemas, defs = msgspec.json.schema_components(types, ref_template="#/$defs/{name}")
    config_schema, *rest = schemas
    event_schemas = rest[: len(event_payloads)]
    param_schemas = rest[len(event_payloads) : len(event_payloads) + len(params)]
    result_schemas = rest[len(event_payloads) + len(params) :]
    return {
        "$schema": JSON_SCHEMA_DIALECT,
        "config": config_schema if cls.config_type is not None else None,
        "events": {
            name: {
                "description": events[name].description if isinstance(events, Mapping) else "",
                "stream": name in cls.stream_events,
                "payload": schema,
            }
            for name, schema in zip(events, event_schemas, strict=True)
        },
        "actions": {
            name: {
                "description": specs[name].description if name in specs else "",
                "params": None if param is None else param_schema,
                "result": result_schema,
                "requires_instance": specs[name].requires_instance if name in specs else True,
            }
            for name, param, param_schema, result_schema in zip(
                action_names, params, param_schemas, result_schemas, strict=True
            )
        },
        "$defs": defs,
    }


def describe_driver(cls: type[BaseDriver], *, with_schema: bool = True) -> dict[str, Any]:
    """The `list-drivers` entry for `cls`. Without the schema, `schema` is null."""
    return {
        "name": cls.name,
        "description": cls.description,
        "events": list(cls.events),
        "actions": list(cls.actions),
        "dependencies": list(cls.dependencies),
        "shared": bool(cls.shared),
        "schema": driver_schema(cls) if with_schema else None,
    }


def main() -> int:
    failures: list[str] = []

    def on_error(module: str, exc: Exception) -> None:
        failures.append(module)
        print(f"failed to load drivers.{module}: {exc!r}", file=sys.stderr)

    classes = sorted(builtin_driver_classes(on_error), key=lambda cls: cls.name)
    output = {"drivers": [describe_driver(cls) for cls in classes]}
    sys.stdout.buffer.write(msgspec.json.format(msgspec.json.encode(output)) + b"\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
