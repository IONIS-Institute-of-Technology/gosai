"""Download the configured Roboflow datasets into <model>/data/raw/<name>."""

from __future__ import annotations

import os
from typing import Any

from ...context import TRAINING_ROOT, ModelContext
from ...util import console, load_env, load_yaml


def _resolve_version(project: Any, requested: Any) -> int:
    """Return an integer version number, resolving 'latest' via the API."""
    if requested is not None and str(requested).lower() != "latest":
        return int(requested)
    versions = []
    try:
        versions = project.versions()
    except Exception as exc:  # pragma: no cover - network/SDK shape
        console.print(f"[yellow]warn[/] could not list versions: {exc!r}")
    nums: list[int] = []
    for v in versions:
        raw = getattr(v, "version", None)
        if raw is None:
            continue
        tail = str(raw).split("/")[-1]
        if tail.isdigit():
            nums.append(int(tail))
    if nums:
        return max(nums)
    raise RuntimeError(
        "could not resolve 'latest' version; pin an integer `version:` in datasets.yaml"
    )


def run(ctx: ModelContext, args: Any = None) -> None:
    load_env(TRAINING_ROOT)
    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if not api_key:
        raise SystemExit(
            "ROBOFLOW_API_KEY is not set.\n"
            "  export ROBOFLOW_API_KEY=...   (or copy training/.env.example to training/.env)"
        )

    cfg = load_yaml(ctx.datasets_config)
    fmt = cfg.get("format", "yolov11")
    default_version = cfg.get("version", "latest")
    datasets = cfg.get("datasets", [])
    if not datasets:
        raise SystemExit(f"no datasets configured in {ctx.datasets_config}")

    from roboflow import Roboflow  # type: ignore[import-not-found]

    rf = Roboflow(api_key=api_key)
    ctx.raw_dir.mkdir(parents=True, exist_ok=True)

    for entry in datasets:
        name = entry["name"]
        workspace = entry["workspace"]
        project_id = entry["project"]
        dest = ctx.raw_dir / name

        if dest.exists() and any(dest.iterdir()):
            console.print(f"[yellow]skip[/] {name}: already present at {dest}")
            continue

        console.print(f"[cyan]download[/] {name}  ({workspace}/{project_id})")
        project = rf.workspace(workspace).project(project_id)
        version_num = _resolve_version(project, entry.get("version", default_version))
        console.print(f"        version {version_num}, format {fmt}")
        project.version(version_num).download(fmt, location=str(dest))

    console.print(f"[green]done[/] datasets in {ctx.raw_dir}")
