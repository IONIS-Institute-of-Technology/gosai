"""Download the configured Roboflow datasets into <model>/data/raw/<name>."""

from __future__ import annotations

import os
from argparse import Namespace
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, load_yaml


def pinned_version(entry: dict[str, Any]) -> int:
    """The dataset version pinned in datasets.yaml. Unpinned versions are rejected."""
    version = entry.get("version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise SystemExit(
            f"dataset {entry.get('name')!r}: pin an integer `version:` in datasets.yaml "
            f"(got {version!r}). Pick one from the project's Versions page on Roboflow Universe."
        )
    return version


def downloaded_version(dataset_dir: Path) -> int | None:
    """Version recorded by Roboflow in a downloaded dataset's data.yaml, if any."""
    version = (load_yaml(dataset_dir / "data.yaml").get("roboflow") or {}).get("version")
    return int(version) if version is not None else None


def run(ctx: ModelContext, args: Namespace) -> None:
    cfg = load_yaml(ctx.datasets_config)
    fmt = cfg["format"]
    datasets = cfg.get("datasets") or []
    if not datasets:
        raise SystemExit(f"no datasets configured in {ctx.datasets_config}")
    enabled = [entry for entry in datasets if entry.get("enabled", True)]
    versions = {entry["name"]: pinned_version(entry) for entry in enabled}

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if not api_key:
        raise SystemExit(
            "ROBOFLOW_API_KEY is not set.\n"
            "  export ROBOFLOW_API_KEY=...   or copy training/.env.example to training/.env and run\n"
            "  uv run --env-file .env gosai-train download"
        )

    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    ctx.raw_dir.mkdir(parents=True, exist_ok=True)

    for entry in datasets:
        name = entry["name"]
        if name not in versions:
            console.print(f"[dim]skip {name}: disabled in datasets.yaml[/]")
            continue
        version = versions[name]
        dest = ctx.raw_dir / name

        if dest.exists() and any(dest.iterdir()):
            have = downloaded_version(dest)
            if have != version:
                raise SystemExit(
                    f"{dest} holds version {have}, but datasets.yaml pins {version}. "
                    "Delete it (or run `gosai-train clean`) and download again."
                )
            console.print(f"[yellow]skip[/] {name}: version {version} already at {dest}")
            continue

        console.print(f"[cyan]download[/] {name} ({entry['workspace']}/{entry['project']}) version {version}")
        project = rf.workspace(entry["workspace"]).project(entry["project"])
        project.version(version).download(fmt, location=str(dest))

    console.print(f"[green]done[/] datasets in {ctx.raw_dir}")
