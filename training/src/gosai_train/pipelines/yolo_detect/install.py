"""Install the exported ONNX model and its metadata into the target driver package."""

from __future__ import annotations

import json
import shutil
from argparse import Namespace
from pathlib import Path

from ...context import REPO_ROOT, ModelContext
from ...util import console
from .provenance import sha256_file, sidecar, write_metadata


def run(ctx: ModelContext, args: Namespace) -> None:
    source = Path(args.src) if args.src else ctx.export_path
    if not source.exists():
        raise SystemExit(f"{source} not found; run `gosai-train export` first")
    metadata_path = sidecar(source)
    if not metadata_path.exists():
        raise SystemExit(f"{metadata_path} not found; `gosai-train export` writes it next to the model")
    metadata = json.loads(metadata_path.read_text())
    if metadata.get("sha256") != sha256_file(source):
        raise SystemExit(f"{source} does not match the sha256 in {metadata_path}; export again")

    target = ctx.install_path
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    write_metadata(sidecar(target), metadata)

    rel = target.relative_to(REPO_ROOT) if target.is_relative_to(REPO_ROOT) else target
    console.print(f"[green]installed[/] {source} -> {target} ({target.stat().st_size / 1e6:.1f} MB)")
    console.print(f"Commit {rel} and {rel}.json to ship the model.")
