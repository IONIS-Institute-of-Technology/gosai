"""Auto-draft YOLO labels for images in <model>/data/custom/images.

Optional, never required. Uses your latest trained model when available (best,
in-domain); otherwise falls back to a base COCO model filtered to the "sports
ball" class as a weak prior. Annotated previews go to data/custom/previews so
drafted boxes can be reviewed at a glance; fix mistakes with Label Studio,
labelImg, or Roboflow before training.
"""

from __future__ import annotations

from argparse import Namespace
from pathlib import Path

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, iter_images, load_yaml, paths_source
from .preview import draw_detections
from .weights import print_weights, resolve_weights

COCO_SPORTS_BALL = 32
BASE_WEIGHTS = "yolo26x.pt"


def run(ctx: ModelContext, args: Namespace) -> None:
    images = list(iter_images(ctx.custom_images))
    if not images:
        console.print(f"[yellow]nothing to do[/] no images in {ctx.custom_images}")
        return

    weights = resolve_weights(ctx, args.weights, fallback=BASE_WEIGHTS)
    print_weights("weights", weights)

    from ultralytics import YOLO

    model = YOLO(weights)
    names = model.names if isinstance(model.names, dict) else dict(enumerate(model.names))
    single_class = len(names) == 1
    target = None if single_class else COCO_SPORTS_BALL
    console.print(
        f"[cyan]autolabel[/] {len(images)} images with {Path(weights).name} "
        f"({'single-class' if single_class else 'COCO sports-ball prior'})"
    )

    ctx.custom_labels.mkdir(parents=True, exist_ok=True)
    if args.preview:
        import cv2

        ctx.custom_previews.mkdir(parents=True, exist_ok=True)

    device = resolve_device(load_yaml(ctx.train_config))
    labelled = boxes_total = 0
    with paths_source("autolabel", images) as source:
        results = model.predict(
            source=source, conf=args.conf, device=device, batch=1, stream=True, verbose=False,
        )
        for result in results:
            lines: list[str] = []
            drawn: list[tuple[float, float, float, float, float]] = []
            for box in result.boxes:
                if target is not None and int(box.cls.item()) != target:
                    continue
                cx, cy, w, h = box.xywhn[0].tolist()
                lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                drawn.append((x1, y1, x2, y2, float(box.conf.item())))
            stem = Path(result.path).stem
            (ctx.custom_labels / f"{stem}.txt").write_text("\n".join(lines))
            labelled += 1
            boxes_total += len(lines)

            if args.preview:
                img = result.orig_img.copy()
                draw_detections(img, drawn)
                cv2.imwrite(str(ctx.custom_previews / f"{stem}.jpg"), img)

    console.print(f"[green]done[/] wrote {labelled} label files ({boxes_total} boxes) to {ctx.custom_labels}")
    if args.preview:
        console.print(f"        previews in {ctx.custom_previews}")
    console.print(
        "Review the boxes, fix mistakes, then retrain with `uv run gosai-train prepare` "
        "and `uv run gosai-train train` (or `all`)."
    )
