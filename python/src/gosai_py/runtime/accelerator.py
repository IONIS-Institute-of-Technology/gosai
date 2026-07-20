"""Accelerator policy helpers shared by inference drivers.

The policy is accelerator-first, not CUDA-only. A single ONNX model is run under
the fastest available ONNX Runtime execution provider, so the heavy inference
code (pre/post-processing) is shared across every backend:

- Linux/Windows auto mode prefers NVIDIA **TensorRT** (when the TensorRT EP is
  available), then plain CUDA, for ONNX Runtime.
- macOS auto mode prefers **CoreML** (Apple Neural Engine / GPU) when available.
- CPU is allowed only when explicitly requested or when fallback is explicitly
  enabled with ``GOSAI_ALLOW_CPU_FALLBACK=1``.

``GOSAI_ACCELERATOR`` selects a backend explicitly: ``auto`` | ``tensorrt`` |
``cuda`` | ``coreml`` | ``dml`` | ``cpu``. TensorRT JIT-compiles the model on the
first run and caches the engine under ``GOSAI_TRT_CACHE_DIR`` (default
``~/.cache/gosai/trt``), so subsequent startups are fast.

Drivers expose the returned ``RuntimeInfo`` in the bridge so the GUI can show
which backend is actually active.
"""

from __future__ import annotations

import os
import platform
from pathlib import Path
from typing import Any, TypedDict

type ProviderSpec = str | tuple[str, dict[str, Any]]


class RuntimeInfo(TypedDict, total=False):
    backend: str
    provider: str
    device: str
    device_id: int
    model: str
    accelerated: bool
    available_providers: list[str]
    requested_providers: list[str]
    reason: str


def runtime_info(
    *,
    backend: str,
    provider: str | None = None,
    device: str | None = None,
    device_id: int | None = None,
    model: str | None = None,
    accelerated: bool,
    available_providers: list[str] | None = None,
    requested_providers: list[str] | None = None,
    reason: str | None = None,
) -> RuntimeInfo:
    """Build a JSON-friendly runtime metadata payload."""
    info: RuntimeInfo = {
        "backend": backend,
        "accelerated": accelerated,
    }
    if provider:
        info["provider"] = provider
    if device:
        info["device"] = device
    if device_id is not None:
        info["device_id"] = device_id
    if model:
        info["model"] = model
    if available_providers is not None:
        info["available_providers"] = list(available_providers)
    if requested_providers is not None:
        info["requested_providers"] = list(requested_providers)
    if reason:
        info["reason"] = reason
    return info


def accelerator_mode() -> str:
    """Return ``auto`` | ``tensorrt`` | ``cuda`` | ``coreml`` | ``cpu`` | ``dml``.

    ``GOSAI_ACCELERATOR`` is the new cross-runtime knob. ``GOSAI_ORT_DEVICE`` is
    still honored so existing installs keep their configured behavior.
    """
    raw = os.environ.get("GOSAI_ACCELERATOR") or os.environ.get("GOSAI_ORT_DEVICE") or "auto"
    mode = raw.strip().lower()
    aliases = {
        "metal": "coreml",
        "mps": "coreml",
        "directml": "dml",
        "trt": "tensorrt",
        "trt-cuda": "tensorrt",
    }
    mode = aliases.get(mode, mode)
    if mode in {"auto", "tensorrt", "cuda", "coreml", "cpu", "dml"}:
        return mode
    return "auto"


def _trt_cache_dir() -> str:
    """Directory where the TensorRT EP caches compiled engines/timing data."""
    raw = os.environ.get("GOSAI_TRT_CACHE_DIR")
    base = Path(raw) if raw else Path.home() / ".cache" / "gosai" / "trt"
    base.mkdir(parents=True, exist_ok=True)
    return str(base)


