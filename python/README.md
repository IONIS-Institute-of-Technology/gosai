# gosai-py

Python runtime for GOSAI: the driver bridge process and the Python SDK
(`gosai_py`) used by apps that need ML/CV/audio processing.

## Setup

```bash
uv sync
```

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
