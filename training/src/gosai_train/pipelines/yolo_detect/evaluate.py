"""Evaluate trained weights on the merged test split and the golden set.

The golden set (<model>/data/golden/images + labels) is your own-camera
footage, labelled and NEVER trained on -- it is the number that matters for
the real rig. Alongside mAP/P/R, this reports the false-positive rate on
negative-only images (frames with no ball), which is the metric that matches
"the detector fires on pockets / glare".

Use it to compare runs or base models:

    gosai-train eval                       # latest best.pt
    gosai-train eval --weights runs/ball-20260720-090000/weights/best.pt
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, find_latest, iter_images, load_yaml, save_yaml


def _empty_label(label: Path) -> bool:
    return not label.exists() or not label.read_text().strip()


def _golden_data_yaml(ctx: ModelContext) -> Path:
    path = ctx.golden_dir / "data.yaml"
    save_yaml(
        path,
        {
            "path": str(ctx.golden_dir.resolve()),
            "train": "images",  # unused, required key
            "val": "images",
            "nc": 1,
            "names": [ctx.class_name],
        },
    )
    return path


def _negative_only_images(ctx: ModelContext) -> list[Path]:
    """No-ball images from the merged test split and the golden set."""
    out: list[Path] = []
    test_images = ctx.merged_dir / "test" / "images"
    for image in iter_images(test_images):
        if _empty_label(ctx.merged_dir / "test" / "labels" / (image.stem + ".txt")):
            out.append(image)
    for image in iter_images(ctx.golden_dir / "images"):
        if _empty_label(ctx.golden_dir / "labels" / (image.stem + ".txt")):
            out.append(image)
    return out


def _val_row(model: Any, name: str, data: Path, split: str,
             imgsz: int, device: str) -> tuple[str, ...] | None:
    try:
        metrics = model.val(data=str(data), split=split, imgsz=imgsz,
                            device=device, verbose=False)
    except Exception as exc:  # pragma: no cover
        console.print(f"[yellow]warn[/] {name}: validation failed: {exc!r}")
        return None
    box = getattr(metrics, "box", None)
    if box is None:
        return None
    return (name, f"{box.map50:.3f}", f"{box.map:.3f}", f"{box.mp:.3f}", f"{box.mr:.3f}")


def run(ctx: ModelContext, args: Any = None) -> None:
    weights = getattr(args, "weights", None)
    if weights is None:
        latest = find_latest(ctx.runs_dir, "best.pt")
        if latest is None:
            raise SystemExit("no trained weights found; run `gosai-train train` first")
        weights = str(latest)
    conf = float(getattr(args, "conf", 0.25) or 0.25)

    cfg = load_yaml(ctx.train_config)
    raw_imgsz = cfg.get("infer_imgsz") or cfg.get("imgsz", 640)
    imgsz = max(int(v) for v in raw_imgsz) if isinstance(raw_imgsz, (list, tuple)) else int(raw_imgsz)
    device = resolve_device(cfg.get("device", "auto"))

    weights_path = Path(weights)
    from datetime import datetime

    if weights_path.exists():
        trained_at = datetime.fromtimestamp(weights_path.stat().st_mtime)
        console.print(f"[cyan]eval[/] {weights_path} (trained {trained_at:%Y-%m-%d %H:%M})")

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(weights)

    rows: list[tuple[str, ...]] = []
    merged_yaml = ctx.merged_dir / "data.yaml"
    if merged_yaml.exists() and any(iter_images(ctx.merged_dir / "test" / "images")):
        row = _val_row(model, "merged test", merged_yaml, "test", imgsz, device)
        if row:
            rows.append(row)
    else:
        console.print("[dim]merged test split not found (run `prepare`); skipping[/]")

    golden_labelled = [
        p for p in iter_images(ctx.golden_dir / "images")
        if not _empty_label(ctx.golden_dir / "labels" / (p.stem + ".txt"))
    ]
    if golden_labelled:
        row = _val_row(model, "golden", _golden_data_yaml(ctx), "val", imgsz, device)
        if row:
            rows.append(row)
    else:
        console.print(
            f"[dim]no labelled golden set at {ctx.golden_dir}/images + labels; skipping. "
            "Build one from your rig's footage -- it is the metric that matters.[/]"
        )

    if rows:
        from rich.table import Table

        table = Table(show_edge=False)
        for col in ("set", "mAP50", "mAP50-95", "P", "R"):
            table.add_column(col, justify="right" if col != "set" else "left")
        for row in rows:
            table.add_row(*row)
        console.print(table)

    # False positives on negative-only images: the "fires on pockets / glare" metric.
    negatives = _negative_only_images(ctx)
    if negatives:
        fired = boxes = 0
        results = model.predict(
            source=[str(p) for p in negatives], conf=conf, device=device,
            stream=True, verbose=False,
        )
        for result in results:
            n = len(result.boxes)
            if n:
                fired += 1
                boxes += n
        pct = 100.0 * fired / len(negatives)
        colour = "green" if pct < 2 else "yellow" if pct < 10 else "red"
        console.print(
            f"[cyan]false positives[/] (conf>={conf}): "
            f"[{colour}]{fired}/{len(negatives)} no-ball images fired ({pct:.1f}%)[/], "
            f"{boxes} boxes total"
        )
    else:
        console.print("[dim]no negative-only images available for FP check[/]")
