"""Export the trained model to ONNX (default) and optionally CoreML or TensorRT.

The ONNX export is the runtime target for the driver: YOLO26 exports an NMS-free
end-to-end head with output (1, 300, 6) = [x1, y1, x2, y2, conf, cls]. After
export the ONNX file itself is smoke-tested and scored on the merged test split
(val when there is no test split),
and ``exports/<model>.onnx.json`` records its provenance for `install`.
"""

from __future__ import annotations

import json
import shutil
from argparse import Namespace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, iter_images, load_yaml, paths_source
from .provenance import RUN_FILE, SCHEMA_VERSION, sha256_file, sidecar, write_metadata
from .sources import read_label_rows
from .weights import infer_size, print_weights, resolve_weights

_IOU_THRESHOLDS = [0.5 + 0.05 * i for i in range(10)]


def _letterbox(img: Any, size: tuple[int, int]) -> Any:
    """Resize with aspect-preserving padding to (height, width), as the ball driver does.

    The driver keeps its own copy in ``python/src/gosai_py/drivers/ball.py``.
    Golden-value tests on both sides fail until the two agree.
    """
    import cv2

    ih, iw = size
    h, w = img.shape[:2]
    scale = min(ih / h, iw / w)
    nw, nh = round(w * scale), round(h * scale)
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    top, left = (ih - nh) // 2, (iw - nw) // 2
    return cv2.copyMakeBorder(
        resized,
        top,
        ih - nh - top,
        left,
        iw - nw - left,
        cv2.BORDER_CONSTANT,
        value=(114, 114, 114),
    )


