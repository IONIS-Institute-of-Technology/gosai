"""Extract frames from clips in <model>/data/custom/videos into .../images.

Optional helper for adding your own footage. Never required to train.
"""

from __future__ import annotations

from argparse import Namespace

from ...context import ModelContext
from ...util import console, iter_video_frames, iter_videos


def run(ctx: ModelContext, args: Namespace) -> None:
    import cv2

    videos = list(iter_videos(ctx.custom_videos))
    if not videos:
        console.print(f"[yellow]nothing to do[/] no videos in {ctx.custom_videos}")
        return

    ctx.custom_images.mkdir(parents=True, exist_ok=True)
    total = 0
    for video in videos:
        saved = 0
        for idx, frame in iter_video_frames(video, args.step):
            cv2.imwrite(str(ctx.custom_images / f"{video.stem}_{idx:06d}.jpg"), frame)
            saved += 1
        total += saved
        console.print(f"[cyan]{video.name}[/]: {saved} frames (every {args.step})")

    console.print(f"[green]done[/] {total} frames in {ctx.custom_images}")
    console.print("Next: `gosai-train autolabel` to draft labels, then spot-check them.")
