"""Install the exported ONNX model into its target driver package."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from ...context import REPO_ROOT, ModelContext
from ...util import console, find_latest


def run(ctx: ModelContext, args: Any = None) -> None:
    src_arg = getattr(args, "src", None)
    source: Path | None
    if src_arg is not None:
        source = Path(src_arg)
    elif ctx.export_path.exists():
        source = ctx.export_path
    else:
        source = find_latest(ctx.runs_dir, "best.onnx")

    if source is None or not source.exists():
        raise SystemExit("no exported ONNX found; run `gosai-train export` first")

    target = ctx.install_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    size_mb = target.stat().st_size / 1e6
    try:
        rel = target.relative_to(REPO_ROOT)
    except ValueError:
        rel = target
    console.print(f"[green]installed[/] {source} -> {target} ({size_mb:.1f} MB)")
    console.print(f"Commit {rel} to ship the model.")
