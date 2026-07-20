"""Mine hard negatives: run the trained model over footage and collect the
frames where it fires, for human review.

This closes the false-positive loop: frames where the detector fires on
non-balls (pockets, glare, light spots, a ball sunk in a hole) become
training negatives.

    gosai-train mine --source path/to/videos_or_images

Output (under <model>/data/mining/):
    previews/   annotated frames -- review these
    images/     the matching raw frames

For every preview showing a WRONG detection, move the same-named file from
``mining/images/`` into ``data/negatives/``; the next `prepare` folds it in.
Frames with correctly detected balls are simply deleted (or kept for
`autolabel` as extra positives).
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import select_device
from ...util import VIDEO_EXTS, console, find_latest, is_image, iter_images
from .preview import draw_detections


def _collect_videos(source: Path) -> list[Path]:
    if source.is_file():
        return [source] if source.suffix.lower() in VIDEO_EXTS else []
    return [
        p for p in sorted(source.rglob("*"))
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    ]


def _boxes(result: Any, conf: float) -> list[tuple[float, float, float, float, float]]:
    out: list[tuple[float, float, float, float, float]] = []
    for box in result.boxes:
        score = float(box.conf.item())
        if score < conf:
            continue
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        out.append((x1, y1, x2, y2, score))
    return out


def run(ctx: ModelContext, args: Any = None) -> None:
    import cv2  # type: ignore[import-not-found]

    source_arg = getattr(args, "source", None)
    source = Path(source_arg) if source_arg else ctx.custom_videos
    if not source.exists():
        raise SystemExit(f"source not found: {source}")

    weights = getattr(args, "weights", None)
    if weights is None:
        latest = find_latest(ctx.runs_dir, "best.pt")
        if latest is None:
            raise SystemExit(
                "no trained weights found; `mine` needs your trained model "
                "(run `gosai-train train` first, or pass --weights)."
            )
        weights = str(latest)
    conf = float(getattr(args, "conf", 0.3) or 0.3)
    step = max(1, int(getattr(args, "step", 10) or 10))

    images_out = ctx.mining_dir / "images"
    previews_out = ctx.mining_dir / "previews"
    if ctx.mining_dir.exists():
        shutil.rmtree(ctx.mining_dir)
    images_out.mkdir(parents=True, exist_ok=True)
    previews_out.mkdir(parents=True, exist_ok=True)

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(weights)
    device = select_device()
    console.print(f"[cyan]mine[/] {source} with {Path(weights).name} (conf>={conf}, every {step} frames)")

    hits = scanned = 0

    def handle(frame: Any, name: str) -> None:
        nonlocal hits, scanned
        scanned += 1
        result = model.predict(frame, conf=conf, device=device, verbose=False)[0]
        boxes = _boxes(result, conf)
        if not boxes:
            return
        cv2.imwrite(str(images_out / f"{name}.jpg"), frame)
        annotated = frame.copy()
        draw_detections(annotated, boxes)
        cv2.imwrite(str(previews_out / f"{name}.jpg"), annotated)
        hits += 1

    videos = _collect_videos(source)
    for video in videos:
        cap = cv2.VideoCapture(str(video))
        if not cap.isOpened():
            console.print(f"[yellow]skip[/] {video.name}: cannot open")
            continue
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                handle(frame, f"{video.stem}_{idx:06d}")
            idx += 1
        cap.release()

    if source.is_dir():
        for image in iter_images(source):
            frame = cv2.imread(str(image))
            if frame is not None:
                handle(frame, image.stem)
    elif source.is_file() and is_image(source):
        frame = cv2.imread(str(source))
        if frame is not None:
            handle(frame, source.stem)

    if scanned == 0:
        console.print(f"[yellow]nothing to do[/] no videos or images under {source}")
        return

    console.print(f"[green]done[/] {hits}/{scanned} frames had detections")
    console.print(f"  review:    {previews_out}")
    console.print(f"  then move wrong-detection frames from {images_out}")
    console.print(f"  into {ctx.dropin_neg_dir} and re-run `make prepare && make train`.")
