"""Export the trained model to ONNX (default) and optionally CoreML/TensorRT.

The ONNX export is the runtime target for the driver: YOLO26 exports an NMS-free
end-to-end head with output (1, 300, 6) = [x1, y1, x2, y2, conf, cls]. After
export we run validation and an ONNX Runtime smoke check.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from ...context import ModelContext
from ...devices import resolve_device
from ...util import console, find_latest, load_yaml


def _letterbox(img, size: tuple[int, int]):
    import cv2  # type: ignore[import-not-found]

    ih, iw = size
    h, w = img.shape[:2]
    scale = min(ih / h, iw / w)
    nw, nh = round(w * scale), round(h * scale)
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    top, left = (ih - nh) // 2, (iw - nw) // 2
    canvas = cv2.copyMakeBorder(
        resized, top, ih - nh - top, left, iw - nw - left,
        cv2.BORDER_CONSTANT, value=(114, 114, 114),
    )
    return canvas


def _onnx_smoke(ctx: ModelContext, onnx_path: Path, size: tuple[int, int]) -> None:
    import cv2  # type: ignore[import-not-found]
    import numpy as np  # type: ignore[import-not-found]
    import onnxruntime as ort  # type: ignore[import-not-found]

    sample = next(iter(sorted((ctx.merged_dir / "val" / "images").glob("*"))), None)
    if sample is None:
        try:
            from ultralytics.utils import ASSETS  # type: ignore[import-not-found]

            sample = ASSETS / "bus.jpg"
        except Exception:
            console.print("[yellow]smoke[/] no sample image available; skipping")
            return

    img = cv2.imread(str(sample))
    if img is None:
        console.print("[yellow]smoke[/] could not read sample image; skipping")
        return

    tensor = _letterbox(img, size)
    tensor = cv2.cvtColor(tensor, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(np.transpose(tensor, (2, 0, 1))[np.newaxis, ...])

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    out = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    arr = np.asarray(out)
    console.print(f"[cyan]smoke[/] output shape {arr.shape}")
    if arr.ndim == 3 and arr.shape[-1] == 6:
        conf = arr[0][:, 4]
        console.print(
            f"        NMS-free head OK, {int((conf >= 0.25).sum())} detections >= 0.25 "
            f"on {Path(str(sample)).name}"
        )
    else:
        console.print(
            "[yellow]smoke[/] unexpected output shape (expected (1, 300, 6)). "
            "ball.py expects the YOLO26 end-to-end head."
        )


def run(ctx: ModelContext, args: Any = None) -> None:
    formats_raw = getattr(args, "formats", None) or "onnx"
    formats = [f.strip() for f in str(formats_raw).split(",") if f.strip()]
    weights = getattr(args, "weights", None)

    cfg = load_yaml(ctx.train_config)
    # Inference/export resolution: rectangular [h, w] (e.g. 720p 16:9) when set,
    # else fall back to the square training imgsz. Both dims must be /32.
    raw_imgsz = cfg.get("infer_imgsz") or cfg.get("imgsz", 640)
    if isinstance(raw_imgsz, (list, tuple)):
        size = (int(raw_imgsz[0]), int(raw_imgsz[1]))
        export_imgsz: Any = [size[0], size[1]]
    else:
        size = (int(raw_imgsz), int(raw_imgsz))
        export_imgsz = int(raw_imgsz)
    val_imgsz = max(size)

    if weights is None:
        latest = find_latest(ctx.runs_dir, "best.pt")
        if latest is None:
            raise SystemExit("no trained weights found; run `gosai-train train` first")
        weights = str(latest)
    console.print(f"[cyan]export[/] {weights} -> {', '.join(formats)} (imgsz={export_imgsz})")

    from ultralytics import YOLO  # type: ignore[import-not-found]

    model = YOLO(weights)
    outputs: dict[str, str] = {}
    for fmt in formats:
        kwargs: dict[str, Any] = {"format": fmt, "imgsz": export_imgsz}
        if fmt == "onnx":
            # Universal artifact; ONNX Runtime accelerates it via TensorRT/CoreML EPs.
            kwargs["simplify"] = True
        elif fmt == "engine":
            # Native TensorRT engine (NVIDIA only, device/driver-specific).
            kwargs["half"] = True
            kwargs["device"] = resolve_device(cfg.get("device", "auto"))
        elif fmt == "coreml":
            # Native CoreML package (Apple Neural Engine/GPU).
            kwargs["half"] = True
        path = model.export(**kwargs)
        outputs[fmt] = str(path)
        console.print(f"  [green]{fmt}[/] -> {path}")

    if "onnx" in outputs:
        ctx.exports_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(outputs["onnx"], ctx.export_path)
        console.print(f"  copied onnx -> {ctx.export_path}")

    data_yaml = ctx.merged_dir / "data.yaml"
    if data_yaml.exists():
        try:
            metrics = model.val(
                data=str(data_yaml), imgsz=val_imgsz,
                device=resolve_device(cfg.get("device", "auto")), verbose=False,
            )
            box = getattr(metrics, "box", None)
            if box is not None:
                console.print(
                    f"[cyan]val[/] mAP50={box.map50:.3f} mAP50-95={box.map:.3f} "
                    f"P={box.mp:.3f} R={box.mr:.3f}"
                )
        except Exception as exc:  # pragma: no cover
            console.print(f"[yellow]warn[/] validation failed: {exc!r}")

    if "onnx" in outputs:
        _onnx_smoke(ctx, ctx.export_path, size)

    console.print("[green]done[/] export. Next: `gosai-train install`")
