"""Download the configured Roboflow datasets into <model>/data/raw/<name>."""

from __future__ import annotations

import json
import os
from argparse import Namespace
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...util import console, load_yaml

VERSION_FILE = "gosai-dataset.json"


def requested_version(entry: dict[str, Any]) -> int | str:
    """The ``version`` from datasets.yaml: an integer pin, or ``"latest"``."""
    version = entry.get("version")
    if isinstance(version, int) and not isinstance(version, bool):
        return version
    if isinstance(version, str) and version.strip().lower() == "latest":
        return "latest"
    raise SystemExit(
        f"dataset {entry.get('name')!r}: `version` must be an integer or `latest` (got {version!r})"
    )


def downloaded_version(dataset_dir: Path) -> int | None:
    """Version recorded in ``raw/<name>/``: our marker, else Roboflow's data.yaml."""
    marker = dataset_dir / VERSION_FILE
    if marker.exists():
        return int(json.loads(marker.read_text())["version"])
    version = (load_yaml(dataset_dir / "data.yaml").get("roboflow") or {}).get("version")
    return int(version) if version is not None else None


def newest_version(project: Any) -> int:
    """Newest version number of a Roboflow project."""
    numbers = [int(v.version) for v in project.versions() if str(v.version).isdigit()]
    if not numbers:
        raise SystemExit(f"Roboflow project {project.id!r} has no versions")
    return max(numbers)


def _warn_unpinned(name: str, version: int | None) -> None:
    console.print(
        f"[bold yellow]warning[/] {name}: datasets.yaml asks for `version: latest`; "
        f"pin `version: {version if version is not None else 'N'}` so training runs are reproducible"
    )


def run(ctx: ModelContext, args: Namespace) -> None:
    cfg = load_yaml(ctx.datasets_config)
    datasets = cfg.get("datasets") or []
    if not datasets:
        raise SystemExit(f"no datasets configured in {ctx.datasets_config}")

    missing: list[tuple[dict[str, Any], int | str]] = []
    for entry in datasets:
        name = entry["name"]
        if not entry.get("enabled", True):
            console.print(f"[dim]skip {name}: disabled in datasets.yaml[/]")
            continue
        requested = requested_version(entry)
        dest = ctx.raw_dir / name
        if not (dest.exists() and any(dest.iterdir())):
            missing.append((entry, requested))
            continue
        have = downloaded_version(dest)
        if requested == "latest":
            _warn_unpinned(name, have)
        elif have is not None and have != requested:
            raise SystemExit(
                f"{dest} holds version {have}, but datasets.yaml pins {requested}. "
                "Delete it (or run `gosai-train clean`) and download again."
            )
        console.print(
            f"[yellow]skip[/] {name}: version {have if have is not None else '?'} already at {dest}"
        )

    if not missing:
        console.print(f"[green]done[/] datasets in {ctx.raw_dir}")
        return

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if not api_key:
        names = ", ".join(entry["name"] for entry, _ in missing)
        raise SystemExit(
            f"ROBOFLOW_API_KEY is not set and these datasets need downloading: {names}\n"
            "  export ROBOFLOW_API_KEY=...   or copy training/.env.example to training/.env and run\n"
            "  uv run --env-file .env gosai-train download"
        )

    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)
    for entry, requested in missing:
        name = entry["name"]
        dest = ctx.raw_dir / name
        project = rf.workspace(entry["workspace"]).project(entry["project"])
        version = newest_version(project) if requested == "latest" else int(requested)
        if requested == "latest":
            _warn_unpinned(name, version)
        console.print(
            f"[cyan]download[/] {name} ({entry['workspace']}/{entry['project']}) version {version}"
        )
        project.version(version).download(cfg["format"], location=str(dest))
        (dest / VERSION_FILE).write_text(
            json.dumps(
                {"workspace": entry["workspace"], "project": entry["project"], "version": version},
                indent=2,
            )
            + "\n"
        )

    console.print(f"[green]done[/] datasets in {ctx.raw_dir}")
