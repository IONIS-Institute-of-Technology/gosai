"""Merge all sources into one YOLO dataset in <model>/data/merged.

- Ball-like boxes from every dataset are remapped to class 0.
- Non-ball boxes are dropped; frames left with no ball become negatives.
- data/custom (your labelled footage), data/negatives (drop-in) and
  data/negatives_pool (mined/online) are folded in.
- Near-duplicate frames are removed (perceptual dHash), negatives are capped
  to a sane ratio of positives, and a fraction of train positives gets a
  motion-blurred copy so moving balls stay detectable.
- Images are hardlinked (copy fallback); a per-source stats table is printed.
"""

from __future__ import annotations

import math
import os
import random
import shutil
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, load_yaml, save_yaml
from .sources import (
    Sample,
    collect_custom,
    collect_datasets,
    collect_extra_negatives,
    load_overrides,
)

# Hamming distance (of 256-bit dHashes) at or below which two frames from the
# SAME source are considered near-duplicates. Video-extracted datasets dedupe
# heavily (consecutive frames), photo datasets stay intact. Across sources
# only exact matches (distance 0) are dropped, so legitimately
# similar-but-distinct images from different datasets survive.
_DUP_THRESHOLD_SAME_SOURCE = 8


# ── near-duplicate removal ────────────────────────────────────────────────

def _dhash(image_path: Path):
    """256-bit difference hash as a 32-byte array; None when unreadable."""
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    small = cv2.resize(img, (17, 16), interpolation=cv2.INTER_AREA)
    return np.packbits((small[:, 1:] > small[:, :-1]).flatten())


def _dedup(samples: list[Sample]) -> tuple[list[Sample], dict[str, int]]:
    """Drop near-duplicate images. Deterministic: samples are visited in a
    stable hash order, the first occurrence wins."""
    import numpy as np  # type: ignore[import-not-found]

    kept: list[Sample] = []
    dropped: dict[str, int] = {}
    exact_seen: set[bytes] = set()
    per_source: dict[str, list[Any]] = {}

    for sample in sorted(samples, key=lambda s: s.sort_key):
        h = _dhash(sample.image)
        if h is None or h.tobytes() in exact_seen:
            dropped[sample.prefix] = dropped.get(sample.prefix, 0) + 1
            continue
        source_hashes = per_source.setdefault(sample.prefix, [])
        if source_hashes:
            distances = np.unpackbits(
                np.bitwise_xor(np.asarray(source_hashes), h), axis=1
            ).sum(axis=1)
            if int(distances.min()) <= _DUP_THRESHOLD_SAME_SOURCE:
                dropped[sample.prefix] = dropped.get(sample.prefix, 0) + 1
                continue
        exact_seen.add(h.tobytes())
        source_hashes.append(h)
        kept.append(sample)

    return kept, dropped


# ── motion-blur synthesis ─────────────────────────────────────────────────

def _motion_blur_kernel(length: int, angle_deg: float):
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    kernel = np.zeros((length, length), dtype=np.float32)
    c = (length - 1) / 2
    dx = math.cos(math.radians(angle_deg))
    dy = math.sin(math.radians(angle_deg))
    p1 = (round(c - dx * c), round(c - dy * c))
    p2 = (round(c + dx * c), round(c + dy * c))
    cv2.line(kernel, p1, p2, 1.0, 1)
    total = kernel.sum()
    return kernel / total if total > 0 else None


def _expand_boxes(lines: list[str], length: int, angle_deg: float,
                  img_w: int, img_h: int) -> list[str]:
    """Grow boxes along the blur axis (the smear spreads the ball that far)."""
    grow_x = length * abs(math.cos(math.radians(angle_deg))) / max(img_w, 1)
    grow_y = length * abs(math.sin(math.radians(angle_deg))) / max(img_h, 1)
    out: list[str] = []
    for line in lines:
        parts = line.split()
        cx, cy, w, h = (float(v) for v in parts[1:5])
        x1 = max(0.0, cx - w / 2 - grow_x / 2)
        x2 = min(1.0, cx + w / 2 + grow_x / 2)
        y1 = max(0.0, cy - h / 2 - grow_y / 2)
        y2 = min(1.0, cy + h / 2 + grow_y / 2)
        out.append(f"0 {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} {x2 - x1:.6f} {y2 - y1:.6f}")
    return out


def _synthesize_motion_blur(ctx: ModelContext, positives: list[Sample], cfg: dict) -> int:
    """Write motion-blurred copies of a fraction of train positives into merged."""
    import cv2  # type: ignore[import-not-found]

    fraction = float(cfg.get("fraction", 0.25))
    kernel_range = cfg.get("kernel", [9, 25])
    k_min, k_max = int(kernel_range[0]), int(kernel_range[1])

    train_pos = sorted(
        (s for s in positives if s.split == "train"), key=lambda s: s.sort_key
    )
    chosen = train_pos[: int(len(train_pos) * fraction)]
    rng = random.Random(int(cfg.get("seed", 0)))

    made = 0
    for sample in chosen:
        img = cv2.imread(str(sample.image))
        if img is None:
            continue
        length = rng.randrange(k_min | 1, (k_max | 1) + 1, 2)  # odd lengths
        angle = rng.uniform(0.0, 180.0)
        kernel = _motion_blur_kernel(length, angle)
        if kernel is None:
            continue
        blurred = cv2.filter2D(img, -1, kernel)

        h, w = img.shape[:2]
        stem = f"{sample.prefix}__{sample.image.stem}__mblur"
        img_dst = ctx.merged_dir / "train" / "images" / f"{stem}.jpg"
        lbl_dst = ctx.merged_dir / "train" / "labels" / f"{stem}.txt"
        cv2.imwrite(str(img_dst), blurred)
        lbl_dst.write_text("\n".join(_expand_boxes(sample.label_lines, length, angle, w, h)))
        made += 1
    return made


