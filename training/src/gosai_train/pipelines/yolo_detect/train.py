"""Fine-tune a YOLO detector on the merged dataset."""

from __future__ import annotations

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
    imgsz = int(cfg.get("imgsz", 640))
    batch = cfg.get("batch", -1)
    # AutoBatch (batch=-1) only works on CUDA; pick a safe default elsewhere,
    # scaling down as the input resolution (and thus memory) grows.
    if device in ("cpu", "mps") and (batch is None or int(batch) < 0):
        batch = 4 if imgsz >= 1280 else 6 if imgsz >= 960 else 8

    params: dict[str, Any] = dict(
        data=str(data_yaml),
        epochs=int(cfg.get("epochs", 100)),
        imgsz=imgsz,
        rect=bool(cfg.get("rect", False)),
        batch=int(batch),
        device=device,
        patience=int(cfg.get("patience", 30)),
        seed=int(cfg.get("seed", 0)),
        project=str(ctx.runs_dir),
        name=str(cfg.get("name", ctx.name)),
        exist_ok=True,
    )
    for key in _AUG_KEYS:
        if key in cfg:
            params[key] = cfg[key]

    console.print(f"[cyan]train[/] {cfg.get('model', 'yolo26s.pt')} on {device} (batch={batch})")

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(str(cfg.get("model", "yolo26s.pt")))
    model.train(**params)

    console.print(f"[green]done[/] weights under {ctx.runs_dir}")
