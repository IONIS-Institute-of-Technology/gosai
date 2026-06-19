# gosai-py

Python runtime for GOSAI: the driver bridge process and the Python SDK
(`gosai_py`) used by apps that need ML/CV/audio processing.

## Setup

```bash
uv sync
```

Inference drivers are accelerator-first. Linux/Windows ONNX drivers prefer CUDA
when `onnxruntime-gpu` exposes `CUDAExecutionProvider`; macOS prefers CoreML/Metal
providers when available. CPU mode is explicit so fallback is visible rather than
silent.

Optional overrides:

| Variable                     | Effect                                          |
| ---------------------------- | ----------------------------------------------- |
| `GOSAI_ACCELERATOR=auto`     | Prefer CUDA on NVIDIA, CoreML/Metal on macOS    |
| `GOSAI_ACCELERATOR=cuda`     | Force NVIDIA CUDA; fail if unavailable          |
| `GOSAI_ACCELERATOR=coreml`   | Force CoreML/Metal-capable providers            |
| `GOSAI_ACCELERATOR=cpu`      | Force CPU only                                  |
| `GOSAI_ALLOW_CPU_FALLBACK=1` | Permit CPU when the requested accelerator fails |
| `GOSAI_CUDA_DEVICE_ID=0`     | Which NVIDIA GPU (0 = first CUDA device)        |
| `GOSAI_MEDIAPIPE_GPU=0`      | Disable MediaPipe's macOS GPU delegate          |

The dashboard Drivers panel shows the active hardware/provider per running
driver when the runtime exposes it.

On macOS, MediaPipe hand/pose drivers use the GPU delegate in auto/CoreML mode
and feed SRGBA frames internally because the Metal delegate does not accept
3-channel SRGB input.

## Camera Modes

The camera driver probes exact modes by asking OpenCV to open and decode frames
for each candidate resolution/FPS through native, MJPG, and H264-style capture
paths where supported. The dashboard only lists modes that pass this check.

When a selected mode is applied, the driver verifies the decoded frame size and
reported FPS. If the camera falls back to a lower resolution, startup/action
fails visibly instead of continuing with the wrong stream.

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
