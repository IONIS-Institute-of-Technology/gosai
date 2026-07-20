"""Extract frames from clips in <model>/data/custom/videos into .../images.

Optional helper for adding your own footage. Never required to train.
"""

from __future__ import annotations

from typing import Any

from ...context import ModelContext
from ...util import VIDEO_EXTS, console


def run(ctx: ModelContext, args: Any = None) -> None:
    import cv2  # type: ignore[import-not-found]

    step = max(1, int(getattr(args, "step", 15) or 15))

    videos = [
        p for p in sorted(ctx.custom_videos.rglob("*"))
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    ]
    if not videos:
        console.print(f"[yellow]nothing to do[/] no videos in {ctx.custom_videos}")
        return

    ctx.custom_images.mkdir(parents=True, exist_ok=True)
    total = 0
    for video in videos:
        cap = cv2.VideoCapture(str(video))
        if not cap.isOpened():
            console.print(f"[yellow]skip[/] {video.name}: cannot open")
            continue
        idx = saved = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                out = ctx.custom_images / f"{video.stem}_{idx:06d}.jpg"
                cv2.imwrite(str(out), frame)
                saved += 1
            idx += 1
        cap.release()
        total += saved
        console.print(f"[cyan]{video.name}[/]: {saved} frames (every {step})")

    console.print(f"[green]done[/] {total} frames in {ctx.custom_images}")
    console.print("Next: `gosai-train autolabel` to draft labels, then spot-check them.")
