"""YOLO object-detection training pipeline.

Stages operate on a :class:`~gosai_train.context.ModelContext` so the same code
serves any number of models. Each stage exposes ``run(ctx, args)``.
"""

from __future__ import annotations

from argparse import Namespace

from ...context import ModelContext
from . import (
    autolabel,
    download,
    evaluate,
    export,
    frames,
    install,
    mine,
    negatives,
    prepare,
    train,
)


def run_all(ctx: ModelContext, args: Namespace) -> None:
    download.run(ctx, args)
    negatives.run(ctx, args)
    prepare.run(ctx, args)
    weights = train.run(ctx, args)
    export.run(ctx, Namespace(formats=args.formats, weights=str(weights)))
    install.run(ctx, Namespace(src=None))


COMMANDS = {
    "download": download.run,
    "negatives": negatives.run,
    "prepare": prepare.run,
    "frames": frames.run,
    "autolabel": autolabel.run,
    "train": train.run,
    "eval": evaluate.run,
    "mine": mine.run,
    "export": export.run,
    "install": install.run,
    "all": run_all,
}
