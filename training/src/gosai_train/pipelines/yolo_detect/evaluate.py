"""Evaluate trained weights on the merged test split and the golden set.

The golden set (<model>/data/golden/images + labels) is your own-camera footage,
labelled and never trained on. It is the number that matters for the real rig.
Alongside mAP/P/R, this reports the false-positive rate on negative-only images
(frames with no ball), the metric behind "the detector fires on pockets or glare".

Use it to compare runs or base models:

    gosai-train eval                       # latest best.pt
    gosai-train eval --weights runs/ball-20260720-090000/weights/best.pt
"""

from __future__ import annotations

from argparse import Namespace
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, iter_images, load_yaml, paths_source, save_yaml
from .sources import read_label_rows
from .weights import infer_size, print_weights, resolve_weights


def _is_negative(labels_dir: Path, image: Path) -> bool:
    return not read_label_rows(labels_dir / f"{image.stem}.txt")


def _golden_data_yaml(ctx: ModelContext) -> Path:
    path = ctx.golden_dir / "data.yaml"
    save_yaml(
        path,
        {
            "path": str(ctx.golden_dir.resolve()),
            "train": "images",  # unused, but Ultralytics requires the key
            "val": "images",
            "nc": 1,
            "names": [ctx.class_name],
        },
    )
    return path


def _val_row(
    model: Any, name: str, data: Path, split: str, imgsz: int, device: str, runs_dir: Path
) -> tuple[str, ...]:
    metrics = model.val(
        data=str(data), split=split, imgsz=imgsz, device=device, verbose=False, plots=False,
        project=str(runs_dir), name="eval", exist_ok=True,
    )
    box = metrics.box
    return (name, f"{box.map50:.3f}", f"{box.map:.3f}", f"{box.mp:.3f}", f"{box.mr:.3f}")


def run(ctx: ModelContext, args: Namespace) -> None:
    weights = resolve_weights(ctx, args.weights)
    cfg = load_yaml(ctx.train_config)
    imgsz = max(infer_size(cfg))
    device = resolve_device(cfg)
    print_weights("eval", weights)

    from ultralytics import YOLO

    model = YOLO(weights)

    test_images = list(iter_images(ctx.merged_dir / "test" / "images"))
    test_labels = ctx.merged_dir / "test" / "labels"
    golden_images = list(iter_images(ctx.golden_dir / "images"))
    golden_labels = ctx.golden_dir / "labels"
    golden_negatives = [p for p in golden_images if _is_negative(golden_labels, p)]

    rows: list[tuple[str, ...]] = []
    merged_yaml = ctx.merged_dir / "data.yaml"
    if merged_yaml.exists() and test_images:
        rows.append(_val_row(model, "merged test", merged_yaml, "test", imgsz, device, ctx.runs_dir))
    else:
        console.print("[dim]merged test split not found (run `prepare`); skipping[/]")

    if len(golden_negatives) < len(golden_images):
        rows.append(_val_row(model, "golden", _golden_data_yaml(ctx), "val", imgsz, device, ctx.runs_dir))
    else:
        console.print(
            f"[dim]no labelled golden set at {ctx.golden_dir}/images + labels; skipping. "
            "Build one from your rig's footage: it is the metric that matters.[/]"
        )

    if rows:
        from rich.table import Table

        table = Table(show_edge=False)
        for col in ("set", "mAP50", "mAP50-95", "P", "R"):
            table.add_column(col, justify="right" if col != "set" else "left")
        for row in rows:
            table.add_row(*row)
        console.print(table)

    negatives = [p for p in test_images if _is_negative(test_labels, p)] + golden_negatives
    if not negatives:
        console.print("[dim]no negative-only images available for FP check[/]")
        return

    fired = boxes = 0
    with paths_source("eval-negatives", negatives) as source:
        results = model.predict(
            source=source, conf=args.conf, device=device, batch=1, stream=True, verbose=False,
        )
        for result in results:
            n = len(result.boxes)
            if n:
                fired += 1
                boxes += n
    pct = 100.0 * fired / len(negatives)
    colour = "green" if pct < 2 else "yellow" if pct < 10 else "red"
    console.print(
        f"[cyan]false positives[/] (conf>={args.conf}): "
        f"[{colour}]{fired}/{len(negatives)} no-ball images fired ({pct:.1f}%)[/], "
        f"{boxes} boxes total"
    )
