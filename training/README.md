# GOSAI model training

A multi-model training workspace for GOSAI driver models. Each model lives under
`models/<name>/` and is built by a shared pipeline. The first model is **`ball`**,
the single-class billiard-ball detector for the `ball` driver.

Training runs on NVIDIA (CUDA) and Apple Silicon (MPS) with device auto-detection,
and on CPU if nothing else is available. `uv sync` installs the right PyTorch build
per platform (on Windows it pulls the CUDA 12.8 wheels, since PyPI only ships
CPU-only torch there).

## Quick start (ball model)

```bash
cd training

# 1. Install dependencies (creates .venv)
uv sync

# 2. Roboflow API key (https://app.roboflow.com/settings/api)
cp .env.example .env               # then fill in ROBOFLOW_API_KEY

# 3. Run the whole pipeline
uv run --env-file .env gosai-train all
```

`all` runs `download`, `negatives`, `prepare`, `train`, `export` and `install`. When
it finishes, commit the model and its metadata so they ship with the app:

```bash
git add python/src/gosai_py/drivers/ball_models/ball.onnx python/src/gosai_py/drivers/ball_models/ball.onnx.json
```

Only `download` needs the API key, so later steps can drop `--env-file .env`.
Exporting `ROBOFLOW_API_KEY` in your shell works too.

