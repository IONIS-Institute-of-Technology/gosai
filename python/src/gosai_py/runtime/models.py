"""Model files that drivers load.

A driver declares each model as a ``Model``: either a file bundled inside the
package, or a URL downloaded on first use into ``$GOSAI_HOME/models`` (default
``~/.gosai/models``). ``resolve_model`` returns a local path after checking it:

- A bundled file that is still a Git LFS pointer raises with the fix.
- A declared sha256 must match. Bundled models without one use the ``sha256``
  from a ``<file>.json`` sidecar when present, such as the ``ball.onnx.json``
  that the training pipeline writes on install.
- A cached download that doesn't match is downloaded again.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

type LogFn = Callable[[str, str], None]

LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"
DOWNLOAD_TIMEOUT_S = 60.0

_download_locks: dict[str, threading.Lock] = {}
_download_locks_guard = threading.Lock()


class ModelUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class Model:
    """A bundled file (``path``) or a downloaded one (``url``), never both."""

    filename: str
    sha256: str | None = None
    url: str | None = None
    path: Path | None = None

    def __post_init__(self) -> None:
        if (self.url is None) == (self.path is None):
            raise ValueError(f"model {self.filename}: set exactly one of url and path")
        if self.url is not None and self.sha256 is None:
            raise ValueError(f"model {self.filename}: downloaded models need a sha256")

    @classmethod
    def bundled(cls, path: Path, sha256: str | None = None) -> Model:
        return cls(filename=path.name, sha256=sha256, path=path)

    @classmethod
    def download(cls, filename: str, url: str, sha256: str) -> Model:
        return cls(filename=filename, sha256=sha256, url=url)


def models_dir() -> Path:
    override = os.environ.get("GOSAI_HOME")
    home = Path(override).expanduser().resolve() if override else Path.home() / ".gosai"
    return home / "models"


def is_lfs_pointer(path: Path) -> bool:
    with path.open("rb") as fp:
        return fp.read(len(LFS_POINTER_PREFIX)) == LFS_POINTER_PREFIX


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fp:
        while chunk := fp.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_metadata(path: Path) -> dict[str, Any] | None:
    """Return the ``<file>.json`` sidecar next to a model, if there is one."""
    sidecar = path.with_name(path.name + ".json")
    if not sidecar.exists():
        return None
    data = json.loads(sidecar.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ModelUnavailableError(f"{sidecar} must contain a JSON object")
    return data


def resolve_model(model: Model, log_fn: LogFn) -> Path:
    if model.path is not None:
        return _check_bundled(model, model.path)
    return _ensure_download(model, log_fn)


def _check_bundled(model: Model, path: Path) -> Path:
    if not path.exists():
        raise ModelUnavailableError(f"model {model.filename} not found at {path}")
    if is_lfs_pointer(path):
        raise ModelUnavailableError(
            f"model {path} is a Git LFS pointer, not the model. Run `git lfs pull`."
        )
    expected = model.sha256
    if expected is None:
        metadata = read_metadata(path)
        expected = metadata.get("sha256") if metadata else None
    if expected is not None:
        actual = file_sha256(path)
        if actual != expected:
            raise ModelUnavailableError(f"model {path} has sha256 {actual}, expected {expected}")
    return path


def _download_lock(filename: str) -> threading.Lock:
    with _download_locks_guard:
        return _download_locks.setdefault(filename, threading.Lock())


def _ensure_download(model: Model, log_fn: LogFn) -> Path:
    assert model.url is not None and model.sha256 is not None
    target = models_dir() / model.filename
    # Drivers in one bridge share this lock. Each download also writes its own
    # temp file and renames it into place, so other processes can't collide.
    with _download_lock(model.filename):
        if target.exists():
            if file_sha256(target) == model.sha256:
                return target
            log_fn("warn", f"cached {model.filename} doesn't match its sha256; downloading again")
        target.parent.mkdir(parents=True, exist_ok=True)
        _download(model, target, log_fn)
    return target


def _download(model: Model, target: Path, log_fn: LogFn) -> None:
    assert model.url is not None
    log_fn("info", f"downloading {model.filename} from {model.url}")
    fd, part_name = tempfile.mkstemp(
        dir=target.parent, prefix=f".{model.filename}.", suffix=".part"
    )
    part = Path(part_name)
    try:
        with (
            os.fdopen(fd, "wb") as fp,
            urllib.request.urlopen(model.url, timeout=DOWNLOAD_TIMEOUT_S) as response,
        ):
            while chunk := response.read(1024 * 1024):
                fp.write(chunk)
        actual = file_sha256(part)
        if actual != model.sha256:
            raise ModelUnavailableError(
                f"download of {model.filename} has sha256 {actual}, expected {model.sha256}"
            )
        os.replace(part, target)
    except OSError as exc:
        raise ModelUnavailableError(
            f"could not download {model.filename} from {model.url}: {exc}"
        ) from exc
    finally:
        part.unlink(missing_ok=True)
    log_fn("info", f"downloaded {model.filename}")
