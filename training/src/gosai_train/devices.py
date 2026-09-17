"""Accelerator selection for training and export (CUDA, then MPS, then CPU)."""

from __future__ import annotations

from typing import Any


def resolve_device(cfg: dict[str, Any]) -> str:
    """Device from a config's ``device`` key. ``auto`` or unset picks the best available."""
    value = cfg.get("device")
    if value is not None and str(value).strip().lower() not in ("", "auto"):
        return str(value)

    import torch

    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
