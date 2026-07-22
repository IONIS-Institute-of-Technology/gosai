"""Shared IO helpers used across pipelines."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from rich.console import Console

console = Console()

IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".m4v", ".webm"}


def load_yaml(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        return {}
    with path.open() as f:
        return yaml.safe_load(f) or {}


def save_yaml(path: str | Path, data: dict[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


def load_env(root: Path) -> None:
    """Load simple KEY=VALUE pairs from <root>/.env into os.environ (no overwrite)."""
    env_path = Path(root) / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMG_EXTS


def iter_images(directory: Path):
    if not directory.exists():
        return
    for p in sorted(directory.rglob("*")):
        if p.is_file() and is_image(p):
            yield p


def paths_txt(prefix: str, paths: list[Path]) -> str:
    """Write paths to a temp .txt and return it, for use as an ultralytics source.

    Passing a Python list to `model.predict()` makes ultralytics decode every
    image into memory and run them as ONE batch (`LoadPilAndNumpy`), which OOMs
    on large sets. A .txt source streams via `LoadImagesAndVideos` and respects
    the requested batch size.
    """
    import tempfile

    f = tempfile.NamedTemporaryFile(
        "w", prefix=f"gosai-{prefix}-", suffix=".txt", delete=False
    )
    with f:
        f.write("\n".join(str(p) for p in paths))
    return f.name


def find_latest(root: Path, pattern: str) -> Path | None:
    """Newest file under root matching the rglob pattern (e.g. 'best.pt')."""
    if not root.exists():
        return None
    matches = sorted(root.rglob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None
