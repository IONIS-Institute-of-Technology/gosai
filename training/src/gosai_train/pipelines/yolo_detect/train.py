"""Fine-tune a YOLO detector on the merged dataset.

Every run gets its own timestamped folder under <model>/runs/ (never
overwritten), so `export`/`eval` provenance is unambiguous.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, load_yaml

_AUG_KEYS = ("hsv_h", "hsv_s", "hsv_v", "fliplr", "flipud", "mosaic", "mixup", "degrees")


def run(ctx: ModelContext, args: Any = None) -> None:
    data_yaml = ctx.merged_dir / "data.yaml"
    if not data_yaml.exists():
        raise SystemExit(f"{data_yaml} not found; run `gosai-train prepare` first")

    cfg = load_yaml(ctx.train_config)
    device = resolve_device(cfg.get("device", "auto"))
    if device == "cpu":
        # Usually means a broken CUDA install rather than an intentional choice
        # (e.g. CPU-only torch wheels, or an NVIDIA driver too old for the GPU).
        console.print(
            "[bold red]warning[/] no GPU detected -- training on CPU will be 20-100x slower.\n"
            "  Check: uv run python -c \"import torch; print(torch.__version__, torch.cuda.is_available())\"\n"
            "  A '+cpu' torch on a CUDA machine means the wrong wheel is installed; re-run `uv sync`."
        )
    imgsz = int(cfg.get("imgsz", 640))
    batch = cfg.get("batch", -1)
    # AutoBatch (batch=-1) only works on CUDA; pick a safe default elsewhere,
    # scaling down as the input resolution (and thus memory) grows.
    if device in ("cpu", "mps") and (batch is None or int(batch) < 0):
        batch = 4 if imgsz >= 1280 else 6 if imgsz >= 960 else 8

    run_name = f"{ctx.name}-{datetime.now():%Y%m%d-%H%M%S}"
    params: dict[str, Any] = dict(
        data=str(data_yaml),
        epochs=int(cfg.get("epochs", 100)),
        imgsz=imgsz,
        rect=bool(cfg.get("rect", False)),
        batch=int(batch),
        device=device,
        patience=int(cfg.get("patience", 30)),
        seed=int(cfg.get("seed", 0)),
        cache=cfg.get("cache", False),
        workers=int(cfg.get("workers", 8)),
        cos_lr=bool(cfg.get("cos_lr", False)),
        project=str(ctx.runs_dir),
        name=run_name,
    )
    for key in _AUG_KEYS:
        if key in cfg:
            params[key] = cfg[key]

    console.print(
        f"[cyan]train[/] {cfg.get('model', 'yolo26s.pt')} on {device} "
        f"(batch={batch}) -> runs/{run_name}"
    )

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(str(cfg.get("model", "yolo26s.pt")))
    model.train(**params)

    console.print(f"[green]done[/] weights under {ctx.runs_dir / run_name}")
