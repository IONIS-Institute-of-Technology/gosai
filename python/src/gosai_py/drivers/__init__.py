"""Built-in drivers. The bridge imports every module here and registers the drivers in it."""

from __future__ import annotations

import pkgutil
from collections.abc import Callable
from importlib import import_module
from types import ModuleType

from gosai_py.driver import BaseDriver


def driver_classes_in(module: ModuleType) -> list[type[BaseDriver]]:
    """Every named BaseDriver subclass defined or imported in `module`."""
    return [
        attr
        for attr in vars(module).values()
        if isinstance(attr, type)
        and issubclass(attr, BaseDriver)
        and attr is not BaseDriver
        and attr.name
    ]


def builtin_driver_classes(
    on_error: Callable[[str, Exception], None],
) -> list[type[BaseDriver]]:
    """Import every built-in driver module. Modules that fail go to `on_error`."""
    classes: dict[str, type[BaseDriver]] = {}
    for module_info in pkgutil.iter_modules(__path__):
        if module_info.name.startswith("_"):
            continue
        try:
            module = import_module(f"{__name__}.{module_info.name}")
        except Exception as exc:
            on_error(module_info.name, exc)
            continue
        for cls in driver_classes_in(module):
            classes[cls.name] = cls
    return list(classes.values())
