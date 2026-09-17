import json
import os
from argparse import Namespace
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from gosai_train.context import load_context
from gosai_train.pipelines.yolo_detect import download, install, train
from gosai_train.pipelines.yolo_detect.export import _match
from gosai_train.pipelines.yolo_detect.negatives import prune_pool
from gosai_train.pipelines.yolo_detect.provenance import sha256_file, sidecar, write_metadata
from gosai_train.pipelines.yolo_detect.weights import infer_size, resolve_weights


@pytest.fixture
def ctx(tmp_path: Path):
    return replace(
        load_context("ball"),
        runs_dir=tmp_path / "runs",
        raw_dir=tmp_path / "raw",
        datasets_config=tmp_path / "datasets.yaml",
        export_path=tmp_path / "exports" / "ball.onnx",
        install_path=tmp_path / "installed" / "ball.onnx",
    )


def test_match_pairs_each_label_with_its_best_prediction() -> None:
    # Rows are labels, columns predictions. Prediction 0 overlaps label 0 at 0.9 and
    # label 1 at 0.6; prediction 1 overlaps label 1 at 0.7; prediction 2 hits nothing.
    iou = np.array([[0.9, 0.0, 0.0], [0.6, 0.7, 0.0]])
    correct = _match(iou)
    assert correct.shape == (3, 10)
    assert correct[0].tolist() == [True] * 9 + [False]  # 0.9 passes thresholds 0.50..0.90
    assert correct[1].tolist() == [True] * 5 + [False] * 5  # 0.7 passes 0.50..0.70
    assert not correct[2].any()


def test_match_counts_a_prediction_once() -> None:
    correct = _match(np.array([[0.8], [0.8]]))
    assert correct[:, 0].tolist() == [True]


@pytest.mark.parametrize(
    ("cfg", "expected"),
    [
        ({"imgsz": 1280, "infer_imgsz": [736, 1280]}, (736, 1280)),
        ({"imgsz": 640}, (640, 640)),
        ({"imgsz": 640, "infer_imgsz": 320}, (320, 320)),
    ],
)
def test_infer_size(cfg: dict, expected: tuple[int, int]) -> None:
    assert infer_size(cfg) == expected


def test_infer_size_requires_a_size() -> None:
    with pytest.raises(SystemExit):
        infer_size({})


def test_resolve_weights_prefers_argument_then_newest_run(ctx, tmp_path: Path) -> None:
    assert resolve_weights(ctx, None, fallback="base.pt") == "base.pt"
    with pytest.raises(SystemExit):
        resolve_weights(ctx, None)

    old = ctx.runs_dir / "old" / "weights" / "best.pt"
    new = ctx.runs_dir / "new" / "weights" / "best.pt"
    for path, mtime in ((old, 1_000), (new, 2_000)):
        path.parent.mkdir(parents=True)
        path.write_bytes(b"")
        os.utime(path, (mtime, mtime))
    assert resolve_weights(ctx, None) == str(new)
    assert resolve_weights(ctx, "mine.pt") == "mine.pt"


@pytest.mark.parametrize(("value", "expected"), [(3, 3), ("latest", "latest"), ("Latest ", "latest")])
def test_requested_version(value, expected) -> None:
    assert download.requested_version({"name": "d", "version": value}) == expected


@pytest.mark.parametrize("value", [None, "3", True, 2.5])
def test_requested_version_rejects_other_values(value) -> None:
    with pytest.raises(SystemExit):
        download.requested_version({"name": "d", "version": value})


def test_newest_version() -> None:
    project = Namespace(id="w/p", versions=lambda: [Namespace(version="2"), Namespace(version="11")])
    assert download.newest_version(project) == 11


def _datasets(ctx, *entries: str) -> None:
    ctx.datasets_config.write_text(
        "format: yolov11\ndatasets:\n"
        + "".join(f"  - {{name: {e}, workspace: w, project: p, version: {v}}}\n" for e, v in entries)
    )


def _downloaded(ctx, name: str, version: int) -> None:
    dest = ctx.raw_dir / name
    dest.mkdir(parents=True)
    (dest / download.VERSION_FILE).write_text(json.dumps({"version": version}))


