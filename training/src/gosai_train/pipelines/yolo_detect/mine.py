"""Mine hard negatives: run the trained model over footage and collect the
frames where it fires, for human review.

This closes the false-positive loop: frames where the detector fires on
non-balls (pockets, glare, light spots, a ball sunk in a hole) become
training negatives.

    gosai-train mine --source path/to/videos_or_images

Output (under <model>/data/mining/):
    previews/   annotated frames to review
    images/     the matching raw frames

For every preview showing a wrong detection, move the same-named file from
``mining/images/`` into ``data/negatives/``; the next `prepare` folds it in.
Delete frames with correctly detected balls, or keep them for `autolabel` as
extra positives.
"""

from __future__ import annotations

import shutil
from argparse import Namespace
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, is_image, iter_images, iter_video_frames, iter_videos, load_yaml
from .preview import draw_detections
from .weights import print_weights, resolve_weights


def run(ctx: ModelContext, args: Namespace) -> None:
    import cv2

    source = Path(args.source) if args.source else ctx.custom_videos
    if not source.exists():
        raise SystemExit(f"source not found: {source}")

    weights = resolve_weights(ctx, args.weights)
    print_weights("weights", weights)

    images_out = ctx.mining_dir / "images"
    previews_out = ctx.mining_dir / "previews"
    if ctx.mining_dir.exists():
        shutil.rmtree(ctx.mining_dir)
    images_out.mkdir(parents=True)
    previews_out.mkdir(parents=True)

    from ultralytics import YOLO

    model = YOLO(weights)
    device = resolve_device(load_yaml(ctx.train_config))
    console.print(f"[cyan]mine[/] {source} (conf>={args.conf}, every {args.step} frames)")

    hits = scanned = 0

    def handle(frame: Any, name: str) -> None:
        nonlocal hits, scanned
        scanned += 1
        # nms=False runs the NMS-free end-to-end head, the one `export` ships.
        result = model.predict(frame, conf=args.conf, device=device, nms=False, verbose=False)[0]
        boxes = [(*box.xyxy[0].tolist(), float(box.conf.item())) for box in result.boxes]
        if not boxes:
            return
        cv2.imwrite(str(images_out / f"{name}.jpg"), frame)
        annotated = draw_detections(frame.copy(), boxes)
        cv2.imwrite(str(previews_out / f"{name}.jpg"), annotated)
        hits += 1

    for video in iter_videos(source):
        for idx, frame in iter_video_frames(video, args.step):
            handle(frame, f"{video.stem}_{idx:06d}")

    stills = list(iter_images(source)) if source.is_dir() else [source] if is_image(source) else []
    for image in stills:
        frame = cv2.imread(str(image))
        if frame is not None:
            handle(frame, image.stem)

    if scanned == 0:
        console.print(f"[yellow]nothing to do[/] no videos or images under {source}")
        return

    console.print(f"[green]done[/] {hits}/{scanned} frames had detections")
    console.print(f"  review:    {previews_out}")
    console.print(f"  then move wrong-detection frames from {images_out}")
    console.print(f"  into {ctx.dropin_neg_dir} and re-run `gosai-train prepare` and `gosai-train train`.")