def allow_cpu_fallback() -> bool:
    return os.environ.get("GOSAI_ALLOW_CPU_FALLBACK", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def cuda_device_id() -> int:
    raw = os.environ.get("GOSAI_CUDA_DEVICE_ID", "0")
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def provider_names(providers: list[ProviderSpec]) -> list[str]:
    return [p[0] if isinstance(p, tuple) else p for p in providers]


def choose_onnx_providers(
    available: list[str],
    *,
    mode: str | None = None,
    cuda_id: int | None = None,
    require_accelerated: bool = True,
) -> tuple[list[ProviderSpec], RuntimeInfo]:
    """Choose ONNX Runtime providers and return matching runtime metadata."""
    selected_mode = mode or accelerator_mode()
    selected_cuda_id = cuda_device_id() if cuda_id is None else max(0, int(cuda_id))
    cpu_allowed = selected_mode == "cpu" or allow_cpu_fallback() or not require_accelerated

    trt_provider = "TensorrtExecutionProvider"
    cuda_provider = "CUDAExecutionProvider"
    coreml_provider = "CoreMLExecutionProvider"
    dml_provider = "DirectMLExecutionProvider"
    cpu_provider = "CPUExecutionProvider"

    def cuda_spec() -> ProviderSpec:
        return (cuda_provider, {"device_id": selected_cuda_id})

    def trt_spec() -> ProviderSpec:
        # FP16 + engine/timing caches: first run compiles, later runs are fast.
        return (
            trt_provider,
            {
                "device_id": selected_cuda_id,
                "trt_fp16_enable": True,
                "trt_engine_cache_enable": True,
                "trt_engine_cache_path": _trt_cache_dir(),
                "trt_timing_cache_enable": True,
            },
        )

    def accelerated_info(
        provider: str, device: str, providers: list[ProviderSpec],
    ) -> tuple[list[ProviderSpec], RuntimeInfo]:
        return providers, runtime_info(
            backend="onnxruntime",
            provider=provider,
            device=device,
            device_id=selected_cuda_id if device in ("cuda", "tensorrt") else None,
            accelerated=True,
            available_providers=available,
            requested_providers=provider_names(providers),
        )

    def cpu_info(reason: str) -> tuple[list[ProviderSpec], RuntimeInfo]:
        if cpu_provider not in available:
            raise RuntimeError(f"CPUExecutionProvider unavailable; available providers: {available}")
        if selected_mode != "cpu" and require_accelerated and not allow_cpu_fallback():
            raise RuntimeError(
                f"{reason}. Set GOSAI_ACCELERATOR=cpu or GOSAI_ALLOW_CPU_FALLBACK=1 "
                "to run this driver on CPU."
            )
        return [cpu_provider], runtime_info(
            backend="onnxruntime",
            provider=cpu_provider,
            device="cpu",
            accelerated=False,
            available_providers=available,
            requested_providers=[cpu_provider],
            reason=reason,
        )

    if selected_mode == "cpu":
        return cpu_info("CPU explicitly requested")

    if selected_mode == "tensorrt":
        if trt_provider not in available:
            raise RuntimeError(
                f"TensorrtExecutionProvider unavailable; available providers: {available}. "
                "Install onnxruntime-gpu built with TensorRT and the TensorRT libraries."
            )
        # TensorRT EP needs CUDA EP as a fallback for any unsupported subgraph.
        providers: list[ProviderSpec] = [trt_spec()]
        if cuda_provider in available:
            providers.append(cuda_spec())
        return accelerated_info(trt_provider, "tensorrt", providers)

    if selected_mode == "cuda":
        if cuda_provider not in available:
            raise RuntimeError(f"CUDAExecutionProvider unavailable; available providers: {available}")
        return accelerated_info(cuda_provider, "cuda", [cuda_spec()])

    if selected_mode == "coreml":
        if coreml_provider not in available:
            return cpu_info(f"CoreMLExecutionProvider unavailable; available providers: {available}")
        return accelerated_info(coreml_provider, "coreml", [coreml_provider])

    if selected_mode == "dml":
        if dml_provider not in available:
            return cpu_info(f"DirectMLExecutionProvider unavailable; available providers: {available}")
        return accelerated_info(dml_provider, "directml", [dml_provider])

    system = platform.system()
    if system == "Darwin":
        if coreml_provider in available:
            return accelerated_info(coreml_provider, "coreml", [coreml_provider])
        return cpu_info(f"CoreMLExecutionProvider unavailable; available providers: {available}")

    if system in {"Linux", "Windows"}:
        # Prefer TensorRT, then CUDA. The list is an ordered preference; ONNX
        # Runtime activates the first provider that initializes successfully.
        providers = []
        if trt_provider in available:
            providers.append(trt_spec())
        if cuda_provider in available:
            providers.append(cuda_spec())
        if providers:
            primary = provider_names(providers)[0]
            return accelerated_info(
                primary, "tensorrt" if primary == trt_provider else "cuda", providers,
            )
        return cpu_info(f"CUDAExecutionProvider unavailable; available providers: {available}")

    if cpu_allowed:
        return cpu_info(f"no accelerator policy for platform {system!r}")
    raise RuntimeError(f"no supported accelerator available; available providers: {available}")


def create_onnx_session(
    onnx_path: Path,
    *,
    model_name: str,
    log_fn: Any,
    cuda_id: int | None = None,
    mode: str | None = None,
    require_accelerated: bool = True,
) -> tuple[Any, RuntimeInfo]:
    """Create an ONNX Runtime session and verify the requested provider is active."""
    import onnxruntime as ort  # type: ignore[import-not-found]

    available = ort.get_available_providers()
    providers, info = choose_onnx_providers(
        available,
        mode=mode,
        cuda_id=cuda_id,
        require_accelerated=require_accelerated,
    )
    requested = provider_names(providers)
    if "CUDAExecutionProvider" in requested and hasattr(ort, "preload_dlls"):
        try:
            ort.preload_dlls(cuda=True, cudnn=True, msvc=False, directory=None)
        except TypeError:
            try:
                ort.preload_dlls()
            except Exception as exc:
                log_fn("warn", f"ONNX CUDA preload failed: {exc!r}")
        except Exception as exc:
            log_fn("warn", f"ONNX CUDA preload failed: {exc!r}")

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(onnx_path), sess_options=opts, providers=providers)

    # ONNX Runtime activates the first provider (in our preference order) that
    # initializes, and always appends CPU as the last resort. The active backend
    # is therefore active[0]; we only require that it is actually accelerated
    # (unless CPU was explicitly requested/allowed).
    active = session.get_providers()
    active_provider = active[0] if active else "CPUExecutionProvider"
    accelerated = active_provider != "CPUExecutionProvider"
    selected_mode = mode or accelerator_mode()
    if (
        require_accelerated
        and not accelerated
        and selected_mode != "cpu"
        and not allow_cpu_fallback()
    ):
        raise RuntimeError(
            f"{model_name}: requested {requested} but ONNX Runtime fell back to CPU "
            f"({active}). Set GOSAI_ACCELERATOR=cpu or GOSAI_ALLOW_CPU_FALLBACK=1 to allow CPU."
        )

    device_by_provider = {
        "TensorrtExecutionProvider": "tensorrt",
        "CUDAExecutionProvider": "cuda",
        "CoreMLExecutionProvider": "coreml",
        "DirectMLExecutionProvider": "directml",
        "CPUExecutionProvider": "cpu",
    }
    info["provider"] = active_provider
    info["device"] = device_by_provider.get(active_provider, info.get("device", "unknown"))
    info["accelerated"] = accelerated
    info["model"] = model_name
    info["requested_providers"] = requested
    log_fn(
        "info",
        f"ONNX session ready ({model_name}, active={active_provider}, "
        f"available={available}, requested={requested})",
    )
    return session, info


