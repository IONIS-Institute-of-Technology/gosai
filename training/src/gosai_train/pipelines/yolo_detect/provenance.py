"""Provenance records that follow a model from `prepare` to `install`.

- `prepare` writes ``merged/datasets.json``: dataset name to Roboflow version.
- `train` writes ``runs/<run>/provenance.json``: run name, base weights, git state, datasets.
- `export` writes ``exports/<model>.onnx.json`` (see :func:`model_metadata`).
- `install` verifies its sha256 and copies it next to the installed model.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from ...context import REPO_ROOT

DATASETS_FILE = "datasets.json"
RUN_FILE = "provenance.json"
SCHEMA_VERSION = 1


def sidecar(model_path: Path) -> Path:
    """``ball.onnx`` -> ``ball.onnx.json``."""
    return model_path.with_name(model_path.name + ".json")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_state() -> dict[str, str | bool]:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()

    return {"git_sha": git("rev-parse", "HEAD"), "git_dirty": bool(git("status", "--porcelain"))}