# ── output writing / stats ────────────────────────────────────────────────

def _place_image(src: Path, dst: Path) -> None:
    """Hardlink when possible (fast, no extra disk); fall back to a copy."""
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def _write_sample(ctx: ModelContext, sample: Sample) -> None:
    stem = f"{sample.prefix}__{sample.image.stem}"
    img_dst = ctx.merged_dir / sample.split / "images" / f"{stem}{sample.image.suffix.lower()}"
    lbl_dst = ctx.merged_dir / sample.split / "labels" / f"{stem}.txt"
    img_dst.parent.mkdir(parents=True, exist_ok=True)
    lbl_dst.parent.mkdir(parents=True, exist_ok=True)
    _place_image(sample.image, img_dst)
    lbl_dst.write_text("\n".join(sample.label_lines))


def _print_stats(samples: list[Sample], dup_dropped: dict[str, int]) -> None:
    from rich.table import Table

    per_source: dict[str, dict[str, Any]] = {}
    for s in samples:
        row = per_source.setdefault(
            s.prefix, {"pos": 0, "neg": 0, "boxes": 0, "sides": []}
        )
        if s.is_positive:
            row["pos"] += 1
            row["boxes"] += len(s.label_lines)
            for line in s.label_lines:
                parts = line.split()
                row["sides"].append(max(float(parts[3]), float(parts[4])))
        else:
            row["neg"] += 1

    table = Table(title="merged dataset composition", show_edge=False)
    for col in ("source", "positives", "negatives", "boxes", "median box", "dups dropped"):
        table.add_column(col, justify="right" if col != "source" else "left")
    for prefix in sorted(per_source):
        row = per_source[prefix]
        sides = sorted(row["sides"])
        median = f"{sides[len(sides) // 2] * 100:.1f}%" if sides else "-"
        table.add_row(
            prefix, str(row["pos"]), str(row["neg"]), str(row["boxes"]),
            median, str(dup_dropped.get(prefix, 0)),
        )
    console.print(table)


# ── entry point ───────────────────────────────────────────────────────────

def run(ctx: ModelContext, args: Any = None) -> None:
    if not ctx.raw_dir.exists() or not any(ctx.raw_dir.iterdir()):
        raise SystemExit(f"no datasets in {ctx.raw_dir}; run `gosai-train download` first")

    overrides = load_overrides(ctx)
    discovered: dict[str, str] = {}

    neg_cfg = load_yaml(ctx.negatives_config)
    max_ratio = float(neg_cfg.get("max_negative_ratio", 0.5))
    train_cfg = load_yaml(ctx.train_config)
    blur_cfg = train_cfg.get("motion_blur") or {}

    positives, ds_negatives = collect_datasets(ctx, overrides, discovered)
    positives += collect_custom(ctx)
    negatives = ds_negatives + collect_extra_negatives(ctx)

    # Persist discovered keep/drop decisions for review (generated file;
    # promote entries into classes.yaml `overrides:` to force a decision).
    save_yaml(ctx.classes_lock, {"discovered": dict(sorted(discovered.items()))})

    if not positives:
        raise SystemExit(
            "no ball (positive) images found. Check classes.yaml mappings / dataset contents."
        )

    console.print("[cyan]dedup[/] hashing images...")
    all_samples, dup_dropped = _dedup(positives + negatives)
    positives = [s for s in all_samples if s.is_positive]
    negatives = [s for s in all_samples if not s.is_positive]

    # Cap negatives deterministically.
    cap = int(len(positives) * max_ratio)
    negatives.sort(key=lambda s: s.sort_key)
    neg_over_cap = max(0, len(negatives) - cap)
    negatives = negatives[:cap]

    # Fresh output.
    if ctx.merged_dir.exists():
        shutil.rmtree(ctx.merged_dir)
    for sample in positives + negatives:
        _write_sample(ctx, sample)

    blurred = 0
    if blur_cfg.get("enabled", False):
        blurred = _synthesize_motion_blur(ctx, positives, blur_cfg)

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
        bucket["pos" if sample.is_positive else "neg"] += 1

    _print_stats(positives + negatives, dup_dropped)
    console.print("[green]done[/] merged dataset at " + str(ctx.merged_dir))
    console.print(
        f"  positives: {len(positives)}  negatives: {len(negatives)} "
        f"(capped, dropped {neg_over_cap})  motion-blur copies: {blurred}"
    )
    for split in ("train", "val", "test"):
        b = counts.get(split, {"pos": 0, "neg": 0})
        extra = f" (+{blurred} blurred)" if split == "train" and blurred else ""
        console.print(f"  {split:<5} pos={b['pos']:<6} neg={b['neg']}{extra}")
