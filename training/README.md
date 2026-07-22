# GOSAI model training

A multi-model training workspace for GOSAI driver models. Each model lives under
`models/<name>/` and is built by a shared, reusable pipeline. The first model is
**`ball`** — the single-class billiard-ball detector for the `ball` driver.

It is optimized for both Apple Silicon (MPS/Metal training, CoreML export) and
NVIDIA (CUDA training, TensorRT export), with device auto-detection. It runs
natively on macOS, Linux, and Windows: `uv sync` installs the right PyTorch
build per platform (on Windows the CUDA 12.8 wheels are pulled automatically —
PyPI only ships CPU-only torch there).

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

### Windows

The pipeline runs natively on Windows (no WSL needed). `make.bat` mirrors the
Makefile, so from cmd or PowerShell:

```bat
make setup
make all
make train ball        :: model as optional second argument
```

`uv sync` installs the CUDA 12.8 torch build automatically (supports RTX 50xx).
Before a long run, confirm the GPU is seen — `train` also warns if it falls
back to CPU:

```bat
uv run python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

Everything works except the native CoreML export (`--formats coreml`), which
requires macOS; the ONNX artifact the driver uses exports on any platform.

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
make prepare      # merge/dedup/motion-blur         -> models/<m>/data/merged/
make train        # fine-tune                       -> models/<m>/runs/<name>-<timestamp>/
make eval         # metrics: test split, golden set, FP rate on no-ball frames
make mine         # hard-negative mining: frames where the model fires, for review
make export       # ONNX (+optional coreml/engine)  -> models/<m>/exports/
make install      # copy into the driver package    -> (model's install_path)
```

Every `train` creates a fresh timestamped run folder (nothing is overwritten);
`export` and `eval` pick the newest `best.pt` and print which weights (and
training date) they used, so a stale model can't be shipped silently.

## Make it work on YOUR table (the highest-impact loop)

Public datasets get the model in the ballpark; footage from your actual rig
(top-down camera, your lighting, your table) is what makes it reliable. Three
feedback loops, all optional but strongly recommended:

### 1. Add labelled footage from your rig

```bash
# Drop short clips into models/ball/data/custom/videos/ -- vary lighting,
# crowded racks, fast shots, balls near/in pockets.
make frames                # extract frames -> data/custom/images/

# Auto-draft labels with your latest model (or a base model). Also writes
# annotated previews to data/custom/previews/ for a fast visual check.
make autolabel

# Fix wrong/missing boxes (Label Studio, labelImg, or Roboflow), then retrain.
make all
```

Frames from one video always land on the same side of the train/val split, so
consecutive near-identical frames can't leak between splits.

You can also drop pre-labelled images straight into `data/custom/images/` +
`data/custom/labels/` (YOLO format; the class index is forced to `0`), and
negative/background images (no balls) into `data/negatives/`.

### 2. Mine hard negatives (kills false positives)

When the detector fires on pockets, glare, or a ball sunk in a hole, feed
those mistakes back as training signal:

```bash
make mine                                   # scans data/custom/videos
uv run gosai-train mine --source ~/clips    # or any videos/images folder
```

Review `data/mining/previews/`; for every frame with a WRONG detection, move
the same-named file from `data/mining/images/` into `data/negatives/`, then
`make prepare train`. (Policy: a ball fully inside a pocket counts as "no
ball" -- mine those frames as negatives.)

### 3. Keep a golden test set

Put labelled frames from your rig into `data/golden/images` + `data/golden/labels`
(and some no-ball frames with empty label files). They are **never trained on**;
`make eval` reports mAP/precision/recall on them plus the false-positive rate
on no-ball images -- the numbers that actually match "does it work on our
table". Use it to compare runs or base models (`yolo26s` vs `yolo26m`).

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
│                                train/eval/mine/export/install stages
│                                (sources.py = shared sample collection)
└── models/
    └── ball/
        ├── model.yaml           manifest (type, class_name, install_path, ...)
        ├── configs/             datasets / classes / negatives / train
        │                        (+ generated classes.lock.yaml for review)
        └── data/                custom/, negatives/, golden/
                                 (+ generated raw/merged/mining/...)
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

| File                | What                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| `datasets.yaml`     | Roboflow datasets to download/merge; per-dataset `cap` / `enabled`.                  |
| `classes.yaml`      | Manual `overrides:` for class `keep`/`drop` decisions.                               |
| `classes.lock.yaml` | Generated: every discovered class and its decision -- review after adding a dataset. |
| `negatives.yaml`    | Negative ratio + optional external negative sources.                                 |
| `train.yaml`        | Model size, epochs, image size, device, caching, augmentation, motion blur.          |

Tips:

- Resolution: `train.yaml` has `imgsz` (square training resolution) and
  `infer_imgsz: [h, w]` (the exported ONNX input). The `ball` model trains at
  `1280` and exports `[736, 1280]` to match real-world 720p 16:9 feeds with
  almost no letterbox padding. Lower `imgsz` to `960` if training is too slow.
- Crowded scenes / tiny objects benefit from higher `imgsz` (slower).
- Force a class decision: add it under `overrides` in `classes.yaml`, e.g.
  `cue: drop` (check `classes.lock.yaml` for what was discovered).
- One dataset dominating the merge? Give it a `cap:` in `datasets.yaml`
  (the snooker set is capped by default -- broadcast snooker is off-domain for
  a top-down pool camera).
- Moving balls: `prepare` synthesizes motion-blurred copies of a fraction of
  train positives (see `motion_blur:` in `train.yaml`). `prepare` also removes
  near-duplicate frames and prints a per-source composition table.

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
Roboflow datasets ─┐   (dedup, per-dataset caps,
custom footage ────┼─>  motion-blur synthesis)
negatives ─────────┘        │
                            v
                    prepare ─> data/merged (nc:1) ─> train (YOLO26s) ─> eval
                        ^                                  │
                        │                                  v
        mine (hard negatives from your footage) <── runs/<name>-<ts>/best.pt
                                                           │
                                                           v
   <driver>_models/<name>.onnx  <── install <── exports/<name>.onnx <── export (ONNX)
```

The exported ONNX uses YOLO26's NMS-free end-to-end head: output
`(1, 300, 6)` = `[x1, y1, x2, y2, confidence, class_id]`. The driver loads this
directly, with no NMS at runtime.
