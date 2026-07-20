"""YOLO single/multi-class object-detection training pipeline.

Stages operate on a :class:`~gosai_train.context.ModelContext` so the same code
serves any number of models. Each stage exposes ``run(ctx, args)``.
"""

from __future__ import annotations

from typing import Any

from . import autolabel, download, export, frames, install, negatives, prepare, train


def run_all(ctx: Any, args: Any = None) -> None:
    download.run(ctx, args)
    negatives.run(ctx, args)
    prepare.run(ctx, args)
    train.run(ctx, args)
    export.run(ctx, args)
    install.run(ctx, args)


# Command name -> callable(ctx, args). Drives the CLI for this model type.
COMMANDS = {
    "download": download.run,
    "negatives": negatives.run,
    "prepare": prepare.run,
    "frames": frames.run,
    "autolabel": autolabel.run,
    "train": train.run,
    "export": export.run,
    "install": install.run,
    "all": run_all,
}
