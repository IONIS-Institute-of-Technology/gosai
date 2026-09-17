from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np
import onnxruntime as ort
import pytest

from gosai_py.runtime.accelerator import (
    AcceleratorConfig,
    choose_onnx_providers,
    create_onnx_session,
    mediapipe_base_options,
    provider_names,
)

CUDA = "CUDAExecutionProvider"
TRT = "TensorrtExecutionProvider"
COREML = "CoreMLExecutionProvider"
CPU = "CPUExecutionProvider"


class FakeBaseOptions:
    class Delegate:
        CPU = "cpu"
        GPU = "gpu"

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


def _logs() -> tuple[list[tuple[str, str]], Callable[[str, str], None]]:
    lines: list[tuple[str, str]] = []
    return lines, lambda level, message: lines.append((level, message))


def test_from_env_defaults() -> None:
    config = AcceleratorConfig.from_env({})

    assert config.mode == "auto"
    assert config.cuda_device_id == 0
    assert config.allow_cpu_fallback is False
    assert config.mediapipe_gpu is None


def test_from_env_reads_every_variable(tmp_path: Path) -> None:
    config = AcceleratorConfig.from_env(
        {
            "GOSAI_ACCELERATOR": " CUDA ",
            "GOSAI_CUDA_DEVICE_ID": "2",
            "GOSAI_ALLOW_CPU_FALLBACK": "yes",
            "GOSAI_TRT_CACHE_DIR": str(tmp_path),
            "GOSAI_MEDIAPIPE_GPU": "0",
        }
    )

    assert config == AcceleratorConfig(
        mode="cuda",
        cuda_device_id=2,
        allow_cpu_fallback=True,
        trt_cache_dir=tmp_path,
        mediapipe_gpu=False,
    )


def test_from_env_rejects_unknown_values() -> None:
    with pytest.raises(ValueError, match="GOSAI_ACCELERATOR"):
        AcceleratorConfig.from_env({"GOSAI_ACCELERATOR": "gpu"})
    with pytest.raises(ValueError, match="GOSAI_CUDA_DEVICE_ID"):
        AcceleratorConfig.from_env({"GOSAI_CUDA_DEVICE_ID": "first"})


def test_auto_prefers_cuda_and_skips_tensorrt() -> None:
    providers = choose_onnx_providers([TRT, CUDA, CPU], AcceleratorConfig(cuda_device_id=1))

    assert providers == [(CUDA, {"device_id": 1})]


def test_auto_uses_coreml_on_macos_builds() -> None:
    assert choose_onnx_providers([COREML, CPU], AcceleratorConfig()) == [COREML]


def test_tensorrt_is_opt_in_with_cuda_behind_it(tmp_path: Path) -> None:
    config = AcceleratorConfig(mode="tensorrt", trt_cache_dir=tmp_path)

    providers = choose_onnx_providers([TRT, CUDA, CPU], config)

    assert provider_names(providers) == [TRT, CUDA]
    trt_options = providers[0][1]
    assert isinstance(trt_options, dict)
    assert trt_options["trt_engine_cache_path"] == str(tmp_path)


def test_cpu_needs_explicit_request_for_heavy_models() -> None:
    with pytest.raises(RuntimeError, match="GOSAI_ACCELERATOR=cpu"):
        choose_onnx_providers([CPU], AcceleratorConfig())
    with pytest.raises(RuntimeError, match=CUDA):
        choose_onnx_providers([CPU], AcceleratorConfig(mode="cuda"))


def test_cpu_allowed_by_mode_fallback_or_small_model() -> None:
    assert choose_onnx_providers([CUDA, CPU], AcceleratorConfig(mode="cpu")) == [CPU]
    assert choose_onnx_providers([CPU], AcceleratorConfig(allow_cpu_fallback=True)) == [CPU]
    assert choose_onnx_providers([CPU], AcceleratorConfig(mode="cuda"), allow_cpu=True) == [CPU]


