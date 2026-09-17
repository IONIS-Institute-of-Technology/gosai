"""Fine-tune a YOLO detector on the merged dataset.

Every run gets its own timestamped folder under <model>/runs/ (never
overwritten), so `export`/`eval` provenance is unambiguous.

train.yaml keys are passed to Ultralytics as-is, except the ones this pipeline
consumes itself (``_PIPELINE_KEYS``). Ultralytics rejects unknown keys.
"""

from __future__ import annotations

import json
from argparse import Namespace
from datetime import datetime
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, load_yaml
from .provenance import DATASETS_FILE, RUN_FILE, git_state, sha256_file

_PIPELINE_KEYS = ("model", "model_sha256", "infer_imgsz", "motion_blur", "device")


def _base_weights(cfg: dict[str, Any]) -> str:
    """Download the base weights if needed and check them against ``model_sha256``."""
    from ultralytics.utils.downloads import attempt_download_asset

    name = cfg.get("model")
    if not name:
        raise SystemExit("train.yaml needs `model` (base weights, e.g. yolo26s.pt)")
    path = Path(attempt_download_asset(str(name)))
    actual = sha256_file(path)
    expected = cfg.get("model_sha256")
    if actual != expected:
        raise SystemExit(
            f"{path} has sha256 {actual}, but train.yaml `model_sha256` is {expected!r}. "
            "Delete the file to download it again, or pin the digest published with the release."
        )
    return str(path)


def run(ctx: ModelContext, args: Namespace) -> Path:
    data_yaml = ctx.merged_dir / "data.yaml"
    datasets_file = ctx.merged_dir / DATASETS_FILE
    if not data_yaml.exists() or not datasets_file.exists():
        raise SystemExit(f"{ctx.merged_dir} is incomplete; run `gosai-train prepare` first")

    cfg = load_yaml(ctx.train_config)
    device = resolve_device(cfg)
    if device == "cpu":
        # Usually a broken CUDA install rather than an intentional choice
        # (CPU-only torch wheels, or an NVIDIA driver too old for the GPU).
        console.print(
            "[bold red]warning[/] no GPU detected, training on CPU will be 20-100x slower.\n"
            "  Check: uv run python -c \"import torch; print(torch.__version__, torch.cuda.is_available())\"\n"
            "  A '+cpu' torch on a CUDA machine means the wrong wheel is installed; re-run `uv sync`."
        )

    params = {key: value for key, value in cfg.items() if key not in _PIPELINE_KEYS}
    # AutoBatch (batch=-1) only works on CUDA; pick a safe size elsewhere,
    # scaling down as the input resolution (and thus memory) grows.
    if device in ("cpu", "mps") and int(params.get("batch", -1)) < 0:
        imgsz = int(params.get("imgsz", 640))
        params["batch"] = 4 if imgsz >= 1280 else 6 if imgsz >= 960 else 8

    base = _base_weights(cfg)
    run_name = f"{ctx.name}-{datetime.now():%Y%m%d-%H%M%S}"
    provenance = {
        "run": run_name,
        "base_weights": Path(base).name,
        **git_state(),
        "datasets": json.loads(datasets_file.read_text()),
    }
    console.print(
        f"[cyan]train[/] {Path(base).name} on {device} "
        f"(batch={params.get('batch')}) -> runs/{run_name}"
    )

    from ultralytics import YOLO

    model = YOLO(base)
    model.train(
        **params, data=str(data_yaml), device=device, project=str(ctx.runs_dir), name=run_name
    )

    save_dir = Path(model.trainer.save_dir)
    (save_dir / RUN_FILE).write_text(json.dumps(provenance, indent=2) + "\n")
    console.print(f"[green]done[/] weights under {save_dir}")
    return Path(model.trainer.best)
