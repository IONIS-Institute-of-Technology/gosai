"""Map a model `type` (from model.yaml) to its training pipeline.

To add a new kind of model (for example a pose or classification trainer), add a
pipeline package under ``pipelines/`` that exposes a ``COMMANDS`` dict and register
its type here.
"""

from __future__ import annotations

import importlib
from types import ModuleType

PIPELINES = {"yolo-detect": "gosai_train.pipelines.yolo_detect"}


def get_pipeline(model_type: str) -> ModuleType:
    module = PIPELINES.get(model_type)
    if module is None:
        raise SystemExit(
            f"no training pipeline registered for model type {model_type!r}. "
            f"Known types: {', '.join(sorted(PIPELINES))}"
        )
    return importlib.import_module(module)
