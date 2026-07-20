"""Map a model `type` (from model.yaml) to its training pipeline.

To add a new kind of model (e.g. a pose or classification trainer), implement a
pipeline package under ``pipelines/`` exposing a ``COMMANDS`` dict and register
its type here.
"""

from __future__ import annotations

from types import ModuleType

_YOLO_DETECT_ALIASES = {"yolo-detect", "yolo_detect", "detect", "yolo"}


def get_pipeline(model_type: str) -> ModuleType:
    if model_type in _YOLO_DETECT_ALIASES:
        from .pipelines import yolo_detect

        return yolo_detect
    raise SystemExit(
        f"no training pipeline registered for model type {model_type!r}. "
        f"Known types: {', '.join(sorted(_YOLO_DETECT_ALIASES))}"
    )
