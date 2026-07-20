from __future__ import annotations

from pathlib import Path

import pytest

from gosai_py.runtime.accelerator import (
    choose_onnx_providers,
    mediapipe_base_options,
    provider_names,
)


class FakeBaseOptions:
    class Delegate:
        CPU = "cpu"
        GPU = "gpu"

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


def test_choose_cuda_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_ACCELERATOR", "cuda")

    providers, info = choose_onnx_providers(
        ["CUDAExecutionProvider", "CPUExecutionProvider"],
        cuda_id=1,
    )

    assert providers == [("CUDAExecutionProvider", {"device_id": 1})]
    assert info["device"] == "cuda"
    assert info["accelerated"] is True


def test_tensorrt_mode_prefers_trt_with_cuda_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_ACCELERATOR", "tensorrt")

    providers, info = choose_onnx_providers(
        ["TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
        cuda_id=0,
    )

    assert provider_names(providers) == ["TensorrtExecutionProvider", "CUDAExecutionProvider"]
    assert info["device"] == "tensorrt"
    assert info["accelerated"] is True


def test_tensorrt_unavailable_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_ACCELERATOR", "tensorrt")

    with pytest.raises(RuntimeError, match="TensorrtExecutionProvider unavailable"):
        choose_onnx_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])


def test_auto_linux_prefers_tensorrt(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    monkeypatch.delenv("GOSAI_ORT_DEVICE", raising=False)
    monkeypatch.setattr("platform.system", lambda: "Linux")

    providers, info = choose_onnx_providers(
        ["TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
    )

    assert provider_names(providers)[0] == "TensorrtExecutionProvider"
    assert info["device"] == "tensorrt"


def test_cpu_requires_explicit_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    monkeypatch.delenv("GOSAI_ALLOW_CPU_FALLBACK", raising=False)
    monkeypatch.setattr("platform.system", lambda: "Linux")

    with pytest.raises(RuntimeError, match="GOSAI_ACCELERATOR=cpu"):
        choose_onnx_providers(["CPUExecutionProvider"])


def test_explicit_cpu_reports_non_accelerated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_ACCELERATOR", "cpu")

    providers, info = choose_onnx_providers(["CPUExecutionProvider"])

    assert providers == ["CPUExecutionProvider"]
    assert info["device"] == "cpu"
    assert info["accelerated"] is False
    assert info["reason"] == "CPU explicitly requested"


def test_mediapipe_auto_uses_macos_gpu_delegate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    monkeypatch.delenv("GOSAI_ORT_DEVICE", raising=False)
    monkeypatch.delenv("GOSAI_MEDIAPIPE_GPU", raising=False)
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    options, info = mediapipe_base_options(
        FakeBaseOptions,
        model_path=Path("hand.task"),
        model_name="hand.task",
    )

    assert options.kwargs["delegate"] == FakeBaseOptions.Delegate.GPU
    assert info["provider"] == "GPUDelegate"
    assert info["device"] == "coreml"
    assert info["accelerated"] is True


def test_mediapipe_gpu_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_MEDIAPIPE_GPU", "0")
    monkeypatch.delenv("GOSAI_ACCELERATOR", raising=False)
    monkeypatch.delenv("GOSAI_ORT_DEVICE", raising=False)
    monkeypatch.setattr("platform.system", lambda: "Darwin")

    options, info = mediapipe_base_options(
        FakeBaseOptions,
        model_path=Path("hand.task"),
        model_name="hand.task",
    )

    assert options.kwargs["delegate"] == FakeBaseOptions.Delegate.CPU
    assert info["provider"] == "CPUDelegate"
    assert info["accelerated"] is False