def test_small_model_still_prefers_an_accelerator() -> None:
    providers = choose_onnx_providers([CUDA, CPU], AcceleratorConfig(), allow_cpu=True)

    assert provider_names(providers) == [CUDA]


def test_create_session_on_cpu_reports_runtime(identity_model: Path) -> None:
    lines, log = _logs()

    session, info = create_onnx_session(
        identity_model, log_fn=log, config=AcceleratorConfig(mode="cpu")
    )

    x = np.ones((1, 3), dtype=np.float32)
    assert np.array_equal(session.run(None, {"x": x})[0], x)
    assert info["provider"] == CPU
    assert info["device"] == "cpu"
    assert info["accelerated"] is False
    assert info["model"] == "identity.onnx"
    assert info["reason"] == "CPU explicitly requested"
    assert lines and lines[0][0] == "info"


def test_create_session_checks_the_active_provider(
    identity_model: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Pretend CUDA is installed; the real session can only start on CPU.
    model = identity_model
    monkeypatch.setattr(ort, "get_available_providers", lambda: [CUDA, CPU])
    monkeypatch.setattr(ort, "preload_dlls", lambda **_: None)
    real_session = ort.InferenceSession

    def cpu_session(path: str, sess_options: object, providers: object) -> object:
        return real_session(path, sess_options=sess_options, providers=[CPU])

    monkeypatch.setattr(ort, "InferenceSession", cpu_session)
    _, log = _logs()

    with pytest.raises(RuntimeError, match="could not start CUDAExecutionProvider"):
        create_onnx_session(model, log_fn=log, config=AcceleratorConfig())

    _, info = create_onnx_session(model, log_fn=log, allow_cpu=True, config=AcceleratorConfig())
    assert info["provider"] == CPU
    assert info["requested_providers"] == [CUDA]
    assert "no accelerated" in info["reason"]


def test_mediapipe_auto_uses_macos_gpu_delegate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    options, info = mediapipe_base_options(
        FakeBaseOptions, model_path=Path("hand.task"), config=AcceleratorConfig()
    )

    assert options.kwargs["delegate"] == FakeBaseOptions.Delegate.GPU
    assert info["provider"] == "GPUDelegate"
    assert info["device"] == "coreml"
    assert info["accelerated"] is True


@pytest.mark.parametrize("mode", ["cuda", "tensorrt", "auto"])
def test_mediapipe_runs_on_cpu_off_macos(mode: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("platform.system", lambda: "Linux")

    options, info = mediapipe_base_options(
        FakeBaseOptions,
        model_path=Path("pose.task"),
        config=AcceleratorConfig.from_env({"GOSAI_ACCELERATOR": mode}),
    )

    assert options.kwargs["delegate"] == FakeBaseOptions.Delegate.CPU
    assert info["accelerated"] is False
    assert "only have a GPU delegate on macOS" in info["reason"]


def test_mediapipe_allow_gpu_false_forces_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    options, info = mediapipe_base_options(
        FakeBaseOptions,
        model_path=Path("holistic_landmarker.task"),
        allow_gpu=False,
        config=AcceleratorConfig(mode="coreml"),
    )

    assert options.kwargs["delegate"] == FakeBaseOptions.Delegate.CPU
    assert info["provider"] == "CPUDelegate"
    assert info["accelerated"] is False
    assert info["reason"] == "MediaPipe GPU delegate rejected this model; running on CPU"


def test_mediapipe_gpu_flag_overrides_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    _, disabled = mediapipe_base_options(
        FakeBaseOptions, model_path=Path("hand.task"), config=AcceleratorConfig(mediapipe_gpu=False)
    )
    _, forced = mediapipe_base_options(
        FakeBaseOptions,
        model_path=Path("hand.task"),
        config=AcceleratorConfig(mode="cpu", mediapipe_gpu=True),
    )

    assert disabled["accelerated"] is False
    assert forced["accelerated"] is True
