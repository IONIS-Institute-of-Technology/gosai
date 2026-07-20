"""Accelerator selection for training/export (CUDA -> MPS/Metal -> CPU)."""

from __future__ import annotations


def select_device() -> str:
    """Auto-pick the best available device: CUDA '0', Apple 'mps', else 'cpu'."""
    try:
        import torch  # type: ignore[import-not-found]

        if torch.cuda.is_available():
            return "0"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def resolve_device(value: str | int | None) -> str:
    """Resolve a configured device value ('auto' -> autodetect)."""
    if value is None or str(value).strip().lower() in ("", "auto"):
        return select_device()
    return str(value)
