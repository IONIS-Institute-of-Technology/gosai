# gosai-py

Python runtime for GOSAI: the driver bridge process and the Python SDK
(`gosai_py`) used by apps that need ML/CV/audio processing.

## Setup

```bash
uv sync
```

**Ball detection GPU (Linux / Windows):** installs `onnxruntime-gpu` automatically so
YOLO runs on the NVIDIA GPU via CUDA. On macOS, `onnxruntime` uses CoreML instead.

Optional overrides:

| Variable                 | Effect                                   |
| ------------------------ | ---------------------------------------- |
| `GOSAI_ORT_DEVICE=cuda`  | Force NVIDIA CUDA; fail if unavailable   |
| `GOSAI_ORT_DEVICE=cpu`   | Force CPU only                           |
| `GOSAI_CUDA_DEVICE_ID=0` | Which NVIDIA GPU (0 = first CUDA device) |

After start, check logs for `active=CUDAExecutionProvider` (or `CoreMLExecutionProvider` on Mac).

For optional hardware-specific drivers, add extras as needed:

```bash
uv sync --extra realsense   # Intel RealSense depth camera
uv sync --extra speech       # Whisper-based speech recognition (requires torch)
```

## Run the bridge directly (for development)

```bash
uv run gosai-bridge
```

The bridge reads newline-delimited JSON requests from stdin and writes
responses/events to stdout. It is normally spawned by the GOSAI server.
