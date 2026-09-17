"""Weights and input-size helpers shared by the stages that load a trained model."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, find_latest


def resolve_weights(ctx: ModelContext, arg: str | None, fallback: str | None = None) -> str:
    """``--weights`` when given, else the newest ``best.pt`` under runs/, else ``fallback``."""
    if arg:
        return arg
    latest = find_latest(ctx.runs_dir, "best.pt")
    if latest is not None:
        return str(latest)
    if fallback is not None:
        return fallback
    raise SystemExit("no trained weights found; run `gosai-train train` first or pass --weights")


def infer_size(cfg: dict[str, Any]) -> tuple[int, int]:
    """Inference and export input ``(height, width)`` from train.yaml.

    ``infer_imgsz: [h, w]`` when set, else the square training ``imgsz``.
    """
    raw = cfg.get("infer_imgsz") or cfg.get("imgsz")
    if raw is None:
        raise SystemExit("train.yaml needs `imgsz` or `infer_imgsz`")
    if isinstance(raw, (list, tuple)):
        height, width = raw
        return int(height), int(width)
    return int(raw), int(raw)


def print_weights(label: str, weights: str) -> None:
    """Show which weights a stage uses and when they were trained, so stale runs stand out."""
    path = Path(weights)
    if not path.exists():
        console.print(f"[cyan]{label}[/] {weights}")
        return
    trained_at = datetime.fromtimestamp(path.stat().st_mtime)
    age_days = (datetime.now() - trained_at).days
    stale = f" [yellow]({age_days} days old)[/]" if age_days > 7 else ""
    console.print(f"[cyan]{label}[/] {path} (trained {trained_at:%Y-%m-%d %H:%M}){stale}")
