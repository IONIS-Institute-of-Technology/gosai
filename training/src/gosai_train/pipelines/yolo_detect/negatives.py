"""Optional EXTERNAL negatives + glare synthesis into <model>/data/negatives_pool.

In-domain negatives (empty tables, pockets, hands) are mined automatically by
`prepare`. This step only adds optional out-of-domain hard negatives and is OFF
by default, so `make all` works fully offline.
"""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, iter_images, load_yaml
from .prepare import _collect_datasets


def _images_dir(ctx: ModelContext) -> Path:
    d = ctx.neg_pool_dir / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _copy_capped(ctx: ModelContext, src_dir: Path, prefix: str, cap: int) -> int:
    out = _images_dir(ctx)
    count = 0
    for image in iter_images(src_dir):
        if count >= cap:
            break
        dst = out / f"{prefix}__{count:05d}{image.suffix.lower()}"
        shutil.copy2(image, dst)
        count += 1
    return count


def _maybe_unzip(path: Path, into: Path) -> None:
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            zf.extractall(into)


def _fetch_source(ctx: ModelContext, source: dict[str, Any], tmp: Path) -> int:
    name = source.get("name", "source")
    cap = int(source.get("cap", 300))
    kind = source.get("type")
    target = tmp / name
    target.mkdir(parents=True, exist_ok=True)

    if kind == "gdrive_folder":
        import gdown  # type: ignore[import-not-found]

        gdown.download_folder(id=source["id"], output=str(target), quiet=False, use_cookies=False)
    elif kind == "gdrive_file":
        import gdown  # type: ignore[import-not-found]

        out = target / "download.zip"
        gdown.download(id=source["id"], output=str(out), quiet=False)
        _maybe_unzip(out, target)
    elif kind == "url":
        url = source.get("url") or ""
        if not url:
            console.print(f"[yellow]skip[/] {name}: empty url")
            return 0
        import requests  # type: ignore[import-not-found]

        out = target / "download.zip"
        with requests.get(url, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with out.open("wb") as fp:
                for chunk in resp.iter_content(chunk_size=1 << 16):
                    fp.write(chunk)
        _maybe_unzip(out, target)
    else:
        console.print(f"[yellow]skip[/] {name}: unknown type {kind!r}")
        return 0

    return _copy_capped(ctx, target, name, cap)


def _indomain_negative_bases(ctx: ModelContext) -> list[Path]:
    """No-ball frames mined from the downloaded datasets (real table frames)."""
    classes_cfg = load_yaml(ctx.classes_config)
    raw_overrides = classes_cfg.get("overrides") or {}
    overrides = {str(k).strip().lower(): str(v).strip().lower() for k, v in raw_overrides.items()}
    try:
        _positives, negatives = _collect_datasets(ctx, overrides, {}, ctx.map_all_classes)
    except Exception:
        return []
    return [s.image for s in negatives]


def _glare_overlay(ctx: ModelContext, count: int) -> int:
    """Composite flare-ish bright blobs onto no-ball frames to mimic glare/sun rays."""
    import random

    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]

    # Prefer real in-domain table frames (no ball), then any drop-in / fetched negatives.
    candidates = (
        _indomain_negative_bases(ctx)
        + list(iter_images(ctx.dropin_neg_dir))
        + [p for p in iter_images(ctx.neg_pool_dir) if "glare__" not in p.name]
    )
    seen: set[str] = set()
    bases: list[Path] = []
    for p in candidates:
        key = str(p)
        if key not in seen:
            seen.add(key)
            bases.append(p)
    if not bases:
        console.print(
            "[yellow]glare[/] no base frames found (run `download` first); skipping"
        )
        return 0

    out = _images_dir(ctx)
    made = 0
    rng = random.Random(0)
    for i in range(count):
        base_path = bases[i % len(bases)]
        img = cv2.imread(str(base_path))
        if img is None:
            continue
        h, w = img.shape[:2]
        glow = np.zeros((h, w), dtype=np.float32)

        # A few soft radial hotspots (lens flare / reflection blobs).
        for _ in range(rng.randint(1, 3)):
            cx, cy = rng.randint(0, w), rng.randint(0, h)
            radius = rng.randint(int(min(h, w) * 0.06), int(min(h, w) * 0.28) + 1)
            spot = np.zeros((h, w), dtype=np.float32)
            cv2.circle(spot, (cx, cy), radius, 1.0, -1, lineType=cv2.LINE_AA)
            spot = cv2.GaussianBlur(spot, (0, 0), sigmaX=radius * 0.5)
            glow = np.maximum(glow, spot)

        # Occasional thin bright streaks (sun rays / projector spill).
        for _ in range(rng.randint(0, 2)):
            x1, y1 = rng.randint(0, w), rng.randint(0, h)
            x2, y2 = rng.randint(0, w), rng.randint(0, h)
            streak = np.zeros((h, w), dtype=np.float32)
            cv2.line(streak, (x1, y1), (x2, y2), 1.0, rng.randint(2, 8), lineType=cv2.LINE_AA)
            streak = cv2.GaussianBlur(streak, (0, 0), sigmaX=rng.uniform(2.0, 6.0))
            glow = np.maximum(glow, streak * rng.uniform(0.5, 0.9))

        strength = rng.uniform(0.45, 0.85)
        glow3 = (glow[:, :, None] * strength)
        warm = np.array([235, 245, 255], dtype=np.float32)  # BGR, slightly warm white
        blended = img.astype(np.float32) * (1 - glow3) + warm * glow3
        dst = out / f"glare__{i:05d}.jpg"
        cv2.imwrite(str(dst), np.clip(blended, 0, 255).astype("uint8"))
        made += 1
    return made


def run(ctx: ModelContext, args: Any = None) -> None:
    cfg = load_yaml(ctx.negatives_config)
    sources = cfg.get("sources", []) or []
    glare = cfg.get("glare_overlay", {}) or {}

    total = 0
    enabled = [s for s in sources if s.get("enabled")]
    if enabled:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            for source in enabled:
                name = source.get("name", "source")
                try:
                    added = _fetch_source(ctx, source, tmp)
                    total += added
                    console.print(f"[green]+{added}[/] negatives from {name}")
                except Exception as exc:  # pragma: no cover - network heavy
                    console.print(f"[yellow]warn[/] {name}: {exc!r}")

    if glare.get("enabled"):
        added = _glare_overlay(ctx, int(glare.get("count", 200)))
        total += added
        console.print(f"[green]+{added}[/] synthetic glare negatives")

    if total == 0:
        console.print(
            "[yellow]nothing to do[/] no external sources enabled. "
            "In-domain negatives are mined during `prepare`."
        )
    else:
        console.print(f"[green]done[/] {total} extra negatives in {ctx.neg_pool_dir}")