def explicit_cpu_requested() -> bool:
    return accelerator_mode() == "cpu"


def mediapipe_base_options(
    base_options_cls: Any,
    *,
    model_path: Path,
    model_name: str,
) -> tuple[Any, RuntimeInfo]:
    """Create MediaPipe BaseOptions and runtime metadata.

    MediaPipe Python Tasks do not expose a CUDA provider. On macOS, auto/CoreML
    mode uses the GPU delegate. Callers must feed SRGBA images to that delegate;
    MediaPipe's Metal backend aborts on SRGB input.
    """
    mode = accelerator_mode()
    delegate_enum = getattr(base_options_cls, "Delegate", None)
    gpu_delegate = getattr(delegate_enum, "GPU", None) if delegate_enum is not None else None
    cpu_delegate = getattr(delegate_enum, "CPU", None) if delegate_enum is not None else None

    kwargs: dict[str, Any] = {"model_asset_path": str(model_path)}
    system = platform.system()
    mediapipe_gpu_disabled = os.environ.get("GOSAI_MEDIAPIPE_GPU", "").strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }
    mediapipe_gpu_requested = os.environ.get("GOSAI_MEDIAPIPE_GPU", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    if mode == "cuda":
        raise RuntimeError(
            "MediaPipe Python Tasks do not provide CUDA inference. Use an ONNX/TensorRT "
            "hand/pose model for CUDA, or set GOSAI_ACCELERATOR=cpu for this legacy path."
        )

    wants_macos_gpu = (
        system == "Darwin"
        and gpu_delegate is not None
        and not mediapipe_gpu_disabled
        and (mediapipe_gpu_requested or mode in {"auto", "coreml"})
    )
    if wants_macos_gpu:
        kwargs["delegate"] = gpu_delegate
        return base_options_cls(**kwargs), runtime_info(
            backend="mediapipe",
            provider="GPUDelegate",
            device="coreml",
            model=model_name,
            accelerated=True,
        )

    if mode == "coreml":
        raise RuntimeError("MediaPipe GPU delegate unavailable for CoreML/Metal acceleration")
    else:
        reason = (
            "CPU explicitly requested"
            if mode == "cpu"
            else "MediaPipe Python Tasks path is running on CPU; ONNX/CoreML remains active for supported models"
        )

    if cpu_delegate is not None:
        kwargs["delegate"] = cpu_delegate

    return base_options_cls(**kwargs), runtime_info(
        backend="mediapipe",
        provider="CPUDelegate" if cpu_delegate is not None else "CPU",
        device="cpu",
        model=model_name,
        accelerated=False,
        reason=reason,
    )
