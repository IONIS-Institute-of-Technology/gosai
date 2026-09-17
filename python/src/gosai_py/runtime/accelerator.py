"""Accelerator selection for inference drivers.

``GOSAI_ACCELERATOR`` picks the backend: ``auto`` (default), ``cuda``,
``tensorrt``, ``coreml``, ``dml`` or ``cpu``.

- ONNX Runtime: ``auto`` uses the first accelerated execution provider the
  installed build offers, in the order CUDA, CoreML, DirectML. TensorRT is
  opt-in because its first run builds an engine, which takes minutes.
- MediaPipe: the Python Tasks API only has a GPU delegate on macOS. Every other
  case runs on its CPU delegate and says why in the runtime info.

Models that need an accelerator refuse to run on CPU unless
``GOSAI_ACCELERATOR=cpu`` or ``GOSAI_ALLOW_CPU_FALLBACK=1`` is set. Small models
pass ``allow_cpu=True`` and run wherever ONNX Runtime puts them.

Drivers publish the returned ``RuntimeInfo`` so the dashboard shows the active
backend.
"""

from __future__ import annotations

import importlib.metadata
import os
import platform
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

import onnxruntime as ort

type Mode = Literal["auto", "cuda", "tensorrt", "coreml", "dml", "cpu"]
MODES: tuple[Mode, ...] = ("auto", "cuda", "tensorrt", "coreml", "dml", "cpu")
type ProviderSpec = str | tuple[str, dict[str, Any]]
type LogFn = Callable[[str, str], None]

CPU_PROVIDER = "CPUExecutionProvider"

# Accelerated ONNX Runtime providers: mode -> (provider name, device label).
ONNX_PROVIDERS: dict[str, tuple[str, str]] = {
    "cuda": ("CUDAExecutionProvider", "cuda"),
    "tensorrt": ("TensorrtExecutionProvider", "tensorrt"),
    "coreml": ("CoreMLExecutionProvider", "coreml"),
    "dml": ("DmlExecutionProvider", "directml"),
}
AUTO_ORDER = ("cuda", "coreml", "dml")

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


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


def _default_trt_cache_dir() -> Path:
    return Path.home() / ".cache" / "gosai" / "trt"


@dataclass(frozen=True)
class AcceleratorConfig:
    mode: Mode = "auto"
    cuda_device_id: int = 0
    allow_cpu_fallback: bool = False
    trt_cache_dir: Path = field(default_factory=_default_trt_cache_dir)
    # None follows `mode`; True or False overrides it on macOS.
    mediapipe_gpu: bool | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> AcceleratorConfig:
        mode = env.get("GOSAI_ACCELERATOR", "").strip().lower() or "auto"
        if mode not in MODES:
            raise ValueError(f"GOSAI_ACCELERATOR={mode!r} is not one of {', '.join(MODES)}")
        cuda_raw = env.get("GOSAI_CUDA_DEVICE_ID", "").strip() or "0"
        if not cuda_raw.isdigit():
            raise ValueError(f"GOSAI_CUDA_DEVICE_ID={cuda_raw!r} is not a device index")
        trt_raw = env.get("GOSAI_TRT_CACHE_DIR", "").strip()
        return cls(
            mode=cast(Mode, mode),
            cuda_device_id=int(cuda_raw),
            allow_cpu_fallback=_flag(env, "GOSAI_ALLOW_CPU_FALLBACK") is True,
            trt_cache_dir=Path(trt_raw).expanduser() if trt_raw else _default_trt_cache_dir(),
            mediapipe_gpu=_flag(env, "GOSAI_MEDIAPIPE_GPU"),
        )


def _flag(env: Mapping[str, str], name: str) -> bool | None:
    value = env.get(name, "").strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return None


def provider_names(providers: Sequence[ProviderSpec]) -> list[str]:
    return [p[0] if isinstance(p, tuple) else p for p in providers]


def _provider_spec(mode: str, config: AcceleratorConfig) -> ProviderSpec:
    name = ONNX_PROVIDERS[mode][0]
    if mode == "cuda":
        return (name, {"device_id": config.cuda_device_id})
    if mode == "tensorrt":
        return (
            name,
            {
                "device_id": config.cuda_device_id,
                "trt_fp16_enable": True,
                "trt_engine_cache_enable": True,
                "trt_engine_cache_path": str(config.trt_cache_dir),
                "trt_timing_cache_enable": True,
            },
        )
    return name


def _check_cpu_allowed(
    config: AcceleratorConfig, allow_cpu: bool, reason: str, hint: str = ""
) -> None:
    if allow_cpu or config.allow_cpu_fallback or config.mode == "cpu":
        return
    raise RuntimeError(
        f"{reason}. Set GOSAI_ACCELERATOR=cpu or GOSAI_ALLOW_CPU_FALLBACK=1 to run on CPU.{hint}"
    )


def _ort_install_hint(available: Sequence[str], config: AcceleratorConfig) -> str:
    """Explain a missing CUDA provider caused by the CPU wheel overwriting the GPU one."""
    if config.mode not in ("auto", "cuda", "tensorrt") or ONNX_PROVIDERS["cuda"][0] in available:
        return ""
    installed = set()
    for dist in ("onnxruntime", "onnxruntime-gpu"):
        try:
            importlib.metadata.version(dist)
        except importlib.metadata.PackageNotFoundError:
            continue
        installed.add(dist)
    if len(installed) == 2:
        return (
            " Both onnxruntime and onnxruntime-gpu are installed and overwrite each other;"
            " reinstall onnxruntime-gpu (uv sync --extra gpu --no-group cpu"
            " --reinstall-package onnxruntime-gpu)."
        )
    return ""