def test_download_skips_existing_datasets_without_an_api_key(ctx, monkeypatch, capsys) -> None:
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    _datasets(ctx, ("pinned", 3), ("floating", "latest"))
    _downloaded(ctx, "pinned", 3)
    _downloaded(ctx, "floating", 7)

    download.run(ctx, Namespace())
    assert "pin `version: 7`" in capsys.readouterr().out
    assert download.downloaded_version(ctx.raw_dir / "floating") == 7


def test_download_needs_an_api_key_only_for_missing_datasets(ctx, monkeypatch) -> None:
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    _datasets(ctx, ("present", 3), ("absent", "latest"))
    _downloaded(ctx, "present", 3)
    with pytest.raises(SystemExit, match=r"ROBOFLOW_API_KEY.*absent"):
        download.run(ctx, Namespace())


def test_download_rejects_a_different_pinned_version(ctx, monkeypatch) -> None:
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    _datasets(ctx, ("pinned", 4))
    _downloaded(ctx, "pinned", 3)
    with pytest.raises(SystemExit, match="holds version 3"):
        download.run(ctx, Namespace())


def test_downloaded_version_falls_back_to_roboflow_data_yaml(tmp_path: Path) -> None:
    (tmp_path / "data.yaml").write_text("roboflow:\n  version: 5\n")
    assert download.downloaded_version(tmp_path) == 5
    assert download.downloaded_version(tmp_path / "missing") is None


def test_write_metadata_matches_prettier_layout(tmp_path: Path) -> None:
    metadata = {
        "input": {"height": 736, "width": 1280},
        "class_names": ["ball", "cue ball, striped"],
        "datasets": None,
    }
    path = tmp_path / "ball.onnx.json"
    write_metadata(path, metadata)
    assert path.read_text() == (
        "{\n"
        '  "input": {\n'
        '    "height": 736,\n'
        '    "width": 1280\n'
        "  },\n"
        '  "class_names": ["ball", "cue ball, striped"],\n'
        '  "datasets": null\n'
        "}\n"
    )
    assert json.loads(path.read_text()) == metadata


def _exported(ctx, content: bytes, recorded_sha: str | None = None) -> None:
    ctx.export_path.parent.mkdir(parents=True)
    ctx.export_path.write_bytes(content)
    sha = recorded_sha or sha256_file(ctx.export_path)
    write_metadata(sidecar(ctx.export_path), {"schema_version": 1, "sha256": sha})


def test_install_copies_model_and_metadata(ctx) -> None:
    _exported(ctx, b"onnx bytes")
    install.run(ctx, Namespace(src=None))
    assert ctx.install_path.read_bytes() == b"onnx bytes"
    assert json.loads(sidecar(ctx.install_path).read_text())["sha256"] == sha256_file(ctx.install_path)


def test_install_rejects_sha256_mismatch(ctx) -> None:
    _exported(ctx, b"onnx bytes", recorded_sha="0" * 64)
    with pytest.raises(SystemExit, match="does not match the sha256"):
        install.run(ctx, Namespace(src=None))
    assert not ctx.install_path.exists()


def test_install_requires_metadata(ctx) -> None:
    ctx.export_path.parent.mkdir(parents=True)
    ctx.export_path.write_bytes(b"onnx bytes")
    with pytest.raises(SystemExit, match=r"onnx\.json not found"):
        install.run(ctx, Namespace(src=None))


def test_prune_pool_keeps_enabled_sources_only(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    for name in ("glare__00000.jpg", "glare__00001.jpg", "flare7k__00000.jpg", "synthetic-glare__00000.jpg"):
        (images / name).write_bytes(b"")
    assert prune_pool(tmp_path, {"glare"}) == {"glare": 2}
    assert sorted(p.name for p in images.iterdir()) == ["glare__00000.jpg", "glare__00001.jpg"]


def test_training_params_drops_pipeline_keys_and_rejects_reserved_ones() -> None:
    cfg = {"model": "yolo26s.pt", "device": "auto", "motion_blur": {}, "epochs": 5, "mosaic": 1.0}
    assert train.training_params(cfg) == {"epochs": 5, "mosaic": 1.0}
    with pytest.raises(SystemExit, match="must not set data, name"):
        train.training_params({**cfg, "data": "x.yaml", "name": "run"})
