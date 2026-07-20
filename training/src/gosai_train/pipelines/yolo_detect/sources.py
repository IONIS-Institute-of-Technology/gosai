"""Sample collection shared by the yolo-detect stages (prepare, negatives, ...).

A :class:`Sample` is one image plus its (already remapped, single-class) label
lines; an empty ``label_lines`` means the image is a negative. Collection
applies the per-dataset ``enabled``/``cap`` settings from ``datasets.yaml`` so
every stage sees the same, deterministic view of the sources.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from ...context import ModelContext
from ...util import console, iter_images, load_yaml

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

# Frames extracted by the `frames` stage are named <video-stem>_<000123>.jpg.
_FRAME_SUFFIX = re.compile(r"_\d{4,8}$")


def classify_name(name: str) -> str:
    """Classify a source class name: 'keep' (a ball), 'drop' (confidently not
    a ball), or 'unknown' (junk/ambiguous name).

    The distinction matters: a frame whose only boxes were *dropped* becomes a
    negative (pocket-only frames are exactly what we want the model to ignore),
    but a frame with *unknown* boxes is excluded entirely -- an unknown class
    might be a ball, and feeding it as a negative would teach the model to
    miss balls.
    """
    n = " ".join(name.strip().lower().replace("-", " ").replace("_", " ").split())
    if not n:
        return "unknown"
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
    return "unknown"


@dataclass
class Sample:
    image: Path
    split: str
    prefix: str
    label_lines: list[str] = field(default_factory=list)  # empty == negative

    @property
    def is_positive(self) -> bool:
        return bool(self.label_lines)

    @property
    def sort_key(self) -> str:
        """Stable, content-independent ordering key."""
        return hashlib.md5(f"{self.prefix}/{self.image.name}".encode()).hexdigest()


def assign_split(key: str) -> str:
    """Deterministic 80/10/10 split from a stable hash of the key."""
    digest = hashlib.md5(key.encode()).hexdigest()
    bucket = int(digest[:8], 16) % 10
    if bucket < 8:
        return "train"
    if bucket == 8:
        return "val"
    return "test"


def group_key(image: Path) -> str:
    """Split-group key for an image: frames of one video share a key.

    ``frames`` names extracted frames ``<video-stem>_<index>.jpg``; keeping a
    whole video on one side of the split prevents near-identical consecutive
    frames from leaking between train and val/test.
    """
    return _FRAME_SUFFIX.sub("", image.stem)


def load_overrides(ctx: ModelContext) -> dict[str, str]:
    """Manual class decisions from classes.yaml, normalized."""
    cfg = load_yaml(ctx.classes_config)
    raw = cfg.get("overrides") or {}
    return {str(k).strip().lower(): str(v).strip().lower() for k, v in raw.items()}


def dataset_class_names(dataset_dir: Path) -> list[str]:
    data = load_yaml(dataset_dir / "data.yaml")
    names = data.get("names")
    if isinstance(names, dict):
        return [str(names[k]) for k in sorted(names, key=lambda x: int(x))]
    if isinstance(names, list):
        return [str(n) for n in names]
    return []


def label_for(image: Path) -> Path | None:
    """Find the YOLO label file for an image in a sibling 'labels' dir."""
    label = image.parent.parent / "labels" / (image.stem + ".txt")
    if label.exists():
        return label
    sibling = image.with_suffix(".txt")
    return sibling if sibling.exists() else None


def to_bbox_line(parts: list[str]) -> str | None:
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


def remap_lines(label: Path | None, decisions: dict[int, str]) -> tuple[list[str], bool]:
    """Keep ball boxes (remapped to class 0); drop the rest.

    Returns ``(lines, has_unknown)`` where ``has_unknown`` flags boxes of a
    class we could not classify -- such frames must not become negatives.
    """
    if label is None:
        return [], False
    out: list[str] = []
    has_unknown = False
    for raw in label.read_text().splitlines():
        parts = raw.split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
        except ValueError:
            continue
        decision = decisions.get(cls, "unknown")
        if decision == "unknown":
            has_unknown = True
            continue
        if decision != "keep":
            continue
        line = to_bbox_line(parts)
        if line is not None:
            out.append(line)
    return out, has_unknown


def _dataset_settings(ctx: ModelContext) -> dict[str, dict]:
    """Per-dataset settings (enabled, cap) keyed by dataset name."""
    cfg = load_yaml(ctx.datasets_config)
    return {str(e["name"]): e for e in cfg.get("datasets", []) if "name" in e}


def _cap_dataset(samples: list[Sample], cap: int) -> list[Sample]:
    """Deterministically cap a dataset, keeping positives first."""
    if len(samples) <= cap:
        return samples
    positives = sorted((s for s in samples if s.is_positive), key=lambda s: s.sort_key)
    negatives = sorted((s for s in samples if not s.is_positive), key=lambda s: s.sort_key)
    kept = positives[:cap]
    kept += negatives[: max(0, cap - len(kept))]
    return kept


def collect_datasets(
    ctx: ModelContext,
    overrides: dict[str, str],
    discovered: dict[str, str] | None = None,
) -> tuple[list[Sample], list[Sample]]:
    """Collect (positives, negatives) from the downloaded datasets.

    Applies per-dataset ``enabled``/``cap`` from datasets.yaml. ``discovered``
    (if given) is filled with every source class name -> keep/drop decision.
    """
    positives: list[Sample] = []
    negatives: list[Sample] = []
    if not ctx.raw_dir.exists():
        return positives, negatives

    settings = _dataset_settings(ctx)
    map_all = ctx.map_all_classes

    for dataset_dir in sorted(p for p in ctx.raw_dir.iterdir() if p.is_dir()):
        entry = settings.get(dataset_dir.name, {})
        if not entry.get("enabled", True):
            console.print(f"[dim]{dataset_dir.name}: disabled in datasets.yaml, skipping[/]")
            continue

        names = dataset_class_names(dataset_dir)
        decisions: dict[int, str] = {}
        for idx, name in enumerate(names):
            if map_all:
                decision = "keep"
            else:
                decision = overrides.get(name.strip().lower()) or classify_name(name)
            decisions[idx] = decision
            if discovered is not None:
                discovered[name] = decision

        samples: list[Sample] = []
        excluded = 0
        for split_dir in sorted(p for p in dataset_dir.iterdir() if p.is_dir()):
            split = SPLIT_ALIASES.get(split_dir.name.lower())
            if split is None:
                continue
            images_dir = split_dir / "images"
            search = images_dir if images_dir.exists() else split_dir
            trust_negatives = entry.get("trust_negatives", True)
            for image in iter_images(search):
                lines, has_unknown = remap_lines(label_for(image), decisions)
                if not lines and (has_unknown or not trust_negatives):
                    # A no-ball frame only becomes a negative when we trust
                    # it: frames whose boxes we could not classify (might be
                    # balls) and frames from datasets with known-unreliable
                    # labelling are excluded -- a mislabelled negative teaches
                    # the model to MISS balls.
                    excluded += 1
                    continue
                samples.append(
                    Sample(image=image, split=split, prefix=dataset_dir.name, label_lines=lines)
                )

        total = len(samples)
        cap = entry.get("cap")
        if cap is not None:
            samples = _cap_dataset(samples, int(cap))

        kept_classes = sum(1 for d in decisions.values() if d == "keep")
        unknown_classes = sum(1 for d in decisions.values() if d == "unknown")
        capped = f", capped {total} -> {len(samples)}" if len(samples) < total else ""
        notes = ""
        if excluded:
            notes = f", [yellow]{excluded} unlabelled/unknown frames excluded[/]"
        if unknown_classes:
            notes += f" [yellow]({unknown_classes} unknown classes -- review classes.lock.yaml)[/]"
        console.print(
            f"[cyan]{dataset_dir.name}[/]: {len(names)} classes, "
            f"{kept_classes} mapped to {ctx.class_name}{capped}{notes}"
        )

        for sample in samples:
            (positives if sample.is_positive else negatives).append(sample)

    return positives, negatives


def collect_custom(ctx: ModelContext) -> list[Sample]:
    """Custom labelled footage: images in data/custom/images with a label file.

    Split is assigned per *video* (see :func:`group_key`) so consecutive
    frames never straddle train/val.
    """
    samples: list[Sample] = []
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
            line = to_bbox_line(parts)
            if line is not None:
                lines.append(line)
        samples.append(
            Sample(image=image, split=assign_split("custom/" + group_key(image)),
                   prefix="custom", label_lines=lines)
        )
    return samples


def collect_extra_negatives(ctx: ModelContext) -> list[Sample]:
    """Drop-in + mined/online negatives (images, no labels).

    Split per image (not per video group): negatives carry no labels, so
    consecutive-frame "leakage" only affects the background-FP statistics,
    and near-identical frames are removed by prepare's dedup anyway. Grouping
    would collapse synthesized pools (glare__00001, ...) into one split.
    """
    samples: list[Sample] = []
    for source_dir, prefix in ((ctx.dropin_neg_dir, "neg"), (ctx.neg_pool_dir, "negpool")):
        for image in iter_images(source_dir):
            samples.append(
                Sample(image=image, split=assign_split(prefix + "/" + image.stem),
                       prefix=prefix, label_lines=[])
            )
    return samples