> Requirements: [uv](https://docs.astral.sh/uv/) and Python 3.12. Training needs an
> NVIDIA GPU or Apple Silicon for reasonable speed; CPU works but is slow.

On Windows the same commands work from cmd or PowerShell. Before a long run, check
that the GPU is visible (`train` also warns when it falls back to CPU):

```bash
uv run python -c "import torch; print(torch.cuda.is_available())"
```

The CoreML export (`--formats coreml`) needs macOS. The ONNX file the driver uses
exports on any platform.

## Choosing a model

Every command targets one model. With a single model under `models/` it is picked
automatically; with several, pass `--model`:

```bash
uv run gosai-train models                 # list available models
uv run gosai-train --model ball all
```

## Single steps

```bash
uv run gosai-train download    # fetch Roboflow datasets        -> models/<m>/data/raw/
uv run gosai-train negatives   # glare + optional external negs -> models/<m>/data/negatives_pool/
uv run gosai-train prepare     # merge/dedup/motion-blur         -> models/<m>/data/merged/
uv run gosai-train train       # fine-tune                       -> models/<m>/runs/<name>-<timestamp>/
uv run gosai-train eval        # metrics: test split, golden set, FP rate on no-ball frames
uv run gosai-train mine        # hard-negative mining: frames where the model fires, for review
uv run gosai-train export      # ONNX (+optional coreml/engine)  -> models/<m>/exports/
uv run gosai-train install     # copy into the driver package    -> (model's install_path)
uv run gosai-train clean       # delete generated data, previews, runs and exports
```

Run `uv run gosai-train <command> --help` for each command's options.

Every `train` creates a fresh timestamped run folder, so nothing is overwritten.
`export` and `eval` pick the newest `best.pt` and print which weights (and training
date) they used, so a stale model can't be shipped silently.

## Make it work on your table

Public datasets get the model in the ballpark; footage from your actual rig
(top-down camera, your lighting, your table) is what makes it reliable. Three
feedback loops, all optional but strongly recommended:

### 1. Add labelled footage from your rig

```bash
# Drop short clips into models/ball/data/custom/videos/: vary lighting,
# crowded racks, fast shots, balls near or in pockets.
uv run gosai-train frames      # extract frames -> data/custom/images/

# Auto-draft labels with your latest model (or a base model). Also writes
# annotated previews to data/custom/previews/ for a fast visual check.
uv run gosai-train autolabel

# Fix wrong or missing boxes (Label Studio, labelImg, or Roboflow), then retrain.
uv run --env-file .env gosai-train all
```

Frames from one video always land on the same side of the train/val split, so
consecutive near-identical frames can't leak between splits.

You can also drop pre-labelled images straight into `data/custom/images/` +
`data/custom/labels/` (YOLO format; the class index is forced to `0`), and
negative/background images (no balls) into `data/negatives/`.

### 2. Mine hard negatives

When the detector fires on pockets, glare, or a ball sunk in a hole, feed those
mistakes back as training signal:

```bash
uv run gosai-train mine                     # scans data/custom/videos
uv run gosai-train mine --source ~/clips    # or any videos/images folder
```

Review `data/mining/previews/`; for every frame with a wrong detection, move the
same-named file from `data/mining/images/` into `data/negatives/`, then run
`prepare` and `train` again. A ball fully inside a pocket counts as "no ball", so
mine those frames as negatives.

### 3. Keep a golden test set

Put labelled frames from your rig into `data/golden/images` + `data/golden/labels`
(and some no-ball frames with empty label files). They are never trained on;
`eval` reports mAP, precision and recall on them plus the false-positive rate on
no-ball images. Use it to compare runs or base models (`yolo26s` vs `yolo26m`).

## Repository layout

```
training/
├── pyproject.toml               uv project (ultralytics, roboflow, onnx, ...)
├── src/gosai_train/
│   ├── cli.py                   `gosai-train [--model NAME] <command>`
│   ├── context.py               ModelContext: per-model paths + manifest
│   ├── registry.py              model `type` -> pipeline
│   ├── devices.py               CUDA / MPS / CPU selection
│   ├── util.py                  shared IO helpers
│   └── pipelines/
│       └── yolo_detect/         one module per command, plus shared
│                                sources, weights and provenance helpers
├── tests/                       unit tests (`uv run pytest`)
└── models/
    └── ball/
        ├── model.yaml           manifest (type, class_name, install_path)
        ├── configs/             datasets / classes / negatives / train
        └── data/                custom/, negatives/, golden/
                                 (+ generated raw/merged/mining/...)
```

## Add a new model

1. Create a folder `models/<name>/` with a `model.yaml`:

   ```yaml
   name: <name>
   type: yolo-detect # the only pipeline type so far
   class_name: <thing> # single class written into the dataset
   install_path: python/src/gosai_py/drivers/<driver>_models/<name>.onnx
   ```

2. Add `models/<name>/configs/` (`datasets.yaml`, `classes.yaml`, `negatives.yaml`,
   `train.yaml`). Copy the `ball` ones as a starting point.
3. Create `models/<name>/data/{custom/{images,labels,videos},negatives}/` with
   `.gitkeep` files.
4. If the driver loads bundled models, add the artifact glob in
   `python/pyproject.toml` (like `ball_models/*.onnx`).
5. Run it: `uv run --env-file .env gosai-train --model <name> all`.

For a different task (for example pose or classification), add a pipeline package
under `src/gosai_train/pipelines/` and register its `type` in `registry.py`.

## Configuration (per model, under `models/<name>/configs/`)

| File             | What                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- |
| `datasets.yaml`  | Roboflow datasets to download and merge, each with a pinned `version`; `cap`/`enabled`. |
| `classes.yaml`   | Manual `overrides:` for class `keep`/`drop` decisions.                                  |
| `negatives.yaml` | Negative ratio, glare synthesis, optional external negative sources.                    |
| `train.yaml`     | Base weights and their sha256, epochs, image size, device, augmentation, motion blur.   |

Tips:

- Resolution: `train.yaml` has `imgsz` (square training resolution) and
  `infer_imgsz: [h, w]` (the exported ONNX input). The `ball` model trains at
  `1280` and exports `[736, 1280]` to match 720p 16:9 feeds with almost no
  letterbox padding. Lower `imgsz` to `960` if training is too slow.
- `train.yaml` keys other than `model`, `model_sha256`, `device`, `infer_imgsz`
  and `motion_blur` are passed to Ultralytics as-is, so any
  [training argument](https://docs.ultralytics.com/modes/train/#train-settings)
  works. Ultralytics rejects unknown keys.
- Changing the base weights means updating `model_sha256`. Ultralytics publishes
  the digests with its `ultralytics/assets` releases.
- Force a class decision: add it under `overrides` in `classes.yaml`, for example
  `cue: drop`. `prepare` writes every discovered class and its decision to
  `runs/classes.lock.yaml` for review.
- One dataset dominating the merge? Give it a `cap:` in `datasets.yaml` (the
  snooker set is capped by default, since broadcast snooker is off-domain for a
  top-down pool camera).
- Moving balls: `prepare` synthesizes motion-blurred copies of a fraction of train
  positives (see `motion_blur:` in `train.yaml`). It also removes near-duplicate
  frames and prints a per-source composition table.
- External negative sources in `negatives.yaml` need the extra dependencies:
  `uv sync --extra negatives`.

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

The exported ONNX uses YOLO26's NMS-free end-to-end head: output `(1, 300, 6)` =
`[x1, y1, x2, y2, confidence, class_id]`. The driver loads it directly, with no NMS
at runtime. How the driver picks an ONNX Runtime backend is described in
[`python/src/gosai_py/drivers/README.md`](../python/src/gosai_py/drivers/README.md#ball-runtime-backends).

## Model metadata

`install` writes `<model>.onnx.json` next to the installed model. `export` builds it
from what `prepare` and `train` recorded, and `install` refuses a file whose sha256
does not match.

| Field            | Meaning                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `schema_version` | `1`                                                                                                                            |
| `model`          | Model name under `training/models/`                                                                                            |
| `sha256`         | Hex sha256 of the ONNX file                                                                                                    |
| `input`          | `{ "height", "width" }` of the fixed ONNX input, from `infer_imgsz`                                                            |
| `class_names`    | Class names by index                                                                                                           |
| `run`            | Training run folder name, or `null` for weights not trained here                                                               |
| `base_weights`   | Base checkpoint the run started from, or `null`                                                                                |
| `git_sha`        | Commit checked out when training started, or `null`                                                                            |
| `git_dirty`      | Whether that checkout had uncommitted changes, or `null`                                                                       |
| `datasets`       | Dataset name to Roboflow version used by `prepare`, or `null`                                                                  |
| `metrics`        | ONNX scores on the merged val split: `split`, `images`, `map50`, `map50_95`, `precision`, `recall`; `null` without a val split |
| `exported_at`    | UTC timestamp, ISO 8601                                                                                                        |