def _onnx_smoke(ctx: ModelContext, onnx_path: Path, size: tuple[int, int]) -> None:
    import cv2
    import numpy as np
    import onnxruntime as ort
    from ultralytics.utils import ASSETS

    sample = next(iter_images(ctx.merged_dir / "val" / "images"), ASSETS / "bus.jpg")
    img = cv2.imread(str(sample))
    if img is None:
        raise SystemExit(f"smoke test: cannot read {sample}")

    tensor = _letterbox(img, size)
    tensor = cv2.cvtColor(tensor, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(np.transpose(tensor, (2, 0, 1))[np.newaxis, ...])

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    arr = np.asarray(session.run(None, {session.get_inputs()[0].name: tensor})[0])
    console.print(f"[cyan]smoke[/] output shape {arr.shape}")
    if arr.ndim != 3 or arr.shape[-1] != 6:
        raise SystemExit(
            "smoke test: unexpected ONNX output shape (expected (1, 300, 6)); "
            "the ball driver expects the YOLO26 end-to-end head"
        )
    console.print(
        f"        NMS-free head OK, {int((arr[0][:, 4] >= 0.25).sum())} detections >= 0.25 "
        f"on {sample.name}"
    )


def _match(iou: Any) -> Any:
    """True-positive flags ``(predictions, IoU thresholds)``, matched greedily by IoU like Ultralytics."""
    import numpy as np

    correct = np.zeros((iou.shape[1], len(_IOU_THRESHOLDS)), dtype=bool)
    for i, threshold in enumerate(_IOU_THRESHOLDS):
        matches = np.array(np.nonzero(iou >= threshold)).T  # rows of (label, prediction)
        if matches.shape[0]:
            matches = matches[iou[matches[:, 0], matches[:, 1]].argsort()[::-1]]
            matches = matches[np.unique(matches[:, 1], return_index=True)[1]]
            matches = matches[np.unique(matches[:, 0], return_index=True)[1]]
            correct[matches[:, 1], i] = True
    return correct


def _onnx_metrics(
    ctx: ModelContext, onnx_path: Path, size: tuple[int, int]
) -> dict[str, Any] | None:
    """Score the exported ONNX file on the merged test split, or val when test is empty.

    Ultralytics' ``val()`` feeds square batches, which a fixed rectangular ONNX
    input rejects. So predictions come from ``predict()``, letterboxed to the
    export size as the driver does, and are scored with Ultralytics' AP code.
    """
    split = next(
        (s for s in ("test", "val") if any(iter_images(ctx.merged_dir / s / "images"))), None
    )
    if split is None:
        console.print(
            "[yellow]metrics[/] no merged test or val split (run `prepare`); not recorded"
        )
        return None
    images = list(iter_images(ctx.merged_dir / split / "images"))

    import numpy as np
    import torch
    from ultralytics import YOLO
    from ultralytics.utils.metrics import ap_per_class, box_iou
    from ultralytics.utils.ops import xywhn2xyxy

    labels_dir = ctx.merged_dir / split / "labels"
    tps: list[Any] = []
    confs: list[Any] = []
    targets_total = 0
    model = YOLO(str(onnx_path), task="detect")
    with paths_source("export-val", images) as source:
        results = model.predict(
            source=source,
            imgsz=list(size),
            conf=0.001,
            device="cpu",
            batch=1,
            stream=True,
            verbose=False,
        )
        for result in results:
            height, width = result.orig_shape
            rows = read_label_rows(labels_dir / f"{Path(result.path).stem}.txt")
            targets = torch.tensor([[float(v) for v in parts[1:5]] for parts in rows]).reshape(
                -1, 4
            )
            iou = box_iou(xywhn2xyxy(targets, w=width, h=height), result.boxes.xyxy.cpu())
            tps.append(_match(iou.numpy()))
            confs.append(result.boxes.conf.cpu().numpy())
            targets_total += len(rows)
    if targets_total == 0:
        console.print(
            f"[yellow]metrics[/] merged {split} split has no labelled boxes; not recorded"
        )
        return None

    tp, conf = np.concatenate(tps), np.concatenate(confs)
    # Single class: every prediction and target is class 0.
    _, _, p, r, _, ap, *_ = ap_per_class(tp, conf, np.zeros(len(conf)), np.zeros(targets_total))
    metrics = {
        "split": split,
        "images": len(images),
        "map50": round(float(ap[:, 0].mean()), 4),
        "map50_95": round(float(ap.mean()), 4),
        "precision": round(float(p.mean()), 4),
        "recall": round(float(r.mean()), 4),
    }
    console.print(
        f"[cyan]{split}[/] ONNX on {len(images)} images: mAP50={metrics['map50']:.3f} "
        f"mAP50-95={metrics['map50_95']:.3f} P={metrics['precision']:.3f} R={metrics['recall']:.3f}"
    )
    return metrics


def _run_provenance(weights: str) -> dict[str, Any]:
    """What `train` recorded for these weights (runs/<run>/weights/best.pt)."""
    record = Path(weights).resolve().parent.parent / RUN_FILE
    if record.exists():
        return json.loads(record.read_text())
    console.print(f"[yellow]warn[/] {record} not found; run, git and dataset provenance left empty")
    return {}


def run(ctx: ModelContext, args: Namespace) -> None:
    cfg = load_yaml(ctx.train_config)
    size = infer_size(cfg)
    weights = resolve_weights(ctx, args.weights)
    print_weights("weights", weights)
    console.print(f"[cyan]export[/] -> {', '.join(args.formats)} (imgsz={list(size)})")

    from ultralytics import YOLO

    model = YOLO(weights)
    onnx_export: Path | None = None
    for fmt in args.formats:
        # nms=False keeps YOLO26's NMS-free end-to-end head. Recent Ultralytics
        # releases export the raw one-to-many head unless it is set explicitly.
        kwargs: dict[str, Any] = {"format": fmt, "imgsz": list(size), "nms": False}
        if fmt == "onnx":
            # Universal artifact; ONNX Runtime accelerates it via TensorRT/CoreML EPs.
            kwargs["simplify"] = True
        elif fmt == "engine":
            # Native TensorRT engine (NVIDIA only, device/driver-specific).
            kwargs["half"] = True
            kwargs["device"] = resolve_device(cfg)
        elif fmt == "coreml":
            kwargs["half"] = True
        path = Path(model.export(**kwargs))
        console.print(f"  [green]{fmt}[/] -> {path}")
        if fmt == "onnx":
            onnx_export = path

    if onnx_export is None:
        console.print("[green]done[/] export (no ONNX, so nothing for `install`)")
        return

    ctx.exports_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx_export, ctx.export_path)
    console.print(f"  copied onnx -> {ctx.export_path}")

    _onnx_smoke(ctx, ctx.export_path, size)
    provenance = _run_provenance(weights)
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "model": ctx.name,
        "sha256": sha256_file(ctx.export_path),
        "input": {"height": size[0], "width": size[1]},
        "class_names": [ctx.class_name],
        "run": provenance.get("run"),
        "base_weights": provenance.get("base_weights"),
        "git_sha": provenance.get("git_sha"),
        "git_dirty": provenance.get("git_dirty"),
        "datasets": provenance.get("datasets"),
        "metrics": _onnx_metrics(ctx, ctx.export_path, size),
        "exported_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    write_metadata(sidecar(ctx.export_path), metadata)
    console.print("[green]done[/] export. Next: `gosai-train install`")
