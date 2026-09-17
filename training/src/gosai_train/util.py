"""Shared IO helpers used across pipelines."""

from __future__ import annotations

import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
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
    # Explicit utf-8: Windows defaults to a legacy locale encoding (cp1252).
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_yaml(path: str | Path, data: dict[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMG_EXTS


def iter_images(directory: Path) -> Iterator[Path]:
    if not directory.exists():
        return
    for p in sorted(directory.rglob("*")):
        if p.is_file() and is_image(p):
            yield p


def iter_videos(source: Path) -> Iterator[Path]:
    """Video files under a directory, or the source itself when it is a video file."""
    if source.is_file():
        if source.suffix.lower() in VIDEO_EXTS:
            yield source
        return
    for p in sorted(source.rglob("*")):
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS:
            yield p


def iter_video_frames(path: Path, step: int) -> Iterator[tuple[int, Any]]:
    """Yield ``(frame_index, bgr_frame)`` for every ``step``-th frame of a video."""
    import cv2

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        console.print(f"[yellow]skip[/] {path.name}: cannot open")
        return
    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                yield idx, frame
            idx += 1
    finally:
        cap.release()


@contextmanager
def paths_source(prefix: str, paths: list[Path]) -> Iterator[str]:
    """A temporary .txt listing ``paths``, for use as an Ultralytics source.

    Passing a Python list to `model.predict()` makes Ultralytics decode every
    image into memory and run them as one batch, which runs out of memory on
    large sets. A .txt source streams and respects the batch size. Consume the
    streamed results inside the ``with`` block: the file is deleted on exit.
    """
    with tempfile.TemporaryDirectory(prefix=f"gosai-{prefix}-") as tmp:
        listing = Path(tmp) / "sources.txt"
        listing.write_text("\n".join(str(p) for p in paths), encoding="utf-8")
        yield str(listing)


def find_latest(root: Path, pattern: str) -> Path | None:
    """Newest file under root matching the rglob pattern (e.g. 'best.pt')."""
    if not root.exists():
        return None
    matches = sorted(root.rglob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return matches[0] if matches else None
