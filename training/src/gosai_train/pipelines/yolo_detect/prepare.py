"""Merge all sources into one YOLO dataset in <model>/data/merged.

- Ball-like boxes from every dataset are remapped to class 0.
- Non-ball boxes are dropped; frames left with no ball become negatives.
- data/custom (your labelled footage), data/negatives (drop-in) and
  data/negatives_pool (mined/online) are folded in.
- Negatives are capped to a sane ratio of positives, then split 80/10/10.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, iter_images, load_yaml, save_yaml

SPLIT_ALIASES = {
    "train": "train",
    "training": "train",
    "valid": "val",
    "validation": "val",
    "val": "val",
    "test": "test",
    "testing": "test",
}

_SNOOKER_COLOURS = {
    "red", "yellow", "green", "brown", "blue", "pink", "black", "white",
    "orange", "purple", "maroon",
}
_DROP_KEYWORDS = (
    "table", "pocket", "hole", "rail", "cushion", "stick", "cue", "person",
    "hand", "glove", "arm", "player", "flag", "bag", "marker", "dot",
    "triangle", "rack", "net", "frame", "wall", "floor", "light",
)


def classify_name(name: str) -> str:
    """Classify a source class name as 'keep' (a ball) or 'drop'."""
    n = " ".join(name.strip().lower().replace("-", " ").replace("_", " ").split())
    if not n:
        return "drop"
    if "cue ball" in n or "cueball" in n:
        return "keep"
    if "ball" in n:
        if any(k in n for k in ("table", "pocket", "hole", "rack")):
            return "drop"
        return "keep"
    if re.fullmatch(r"\d{1,2}", n):
        return "keep"
    if n in _SNOOKER_COLOURS:
        return "keep"
    if any(k in n for k in _DROP_KEYWORDS):
        return "drop"
    return "drop"


@dataclass
class _Sample:
    image: Path
    split: str
    prefix: str
    label_lines: list[str] = field(default_factory=list)  # empty == negative


def _assign_split(key: str) -> str:
    """Deterministic 80/10/10 split from a stable hash of the key."""
    digest = hashlib.md5(key.encode()).hexdigest()
    bucket = int(digest[:8], 16) % 10
    if bucket < 8:
        return "train"
    if bucket == 8:
        return "val"
    return "test"


def _dataset_class_names(dataset_dir: Path) -> list[str]:
    data = load_yaml(dataset_dir / "data.yaml")
    names = data.get("names")
    if isinstance(names, dict):
        return [str(names[k]) for k in sorted(names, key=lambda x: int(x))]
    if isinstance(names, list):
        return [str(n) for n in names]
    return []


def _label_for(image: Path) -> Path | None:
    """Find the YOLO label file for an image in a sibling 'labels' dir."""
    label = image.parent.parent / "labels" / (image.stem + ".txt")
    if label.exists():
        return label
    sibling = image.with_suffix(".txt")
    return sibling if sibling.exists() else None


def _to_bbox_line(parts: list[str]) -> str | None:
    """Normalize a YOLO label row to a detection bbox line ``0 cx cy w h``.

    Accepts both bbox rows (4 coords) and segmentation polygons (>=6 coords,
    an even count): polygons are converted to their enclosing box. This keeps
    the merged dataset a pure *detect* dataset even when a source was exported
    as segmentation, avoiding Ultralytics' detect/segment mixed-dataset warning.
    """
    coords = parts[1:]
    try:
        values = [float(v) for v in coords]
    except ValueError:
        return None

    if len(values) == 4:
        cx, cy, w, h = values
    elif len(values) >= 6 and len(values) % 2 == 0:
        xs = values[0::2]
        ys = values[1::2]
        x1, x2 = min(xs), max(xs)
        y1, y2 = min(ys), max(ys)
        cx, cy, w, h = (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1
    else:
        return None

    if w <= 0 or h <= 0:
        return None
    return f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}"


def _remap_lines(label: Path | None, decisions: dict[int, str]) -> list[str]:
    """Keep ball boxes (remapped to class 0); drop the rest. None/empty -> []."""
    if label is None:
        return []
    out: list[str] = []
    for raw in label.read_text().splitlines():
        parts = raw.split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
        except ValueError:
            continue
        if decisions.get(cls, "drop") != "keep":
            continue
        line = _to_bbox_line(parts)
        if line is not None:
            out.append(line)
    return out


def _collect_datasets(
    ctx: ModelContext,
    overrides: dict[str, str],
    discovered: dict[str, str],
    map_all: bool,
):
    positives: list[_Sample] = []
    negatives: list[_Sample] = []
    if not ctx.raw_dir.exists():
        return positives, negatives

    for dataset_dir in sorted(p for p in ctx.raw_dir.iterdir() if p.is_dir()):
        names = _dataset_class_names(dataset_dir)
        decisions: dict[int, str] = {}
        for idx, name in enumerate(names):
            if map_all:
                decision = "keep"
            else:
                decision = overrides.get(name.strip().lower()) or classify_name(name)
            decisions[idx] = decision
            discovered[name] = decision

        kept = sum(1 for d in decisions.values() if d == "keep")
        console.print(
            f"[cyan]{dataset_dir.name}[/]: {len(names)} classes, {kept} mapped to {ctx.class_name}"
        )

        for split_dir in sorted(p for p in dataset_dir.iterdir() if p.is_dir()):
            split = SPLIT_ALIASES.get(split_dir.name.lower())
            if split is None:
                continue
            images_dir = split_dir / "images"
            search = images_dir if images_dir.exists() else split_dir
            for image in iter_images(search):
                lines = _remap_lines(_label_for(image), decisions)
                sample = _Sample(
                    image=image,
                    split=split,
                    prefix=dataset_dir.name,
                    label_lines=lines,
                )
                (positives if lines else negatives).append(sample)

    return positives, negatives


def _collect_custom(ctx: ModelContext) -> list[_Sample]:
    """Custom labelled footage: images in data/custom/images with a label file."""
    samples: list[_Sample] = []
    for image in iter_images(ctx.custom_images):
        label = ctx.custom_labels / (image.stem + ".txt")
        if not label.exists():
            console.print(f"[yellow]skip[/] custom/{image.name}: no label (run autolabel?)")
            continue
        lines: list[str] = []
        for raw in label.read_text().splitlines():
            parts = raw.split()
            if len(parts) < 5:
                continue
            line = _to_bbox_line(parts)
            if line is not None:
                lines.append(line)
        samples.append(
            _Sample(image=image, split=_assign_split("custom/" + image.name),
                    prefix="custom", label_lines=lines)
        )
    return samples


def _collect_extra_negatives(ctx: ModelContext) -> list[_Sample]:
    """Drop-in + mined/online negatives (images, no labels)."""
    samples: list[_Sample] = []
    for source_dir, prefix in ((ctx.dropin_neg_dir, "neg"), (ctx.neg_pool_dir, "negpool")):
        for image in iter_images(source_dir):
            samples.append(
                _Sample(image=image, split=_assign_split(prefix + "/" + image.name),
                        prefix=prefix, label_lines=[])
            )
    return samples


def _write_sample(ctx: ModelContext, sample: _Sample) -> None:
    stem = f"{sample.prefix}__{sample.image.stem}"
    img_dst = ctx.merged_dir / sample.split / "images" / f"{stem}{sample.image.suffix.lower()}"
    lbl_dst = ctx.merged_dir / sample.split / "labels" / f"{stem}.txt"
    img_dst.parent.mkdir(parents=True, exist_ok=True)
    lbl_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sample.image, img_dst)
    lbl_dst.write_text("\n".join(sample.label_lines))


def run(ctx: ModelContext, args: Any = None) -> None:
    if not ctx.raw_dir.exists() or not any(ctx.raw_dir.iterdir()):
        raise SystemExit(f"no datasets in {ctx.raw_dir}; run `gosai-train download` first")

    classes_cfg = load_yaml(ctx.classes_config)
    raw_overrides = classes_cfg.get("overrides") or {}
    overrides = {str(k).strip().lower(): str(v).strip().lower() for k, v in raw_overrides.items()}
    discovered: dict[str, str] = {}

    neg_cfg = load_yaml(ctx.negatives_config)
    max_ratio = float(neg_cfg.get("max_negative_ratio", 0.5))

    positives, ds_negatives = _collect_datasets(ctx, overrides, discovered, ctx.map_all_classes)
    positives += _collect_custom(ctx)
    negatives = ds_negatives + _collect_extra_negatives(ctx)

    # Persist discovered decisions for review (keep overrides untouched).
    classes_cfg["overrides"] = raw_overrides
    classes_cfg["discovered"] = dict(sorted(discovered.items()))
    save_yaml(ctx.classes_config, classes_cfg)

    if not positives:
        raise SystemExit(
            "no ball (positive) images found. Check classes.yaml mappings / dataset contents."
        )

    # Cap negatives deterministically.
    cap = int(len(positives) * max_ratio)
    negatives.sort(key=lambda s: hashlib.md5((s.prefix + s.image.name).encode()).hexdigest())
    dropped = max(0, len(negatives) - cap)
    negatives = negatives[:cap]

    # Fresh output.
    if ctx.merged_dir.exists():
        shutil.rmtree(ctx.merged_dir)
    for sample in positives + negatives:
        _write_sample(ctx, sample)

    save_yaml(
        ctx.merged_dir / "data.yaml",
        {
            "path": str(ctx.merged_dir.resolve()),
            "train": "train/images",
            "val": "val/images",
            "test": "test/images",
            "nc": 1,
            "names": [ctx.class_name],
        },
    )

    counts: dict[str, dict[str, int]] = {}
    for sample in positives + negatives:
        bucket = counts.setdefault(sample.split, {"pos": 0, "neg": 0})
        bucket["pos" if sample.label_lines else "neg"] += 1

    console.print("[green]done[/] merged dataset at " + str(ctx.merged_dir))
    console.print(f"  positives: {len(positives)}  negatives: {len(negatives)} (capped, dropped {dropped})")
    for split in ("train", "val", "test"):
        b = counts.get(split, {"pos": 0, "neg": 0})
        console.print(f"  {split:<5} pos={b['pos']:<6} neg={b['neg']}")
