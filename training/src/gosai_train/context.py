"""Model discovery and per-model paths.

Each trainable model lives under ``training/models/<name>/`` with a ``model.yaml``
manifest, a ``configs/`` folder and a ``data/`` folder. Generated artifacts (raw and
merged datasets, runs, exports) live in the same model folder and are git-ignored.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .util import load_yaml

# training/src/gosai_train/context.py -> training/
TRAINING_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TRAINING_ROOT.parent
MODELS_ROOT = TRAINING_ROOT / "models"

_REQUIRED_KEYS = ("type", "class_name", "install_path")


@dataclass(frozen=True)
class ModelContext:
    """Manifest values and resolved paths for one trainable model."""

    name: str
    type: str
    class_name: str
    install_path: Path
    model_dir: Path

    datasets_config: Path
    classes_config: Path
    negatives_config: Path
    train_config: Path

    custom_images: Path
    custom_labels: Path
    custom_videos: Path
    dropin_neg_dir: Path
    golden_dir: Path

    raw_dir: Path
    merged_dir: Path
    neg_pool_dir: Path
    mining_dir: Path
    custom_previews: Path
    runs_dir: Path
    exports_dir: Path
    export_path: Path
    classes_lock: Path


def discover_models() -> list[str]:
    if not MODELS_ROOT.exists():
        return []
    return sorted(p.name for p in MODELS_ROOT.iterdir() if (p / "model.yaml").exists())


def load_context(name: str) -> ModelContext:
    model_dir = MODELS_ROOT / name
    manifest_path = model_dir / "model.yaml"
    if not manifest_path.exists():
        available = ", ".join(discover_models()) or "(none)"
        raise SystemExit(f"unknown model {name!r}. Available: {available}")
    manifest = load_yaml(manifest_path)
    missing = [key for key in _REQUIRED_KEYS if not manifest.get(key)]
    if missing:
        raise SystemExit(f"{manifest_path} is missing {', '.join(missing)}")

    install_path = REPO_ROOT / str(manifest["install_path"])
    configs = model_dir / "configs"
    data = model_dir / "data"
    runs = model_dir / "runs"
    exports = model_dir / "exports"
    return ModelContext(
        name=name,
        type=str(manifest["type"]),
        class_name=str(manifest["class_name"]),
        install_path=install_path,
        model_dir=model_dir,
        datasets_config=configs / "datasets.yaml",
        classes_config=configs / "classes.yaml",
        negatives_config=configs / "negatives.yaml",
        train_config=configs / "train.yaml",
        custom_images=data / "custom" / "images",
        custom_labels=data / "custom" / "labels",
        custom_videos=data / "custom" / "videos",
        dropin_neg_dir=data / "negatives",
        golden_dir=data / "golden",
        raw_dir=data / "raw",
        merged_dir=data / "merged",
        neg_pool_dir=data / "negatives_pool",
        mining_dir=data / "mining",
        custom_previews=data / "custom" / "previews",
        runs_dir=runs,
        exports_dir=exports,
        export_path=exports / install_path.name,
        classes_lock=runs / "classes.lock.yaml",
    )


def default_model() -> str | None:
    """The only model, or None when there are several (then `--model` is required)."""
    models = discover_models()
    return models[0] if len(models) == 1 else None
