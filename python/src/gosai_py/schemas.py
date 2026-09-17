"""Driver descriptions and their JSON Schema.

`describe_driver(cls)` builds the entry the bridge returns for each driver in
its `list-drivers` reply:

    {
      "name": str, "description": str, "events": [str], "actions": [str],
      "dependencies": [str], "shared": bool,
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "config": <schema> | null,
        "events": {<event>: {"description": str, "delivery": "latest" | "buffered" | "ordered",
                             "queue_size": int (buffered only), "payload": <schema>}},
        "actions": {<action>: {"description": str, "params": <schema> | null,
                               "result": <schema>, "requires_instance": bool}},
        "$defs": {<name>: <schema>}
      }
    }

`delivery` says how the bridge sends an event to Node when Node reads slowly:
`latest` keeps only the newest value (`stream_events`), `buffered` keeps up to
`queue_size` values and drops the oldest (`buffered_events`), and `ordered`
sends every value.

`$ref`s point at `#/$defs/<name>` inside the same `schema` object. Resolve
each driver's schema on its own: `$defs` names repeat across drivers with
different contents (`DeviceResult`, `SignPayload`), so never merge them. `params` is
null when the action takes no data. Events and actions declared without types
get the empty schema `{}`. `schema` is null when a driver's types can't be
turned into JSON Schema; the bridge logs why.

Run `python -m gosai_py.schemas` to print `{"drivers": [...]}` for every
built-in driver, in the same shape. `python -m gosai_py.schemas --app <app dir>`
prints an app's own drivers instead, named `<app slug>/<driver>` as the server
names them. Run it with the app's requirements installed, for example in the
environment GOSAI built for the app.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping, Sequence
from functools import cache
from typing import Any

import msgspec
import msgspec.inspect

from gosai_py.app_drivers import (
    AppDriversError,
    app_driver_classes,
    qualified_name,
    read_app_manifest,
)
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
    shared = _referenced_defs([config_schema, *event_schemas, *param_schemas], defs)
    _require_defaulted_result_fields(results, defs, shared)
    return {
        "$schema": JSON_SCHEMA_DIALECT,
        "config": config_schema if cls.config_type is not None else None,
        "events": {
            name: {
                "description": events[name].description if isinstance(events, Mapping) else "",
                **_delivery(cls, name),
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


def _referenced_defs(schemas: list[Any], defs: dict[str, Any]) -> set[str]:
    """Names of the `$defs` that `schemas` reference, directly or through other defs."""
    found: set[str] = set()
    pending: list[Any] = list(schemas)
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                name = ref.removeprefix("#/$defs/")
                if name not in found and name in defs:
                    found.add(name)
                    pending.append(defs[name])
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
    return found


def _require_defaulted_result_fields(
    results: list[Any], defs: dict[str, Any], shared: set[str]
) -> None:
    """List struct fields with defaults as required in result-only `$defs`.

    Action results are encoded with `msgspec.to_builtins`, which writes fields
    that have defaults, so a result always carries them. The same struct used
    by the config, a param or an event keeps them optional, because callers
    may leave them out there. Structs with `omit_defaults` and fields without
    any default (such as `UNSET` ones) stay optional too.
    """
    for info in _struct_types(results):
        name = info.cls.__name__
        definition = defs.get(name)
        if (
            definition is None
            or name in shared
            or definition.get("title") != name
            or info.array_like
            or info.cls.__struct_config__.omit_defaults
            or "properties" not in definition
        ):
            continue
        always = {
            field.encode_name
            for field in info.fields
            if field.required
            or field.default is not msgspec.NODEFAULT
            or field.default_factory is not msgspec.NODEFAULT
        }
        required = set(definition.get("required", ())) | always
        definition["required"] = [key for key in definition["properties"] if key in required]


def _struct_types(types: list[Any]) -> list[msgspec.inspect.StructType]:
    """Every Struct type in `types`, including nested ones, once each."""
    found: dict[type, msgspec.inspect.StructType] = {}
    pending: list[Any] = list(msgspec.inspect.multi_type_info(types))
    while pending:
        node = pending.pop()
        if isinstance(node, msgspec.inspect.StructType):
            if node.cls in found:
                continue
            found[node.cls] = node
            pending.extend(field.type for field in node.fields)
        elif isinstance(node, msgspec.inspect.Type):
            for attr in node.__struct_fields__:
                value = getattr(node, attr)
                if isinstance(value, msgspec.inspect.Type):
                    pending.append(value)
                elif isinstance(value, tuple):
                    pending.extend(v for v in value if isinstance(v, msgspec.inspect.Type))
    return list(found.values())


def _delivery(cls: type[BaseDriver], event: str) -> dict[str, Any]:
    if event in cls.stream_events:
        return {"delivery": "latest"}
    if event in cls.buffered_events:
        return {"delivery": "buffered", "queue_size": cls.buffered_events[event]}
    return {"delivery": "ordered"}


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


def describe_app_driver(app: str, cls: type[BaseDriver]) -> dict[str, Any]:
    """`describe_driver` with the names the server uses for an app's drivers."""
    entry = describe_driver(cls)
    entry["name"] = qualified_name(app, cls.name)
    entry["dependencies"] = [qualified_name(app, dep) for dep in cls.dependencies]
    return entry


def main(argv: Sequence[str] = ()) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m gosai_py.schemas",
        description="Print the schemas of the built-in drivers, or of an app's drivers.",
    )
    parser.add_argument("--app", metavar="DIR", help="the app directory, with gosai.app.json")
    args = parser.parse_args(argv)
    failures: list[str] = []

    def on_error(module: str, exc: Exception) -> None:
        failures.append(module)
        print(f"failed to load {module}: {exc!r}", file=sys.stderr)

    if args.app is None:
        classes = sorted(builtin_driver_classes(on_error), key=lambda cls: cls.name)
        output = {"drivers": [describe_driver(cls) for cls in classes]}
    else:
        try:
            slug, package = read_app_manifest(args.app)
        except AppDriversError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        # The app directory may be read-only or signed: keep bytecode out of it
        # unless PYTHONPYCACHEPREFIX sends it elsewhere.
        write_bytecode = sys.dont_write_bytecode
        sys.dont_write_bytecode = write_bytecode or sys.pycache_prefix is None
        try:
            classes = sorted(app_driver_classes(package, on_error), key=lambda cls: cls.name)
        finally:
            sys.dont_write_bytecode = write_bytecode
        output = {"drivers": [describe_app_driver(slug, cls) for cls in classes]}
    sys.stdout.buffer.write(msgspec.json.format(msgspec.json.encode(output)) + b"\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
