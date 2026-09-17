"""Drivers that an app ships.

An app names a package directory in its manifest:

    "python": { "drivers": "python/hello_drivers", "requirements": "python/requirements.txt" }

GOSAI runs the app's drivers in a bridge of their own (`gosai-bridge
--app-drivers <dir>`), inside the app's Python environment. That bridge puts the
package's parent directory first on `sys.path`, imports the package and every
module directly inside it (except names starting with `_`), and registers the
`BaseDriver` subclasses defined there. Subclasses imported from elsewhere, such
as a built-in driver class, only count when the package subclasses them.

Inside the bridge the drivers keep their plain names (`counter`); the server
shows them as `<app slug>/<name>` (`hello-gosai/counter`), and so does
`python -m gosai_py.schemas --app <app dir>`.
"""

from __future__ import annotations

import importlib
import keyword
import pkgutil
import re
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import msgspec

from gosai_py.driver import BaseDriver
from gosai_py.drivers import driver_classes_in

MANIFEST_FILE = "gosai.app.json"

# The names built-in drivers use. The server adds `<app slug>/` in front, and
# `gosai-sdk gen-driver-types` accepts both forms.
DRIVER_NAME = re.compile(r"[a-z][a-z0-9_]*")


class AppDriversError(Exception):
    """The app's driver package can't be found or imported."""


def load_package(directory: str | Path) -> ModuleType:
    """Import the package at `directory`, with its parent directory first on `sys.path`."""
    path = Path(directory).resolve()
    if not path.is_dir():
        raise AppDriversError(f"driver package {path} is not a directory")
    name = path.name
    if not name.isidentifier() or keyword.iskeyword(name):
        raise AppDriversError(f"driver package name {name!r} is not a Python identifier")
    if name == "gosai_py" or name.startswith("gosai_py."):
        raise AppDriversError("the driver package can't be named gosai_py")
    parent = str(path.parent)
    if parent not in sys.path:
        sys.path.insert(0, parent)
    module = importlib.import_module(name)
    locations = [Path(entry).resolve() for entry in getattr(module, "__path__", [])]
    if path not in locations:
        raise AppDriversError(
            f"driver package name {name!r} is already taken by {module.__file__ or module!r}; "
            "rename the package directory"
        )
    return module


def app_driver_classes(
    directory: str | Path,
    on_error: Callable[[str, Exception], None],
) -> list[type[BaseDriver]]:
    """The drivers defined in the package at `directory`. Modules that fail go to `on_error`."""
    try:
        package = load_package(directory)
    except Exception as exc:
        on_error(Path(directory).name, exc)
        return []
    modules = [package]
    for info in pkgutil.iter_modules(package.__path__):
        if info.name.startswith("_"):
            continue
        try:
            modules.append(importlib.import_module(f"{package.__name__}.{info.name}"))
        except Exception as exc:
            on_error(f"{package.__name__}.{info.name}", exc)
    prefix = f"{package.__name__}."
    classes: dict[str, type[BaseDriver]] = {}
    for module in modules:
        for cls in driver_classes_in(module):
            if cls.__module__ != package.__name__ and not cls.__module__.startswith(prefix):
                continue
            problem = _name_problem(cls)
            if problem is not None:
                on_error(f"{cls.__module__}.{cls.__qualname__}", ValueError(problem))
                continue
            classes[cls.name] = cls
    return list(classes.values())


def _name_problem(cls: type[BaseDriver]) -> str | None:
    """Why the driver's name or dependencies can't be used, or None."""
    names = [("name", cls.name), *(("dependency", dep) for dep in cls.dependencies)]
    for kind, value in names:
        if not isinstance(value, str) or DRIVER_NAME.fullmatch(value) is None:
            return (
                f"driver {kind} {value!r} must be lowercase letters, digits and underscores, "
                "starting with a letter, such as my_driver"
            )
    return None


def read_app_manifest(app_dir: str | Path) -> tuple[str, Path]:
    """The slug and the driver package directory named by the app's manifest."""
    root = Path(app_dir).resolve()
    try:
        manifest: Any = msgspec.json.decode((root / MANIFEST_FILE).read_bytes())
    except (OSError, msgspec.DecodeError) as exc:
        raise AppDriversError(f"cannot read {root / MANIFEST_FILE}: {exc}") from exc
    if not isinstance(manifest, dict):
        raise AppDriversError(f"{root / MANIFEST_FILE} is not a JSON object")
    slug = manifest.get("slug")
    python = manifest.get("python")
    drivers = python.get("drivers") if isinstance(python, dict) else None
    if not isinstance(slug, str) or not slug:
        raise AppDriversError(f"{root / MANIFEST_FILE} has no slug")
    if not isinstance(drivers, str) or not drivers:
        raise AppDriversError(f"{root / MANIFEST_FILE} has no python.drivers package")
    package = (root / drivers).resolve()
    if not package.is_relative_to(root):
        raise AppDriversError("python.drivers must stay inside the app directory")
    return slug, package


def qualified_name(app: str, driver: str) -> str:
    """The name the server gives an app's driver: `<app slug>/<driver>`."""
    return f"{app}/{driver}"
