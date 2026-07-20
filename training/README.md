# GOSAI model training

A multi-model training workspace for GOSAI driver models. Each model lives under
`models/<name>/` and is built by a shared, reusable pipeline. The first model is
**`ball`** — the single-class billiard-ball detector for the `ball` driver.

It is optimized for both Apple Silicon (MPS/Metal training, CoreML export) and
NVIDIA (CUDA training, TensorRT export), with device auto-detection.

## Quick start (ball model)

```bash
cd training

# 1. Roboflow API key (https://app.roboflow.com/settings/api)
export ROBOFLOW_API_KEY=...        # or copy .env.example to .env and fill it in

# 2. Install dependencies (creates .venv via uv)
make setup

# 3. Run the whole pipeline for the default model (ball)
make all
```

`make all` runs: `download -> negatives -> prepare -> train -> export -> install`.
When it finishes, commit the produced model so it ships with the app:

```bash
git add python/src/gosai_py/drivers/ball_models/ball.onnx
```

> Requirements: [uv](https://docs.astral.sh/uv/) and Python 3.12. Training needs
> a GPU (NVIDIA) or Apple Silicon for reasonable speed; CPU works but is slow.

## Choosing a model

Every command targets one model. Pick it with `MODEL=` (Make) or `--model` (CLI);
the default is `ball`.

```bash
make all                      # ball
make train MODEL=ball         # explicit
uv run gosai-train models     # list available models
uv run gosai-train --model ball all
```

## Single steps

```bash
make download     # fetch Roboflow datasets        -> models/<m>/data/raw/
make negatives    # optional external negatives     -> models/<m>/data/negatives_pool/
make prepare      # merge into single class         -> models/<m>/data/merged/
make train        # fine-tune                       -> models/<m>/runs/
make export       # ONNX (+optional coreml/engine)  -> models/<m>/exports/
make install      # copy into the driver package    -> (model's install_path)
```

## Add your own footage (optional, never required)

The pipeline trains fine without any custom data. To add your own (paths shown
for the `ball` model):

```bash
# 1. Drop video clips into models/ball/data/custom/videos/
make frames                # extract frames -> models/ball/data/custom/images/

# 2. Auto-draft labels with your latest model (or a base model)
make autolabel             # writes YOLO labels -> models/ball/data/custom/labels/

# 3. Spot-check / fix the drafted boxes (free tools: Label Studio, labelImg,
#    or Roboflow), then retrain
make all
```

You can also drop:

- pre-labelled images straight into `data/custom/images/` + `data/custom/labels/`
  (labels in YOLO format; the class index is forced to `0`).
- negative/background images (no target objects) into `data/negatives/`.

## Repository layout

```
training/
├── Makefile                     MODEL ?= ball; thin wrapper over the CLI
├── pyproject.toml               uv project (ultralytics, roboflow, onnx, ...)
├── src/gosai_train/
│   ├── cli.py                   `gosai-train [--model NAME] <command>`
│   ├── context.py               ModelContext: per-model paths + manifest
│   ├── registry.py              model `type` -> pipeline
│   ├── devices.py               CUDA / MPS / CPU auto-detect
│   ├── util.py                  shared IO helpers
│   └── pipelines/
│       └── yolo_detect/         download/negatives/prepare/frames/autolabel/
│                                train/export/install stages
└── models/
    └── ball/
        ├── model.yaml           manifest (type, class_name, install_path, ...)
        ├── configs/             datasets / classes / negatives / train
        └── data/                custom/, negatives/ (+ generated raw/merged/...)
```

## Add a new model

1. Create a folder `models/<name>/` with a `model.yaml`:

   ```yaml
   name: <name>
   type: yolo-detect # reuses the YOLO detector pipeline
   class_name: <thing> # single class written into the dataset
   map_all_classes:
     true # true: every labelled class IS the target;
     # false: use configs/classes.yaml + heuristic
   install_path: python/src/gosai_py/drivers/<driver>_models/<name>.onnx
   ```

2. Add `models/<name>/configs/` (`datasets.yaml`, `classes.yaml`, `negatives.yaml`,
   `train.yaml`) — copy the `ball` ones as a starting point.
3. Create `models/<name>/data/{custom/{images,labels,videos},negatives}/` with
   `.gitkeep` files.
4. If the driver loads bundled models, add the artifact glob in
   `python/pyproject.toml` (like `ball_models/*.onnx`).
5. Run it: `make all MODEL=<name>`.

For a fundamentally different task (e.g. pose or classification), add a new
pipeline package under `src/gosai_train/pipelines/` and register its `type` in
`registry.py`.

## Configuration (per model, under `models/<name>/configs/`)

| File             | What                                                              |
| ---------------- | ----------------------------------------------------------------- |
| `datasets.yaml`  | Roboflow datasets to download/merge (add more here).              |
| `classes.yaml`   | Per-class `keep`/`drop` mapping; auto-filled, review `overrides`. |
| `negatives.yaml` | Negative ratio + optional external negative sources.              |
| `train.yaml`     | Model size, epochs, image size, device, augmentation.             |

Tips:

- Resolution: `train.yaml` has `imgsz` (square training resolution) and
  `infer_imgsz: [h, w]` (the exported ONNX input). The `ball` model trains at
  `1280` and exports `[736, 1280]` to match real-world 720p 16:9 feeds with
  almost no letterbox padding. Lower `imgsz` to `960` if training is too slow.
- Crowded scenes / tiny objects benefit from higher `imgsz` (slower).
- Force a class decision: add it under `overrides` in `classes.yaml`, e.g.
  `cue: drop`.

## Runtime backends (inference)

Training always runs in PyTorch (CUDA on NVIDIA, MPS/Metal on Apple) — TensorRT
and CoreML are **not** training backends, they are inference/export targets, so
there is only ever one trained model.

For inference, the driver ships a **single ONNX model** and runs it under the
fastest available ONNX Runtime _execution provider_. This keeps all the
pre/post-processing code shared and lets one artifact run everywhere:

| Host                | Auto backend                     | Notes                                 |
| ------------------- | -------------------------------- | ------------------------------------- |
| NVIDIA              | TensorRT EP → CUDA EP            | TensorRT compiles+caches on first run |
| Apple Silicon (mac) | CoreML EP (Neural Engine/GPU)    | falls back to CPU for unsupported ops |
| other               | CPU (only if explicitly allowed) | `GOSAI_ALLOW_CPU_FALLBACK=1`          |

Override with `GOSAI_ACCELERATOR=auto|tensorrt|cuda|coreml|dml|cpu`. TensorRT
caches engines under `GOSAI_TRT_CACHE_DIR` (default `~/.cache/gosai/trt`).

This EP approach captures most of the TensorRT/CoreML speedup with zero extra
runtime code or dependencies. If you want to benchmark the **native** engines
(marginally faster, but device/version-specific and heavier), export them too —
they are written to `models/<m>/exports/` and are not auto-installed:

```bash
# Native CoreML package (Apple):
uv run gosai-train --model ball export --formats onnx,coreml
# Native TensorRT engine (NVIDIA; Ultralytics installs tensorrt on demand):
uv run gosai-train --model ball export --formats onnx,engine
```

## How it works (yolo-detect)

```
Roboflow datasets ─┐
custom footage ────┼─> prepare ─> data/merged (nc:1) ─> train (YOLO26s)
negatives ─────────┘                                       │
                                                           v
   <driver>_models/<name>.onnx  <── install <── exports/<name>.onnx <── export (ONNX)
```

The exported ONNX uses YOLO26's NMS-free end-to-end head: output
`(1, 300, 6)` = `[x1, y1, x2, y2, confidence, class_id]`. The driver loads this
directly, with no NMS at runtime.