def choose_onnx_providers(
    available: Sequence[str],
    config: AcceleratorConfig,
    *,
    allow_cpu: bool = False,
) -> list[ProviderSpec]:
    """Return the ONNX Runtime providers to request, in preference order."""
    if config.mode == "cpu":
        return [CPU_PROVIDER]
    if config.mode == "auto":
        mode = next((m for m in AUTO_ORDER if ONNX_PROVIDERS[m][0] in available), None)
        if mode is None:
            _check_cpu_allowed(
                config,
                allow_cpu,
                f"no accelerated ONNX Runtime provider in {list(available)}",
                _ort_install_hint(available, config),
            )
            return [CPU_PROVIDER]
    else:
        mode = config.mode
        if ONNX_PROVIDERS[mode][0] not in available:
            _check_cpu_allowed(
                config,
                allow_cpu,
                f"{ONNX_PROVIDERS[mode][0]} not in {list(available)}",
                _ort_install_hint(available, config),
            )
            return [CPU_PROVIDER]
    providers = [_provider_spec(mode, config)]
    # TensorRT hands the subgraphs it can't compile to CUDA.
    if mode == "tensorrt" and ONNX_PROVIDERS["cuda"][0] in available:
        providers.append(_provider_spec("cuda", config))
    return providers


def create_onnx_session(
    model_path: Path,
    *,
    log_fn: LogFn,
    allow_cpu: bool = False,
    cuda_device_id: int | None = None,
    config: AcceleratorConfig | None = None,
) -> tuple[Any, RuntimeInfo]:
    """Create an ONNX Runtime session, then check which provider it activated."""
    config = config or AcceleratorConfig.from_env()
    if cuda_device_id is not None:
        config = replace(config, cuda_device_id=cuda_device_id)

    available = ort.get_available_providers()
    providers = choose_onnx_providers(available, config, allow_cpu=allow_cpu)
    requested = provider_names(providers)
    if requested[0] in (ONNX_PROVIDERS["cuda"][0], ONNX_PROVIDERS["tensorrt"][0]):
        ort.preload_dlls()
    if requested[0] == ONNX_PROVIDERS["tensorrt"][0]:
        config.trt_cache_dir.mkdir(parents=True, exist_ok=True)

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=providers)

    # ONNX Runtime silently drops providers that fail to initialize.
    active = session.get_providers()[0]
    if active == CPU_PROVIDER and requested[0] != CPU_PROVIDER:
        _check_cpu_allowed(
            config, allow_cpu, f"{model_path.name}: ONNX Runtime could not start {requested[0]}"
        )

    device = next(
        (device for name, device in ONNX_PROVIDERS.values() if name == active),
        "cpu",
    )
    info = RuntimeInfo(
        backend="onnxruntime",
        provider=active,
        device=device,
        model=model_path.name,
        accelerated=active != CPU_PROVIDER,
        available_providers=list(available),
        requested_providers=requested,
    )
    if device in ("cuda", "tensorrt"):
        info["device_id"] = config.cuda_device_id
    if active == CPU_PROVIDER:
        info["reason"] = (
            "CPU explicitly requested"
            if config.mode == "cpu"
            else f"no accelerated ONNX Runtime provider started (requested {requested})"
        )
    elif active != requested[0]:
        info["reason"] = f"{requested[0]} did not start"
    log_fn(
        "info",
        f"ONNX session ready ({model_path.name}, active={active}, requested={requested}, "
        f"available={available})",
    )
    return session, info


def mediapipe_base_options(
    base_options_cls: Any,
    *,
    model_path: Path,
    allow_gpu: bool = True,
    config: AcceleratorConfig | None = None,
) -> tuple[Any, RuntimeInfo]:
    """Build MediaPipe ``BaseOptions`` with the delegate the config asks for.

    The GPU delegate is only used on macOS. Callers must feed it SRGBA images,
    because MediaPipe's Metal backend aborts on SRGB input. ``allow_gpu=False``
    forces the CPU delegate, for retrying after the GPU delegate rejected a
    model (the holistic landmarker's quantized blendshapes graph can't bind
    Metal buffers).
    """
    config = config or AcceleratorConfig.from_env()
    wants_gpu = (
        config.mediapipe_gpu
        if config.mediapipe_gpu is not None
        else config.mode in ("auto", "coreml")
    )
    info = RuntimeInfo(backend="mediapipe", model=model_path.name)

    if allow_gpu and wants_gpu and platform.system() == "Darwin":
        info.update(provider="GPUDelegate", device="coreml", accelerated=True)
        options = base_options_cls(
            model_asset_path=str(model_path), delegate=base_options_cls.Delegate.GPU
        )
        return options, info

    if not allow_gpu:
        reason = "MediaPipe GPU delegate rejected this model; running on CPU"
    elif config.mode == "cpu":
        reason = "CPU explicitly requested"
    elif config.mediapipe_gpu is False:
        reason = "GOSAI_MEDIAPIPE_GPU disables the GPU delegate"
    elif platform.system() != "Darwin":
        reason = "MediaPipe Python Tasks only have a GPU delegate on macOS"
    else:
        reason = f"MediaPipe has no {config.mode} delegate"
    info.update(provider="CPUDelegate", device="cpu", accelerated=False, reason=reason)
    options = base_options_cls(
        model_asset_path=str(model_path), delegate=base_options_cls.Delegate.CPU
    )
    return options, info
