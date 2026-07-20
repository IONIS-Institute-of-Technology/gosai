"""Model discovery and per-model paths.

Each trainable model lives under ``training/models/<name>/`` with a ``model.yaml``
manifest, a ``configs/`` folder, and a ``data/`` folder. Generated artifacts
(raw/merged datasets, runs, exports) live under the same model folder and are
git-ignored. A :class:`ModelContext` resolves all of these paths for a pipeline.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import load_yaml

# training/src/gosai_train/context.py -> training/
TRAINING_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TRAINING_ROOT.parent
MODELS_ROOT = TRAINING_ROOT / "models"

DEFAULT_TYPE = "yolo-detect"


@dataclass(frozen=True)
class ModelContext:
    """Resolved paths and manifest for a single trainable model."""

    name: str
    model_dir: Path
    manifest: dict[str, Any]

    # ── manifest-derived ──
    @property
    def type(self) -> str:
        return str(self.manifest.get("type", DEFAULT_TYPE))

    @property
    def class_name(self) -> str:
        """Single target class name written into the merged dataset."""
        return str(self.manifest.get("class_name", "object"))

    @property
    def map_all_classes(self) -> bool:
        """If true, every source class is treated as the target (no heuristic)."""
        return bool(self.manifest.get("map_all_classes", False))

    @property
    def install_path(self) -> Path:
        rel = self.manifest.get("install_path")
        if not rel:
            raise SystemExit(f"model {self.name!r}: model.yaml is missing `install_path`")
        return REPO_ROOT / rel

    @property
    def export_name(self) -> str:
        """Filename for the exported model (matches the install target)."""
        return self.install_path.name

    # ── config files ──
    @property
    def configs_dir(self) -> Path:
        return self.model_dir / "configs"

    @property
    def datasets_config(self) -> Path:
        return self.configs_dir / "datasets.yaml"

    @property
    def classes_config(self) -> Path:
        return self.configs_dir / "classes.yaml"

    @property
    def negatives_config(self) -> Path:
        return self.configs_dir / "negatives.yaml"

    @property
    def train_config(self) -> Path:
        return self.configs_dir / "train.yaml"

    # ── data (inputs) ──
    @property
    def data_dir(self) -> Path:
        return self.model_dir / "data"

    @property
    def custom_images(self) -> Path:
        return self.data_dir / "custom" / "images"

    @property
    def custom_labels(self) -> Path:
        return self.data_dir / "custom" / "labels"

    @property
    def custom_videos(self) -> Path:
        return self.data_dir / "custom" / "videos"

    @property
    def dropin_neg_dir(self) -> Path:
        return self.data_dir / "negatives"

    # ── data / artifacts (generated) ──
    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def merged_dir(self) -> Path:
        return self.data_dir / "merged"

    @property
    def neg_pool_dir(self) -> Path:
        return self.data_dir / "negatives_pool"

    @property
    def runs_dir(self) -> Path:
        return self.model_dir / "runs"

    @property
    def exports_dir(self) -> Path:
        return self.model_dir / "exports"

    @property
    def export_path(self) -> Path:
        return self.exports_dir / self.export_name


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
    return ModelContext(name=name, model_dir=model_dir, manifest=load_yaml(manifest_path))


def default_model() -> str | None:
    models = discover_models()
    if "ball" in models:
        return "ball"
    if len(models) == 1:
        return models[0]
    return None
