"""Auto-draft YOLO labels for images in <model>/data/custom/images.

Optional, never required. Uses your latest trained model when available
(best, in-domain); otherwise falls back to a base COCO model filtered to the
"sports ball" class as a weak prior. Always review/fix the drafted boxes before
training (free tools: Label Studio, labelImg, or Roboflow).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import select_device
from ...util import console, find_latest, iter_images

COCO_SPORTS_BALL = 32


def run(ctx: ModelContext, args: Any = None) -> None:
    weights = getattr(args, "weights", None)
    conf = float(getattr(args, "conf", 0.25) or 0.25)

    images = list(iter_images(ctx.custom_images))
    if not images:
        console.print(f"[yellow]nothing to do[/] no images in {ctx.custom_images}")
        return

    if weights is None:
        latest = find_latest(ctx.runs_dir, "best.pt")
        weights = str(latest) if latest else "yolo26x.pt"

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(weights)
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))
    single_class = len(names) == 1
    target = None if single_class else COCO_SPORTS_BALL
    console.print(
        f"[cyan]autolabel[/] {len(images)} images with {Path(str(weights)).name} "
        f"({'single-class' if single_class else 'COCO sports-ball prior'})"
    )

    ctx.custom_labels.mkdir(parents=True, exist_ok=True)
    device = select_device()
    results = model.predict(
        source=[str(p) for p in images], conf=conf, device=device,
        stream=True, verbose=False,
    )

    labelled = boxes_total = 0
    for result in results:
        lines: list[str] = []
        for box in result.boxes:
            cls = int(box.cls.item())
            if target is not None and cls != target:
                continue
            cx, cy, w, h = box.xywhn[0].tolist()
            lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
        label_path = ctx.custom_labels / (Path(result.path).stem + ".txt")
        label_path.write_text("\n".join(lines))
        labelled += 1
        boxes_total += len(lines)

    console.print(f"[green]done[/] wrote {labelled} label files ({boxes_total} boxes) to {ctx.custom_labels}")
    console.print("Review the boxes, fix mistakes, then re-run `make all`.")
