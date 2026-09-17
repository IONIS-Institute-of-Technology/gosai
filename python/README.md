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

The packaged desktop app does this by itself on Linux x64 when the NVIDIA
driver is loaded.

Optional extras:

```bash
uv sync --extra speech      # speech_to_text (faster-whisper)
uv sync --extra realsense   # Intel RealSense depth camera, not on macOS
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

The camera driver probes exact modes by asking OpenCV to open and decode frames
for each candidate resolution/FPS through native, MJPG, and H264-style capture
paths where supported. The dashboard only lists modes that pass this check.

When a selected mode is applied, the driver verifies the decoded frame size and
reported FPS. If the camera falls back to a lower resolution, startup/action
fails visibly instead of continuing with the wrong stream.

## Run the bridge directly (for development)

```bash
uv run gosai-bridge
```

The bridge reads newline-delimited JSON requests from stdin and writes
responses/events to stdout. It is normally spawned by the GOSAI server.
