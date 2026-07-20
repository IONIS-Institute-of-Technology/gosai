"""Auto-draft YOLO labels for images in <model>/data/custom/images.

Optional, never required. Uses your latest trained model when available
(best, in-domain); otherwise falls back to a base COCO model filtered to the
"sports ball" class as a weak prior. Annotated previews are written next to
the labels (data/custom/previews) so drafted boxes can be reviewed at a
glance; fix mistakes with Label Studio, labelImg, or Roboflow before training.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import select_device
from ...util import console, find_latest, iter_images
from .preview import draw_detections

COCO_SPORTS_BALL = 32


def run(ctx: ModelContext, args: Any = None) -> None:
    weights = getattr(args, "weights", None)
    conf = float(getattr(args, "conf", 0.25) or 0.25)
    make_previews = bool(getattr(args, "preview", True))

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
    previews_dir = ctx.data_dir / "custom" / "previews"
    if make_previews:
        previews_dir.mkdir(parents=True, exist_ok=True)

    device = select_device()
    results = model.predict(
        source=[str(p) for p in images], conf=conf, device=device,
        stream=True, verbose=False,
    )

    labelled = boxes_total = 0
    for result in results:
        lines: list[str] = []
        drawn: list[tuple[float, float, float, float, float]] = []
        for box in result.boxes:
            cls = int(box.cls.item())
            if target is not None and cls != target:
                continue
            cx, cy, w, h = box.xywhn[0].tolist()
            lines.append(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            drawn.append((x1, y1, x2, y2, float(box.conf.item())))
        label_path = ctx.custom_labels / (Path(result.path).stem + ".txt")
        label_path.write_text("\n".join(lines))
        labelled += 1
        boxes_total += len(lines)

        if make_previews:
            import cv2  # type: ignore[import-not-found]

            img = result.orig_img.copy()
            draw_detections(img, drawn)
            cv2.imwrite(str(previews_dir / (Path(result.path).stem + ".jpg")), img)

    console.print(f"[green]done[/] wrote {labelled} label files ({boxes_total} boxes) to {ctx.custom_labels}")
    if make_previews:
        console.print(f"        previews in {previews_dir}")
    console.print("Review the boxes, fix mistakes, then re-run `make all`.")
