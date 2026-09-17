# gosai-py

Python runtime for GOSAI: the driver bridge process and the Python SDK
(`gosai_py`) used by apps that need ML/CV/audio processing.

## Setup

```bash
uv sync
```

This installs the CPU build of ONNX Runtime from the default `cpu` dependency
group. On macOS arm64 that build includes CoreML. For an NVIDIA GPU on Linux or
Windows, swap it for the `gpu` extra (onnxruntime-gpu with CUDA 13 and cuDNN
wheels, which needs NVIDIA driver 580 or newer):

```bash
uv sync --extra gpu --no-group cpu
```

`uv run` (and so `bun run python:check` and `uv run gosai-bridge`) syncs the
default groups first, which reinstalls the CPU `onnxruntime` over
onnxruntime-gpu. On a GPU checkout, keep the `cpu` group out of every command:

```bash
export UV_NO_GROUP=cpu   # or: uv run --extra gpu --no-group cpu ...
```

If it already happened, repair the environment with
`uv sync --extra gpu --no-group cpu --reinstall-package onnxruntime-gpu`.

The packaged desktop app installs `gpu` by itself on Linux x64 when the NVIDIA
driver is 580 or newer.

Optional extras:

```bash
uv sync --extra speech      # speech_to_text (faster-whisper)
```

faster-whisper depends on the CPU `onnxruntime`, which overwrites
`onnxruntime-gpu` when both are installed. With `gpu` and `speech` together,
reinstall onnxruntime-gpu after syncing:

```bash
uv sync --extra gpu --extra speech --no-group cpu
uv sync --extra gpu --extra speech --no-group cpu --reinstall-package onnxruntime-gpu
```

## Accelerators

ONNX drivers use the first accelerated execution provider the installed ONNX
Runtime offers: CUDA, then CoreML, then DirectML. Models that need an
accelerator (ball) refuse to run on CPU unless you allow it, so a fallback is
visible rather than silent. Small models (SLR) run on CPU without asking.
Silero voice detection always runs on CPU. MediaPipe's Python Tasks only have a
GPU delegate on macOS, so pose and hand_pose run on CPU everywhere else.

| Variable                     | Effect                                                    |
| ---------------------------- | --------------------------------------------------------- |
| `GOSAI_ACCELERATOR=auto`     | Default. CUDA on NVIDIA, CoreML on macOS                  |
| `GOSAI_ACCELERATOR=cuda`     | NVIDIA CUDA; fails if unavailable                         |
| `GOSAI_ACCELERATOR=tensorrt` | NVIDIA TensorRT with CUDA behind it; first run is slow    |
| `GOSAI_ACCELERATOR=coreml`   | CoreML for ONNX, GPU delegate for MediaPipe on macOS      |
| `GOSAI_ACCELERATOR=dml`      | DirectML (needs an onnxruntime-directml build)            |
| `GOSAI_ACCELERATOR=cpu`      | CPU only                                                  |
| `GOSAI_ALLOW_CPU_FALLBACK=1` | Permit CPU when no accelerator starts                     |
| `GOSAI_CUDA_DEVICE_ID=0`     | Which NVIDIA GPU (0 = first CUDA device)                  |
| `GOSAI_TRT_CACHE_DIR`        | TensorRT engine cache (default `~/.cache/gosai/trt`)      |
| `GOSAI_MEDIAPIPE_GPU=0`      | Disable MediaPipe's macOS GPU delegate (`1` forces it on) |

Unknown values of `GOSAI_ACCELERATOR` and `GOSAI_CUDA_DEVICE_ID` are errors.

The dashboard Drivers panel shows the active hardware/provider per running
driver when the runtime exposes it.

On macOS, MediaPipe hand/pose drivers use the GPU delegate in auto/CoreML mode
and feed SRGBA frames internally because the Metal delegate does not accept
3-channel SRGB input.

## Models

Drivers declare their model files in `gosai_py.runtime.models`:

- Bundled models live in the package and are stored with Git LFS. Run
  `git lfs pull` if a driver reports an LFS pointer. `ball.onnx` is checked
  against `ball.onnx.json` when the training pipeline wrote one.
- Downloaded models (MediaPipe `.task` files, Silero VAD) are pinned to a
  version and sha256, and cached in `$GOSAI_HOME/models` (default
  `~/.gosai/models`).

## Camera Modes

`camera.list_formats` opens the device, prefers MJPG, requests each standard
resolution and keeps the sizes the camera actually decodes. Results are cached
for 10 seconds. A device a camera instance already holds answers from the cache
(or its current mode) with `in_use: true`, since a second handle would fail.

A mode change stops capture and releases the device before opening it with
the new settings, and restores the previous mode if the new one fails. When the
camera rounds a requested resolution, the driver logs a warning and keeps the
size it delivers.

## Driver schemas

Drivers declare their startup config, events and actions with msgspec types
(see `gosai_py/driver.py`). The bridge's `list-drivers` reply includes each
driver's JSON Schema under `schema`; `gosai_py/schemas.py` documents its shape.
To print every built-in driver's description:

```bash
uv run python -m gosai_py.schemas
```

## Run the bridge directly (for development)

```bash
uv run gosai-bridge
```

The bridge reads newline-delimited JSON requests from stdin and writes
responses/events to stdout. It is normally spawned by the GOSAI server.
