from __future__ import annotations

import hashlib
import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from gosai_py.drivers import ball, hand_pose, pose, slr
from gosai_py.runtime.models import (
    LFS_POINTER_PREFIX,
    Model,
    ModelUnavailableError,
    resolve_model,
)

CONTENT = b"model bytes"
CONTENT_SHA = hashlib.sha256(CONTENT).hexdigest()


def _log(level: str, message: str) -> None:
    pass


def _write(path: Path, data: bytes = CONTENT) -> Path:
    path.write_bytes(data)
    return path


def test_model_needs_exactly_one_source(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="exactly one"):
        Model(filename="a.onnx")
    with pytest.raises(ValueError, match="exactly one"):
        Model(filename="a.onnx", url="https://example.com/a.onnx", path=tmp_path / "a.onnx")
    with pytest.raises(ValueError, match="sha256"):
        Model(filename="a.onnx", url="https://example.com/a.onnx")


def test_bundled_model_resolves_and_checks_sha256(tmp_path: Path) -> None:
    path = _write(tmp_path / "a.onnx")

    assert resolve_model(Model.bundled(path, sha256=CONTENT_SHA), _log) == path
    with pytest.raises(ModelUnavailableError, match="expected 00"):
        resolve_model(Model.bundled(path, sha256="00" * 32), _log)


def test_missing_bundled_model(tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailableError, match="not found"):
        resolve_model(Model.bundled(tmp_path / "a.onnx"), _log)


def test_lfs_pointer_is_rejected(tmp_path: Path) -> None:
    pointer = LFS_POINTER_PREFIX + b"\noid sha256:abc\nsize 3049965\n"
    path = _write(tmp_path / "a.onnx", pointer)

    with pytest.raises(ModelUnavailableError, match="git lfs pull"):
        resolve_model(Model.bundled(path), _log)


def test_bundled_model_uses_sidecar_sha256(tmp_path: Path) -> None:
    path = _write(tmp_path / "ball.onnx")
    sidecar = tmp_path / "ball.onnx.json"

    sidecar.write_text(json.dumps({"sha256": CONTENT_SHA, "run": "r1"}))
    assert resolve_model(Model.bundled(path), _log) == path

    sidecar.write_text(json.dumps({"sha256": "00" * 32}))
    with pytest.raises(ModelUnavailableError, match="sha256"):
        resolve_model(Model.bundled(path), _log)


def test_download_caches_and_replaces_bad_copies(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOSAI_HOME", str(tmp_path / "home"))
    source = _write(tmp_path / "remote.task")
    model = Model.download("m.task", url=source.as_uri(), sha256=CONTENT_SHA)

    cached = resolve_model(model, _log)
    assert cached == tmp_path / "home" / "models" / "m.task"
    assert cached.read_bytes() == CONTENT

    cached.write_bytes(b"truncated")
    assert resolve_model(model, _log).read_bytes() == CONTENT

    source.unlink()
    assert resolve_model(model, _log) == cached


def test_download_with_wrong_sha256_leaves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOSAI_HOME", str(tmp_path / "home"))
    source = _write(tmp_path / "remote.task")
    model = Model.download("m.task", url=source.as_uri(), sha256="00" * 32)

    with pytest.raises(ModelUnavailableError, match="expected 00"):
        resolve_model(model, _log)
    assert list((tmp_path / "home" / "models").iterdir()) == []


def test_concurrent_downloads_of_one_model_both_succeed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOSAI_HOME", str(tmp_path / "home"))
    requests: list[str] = []

    class SlowResponse(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            time.sleep(0.05)
            return super().read(4)

    def urlopen(url: str, timeout: float) -> SlowResponse:
        requests.append(url)
        return SlowResponse(CONTENT)

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    model = Model.download("m.task", url="https://example.com/m.task", sha256=CONTENT_SHA)
    results: list[Path] = []
    errors: list[BaseException] = []
    start = threading.Barrier(2)

    def resolve() -> None:
        start.wait()
        try:
            results.append(resolve_model(model, _log))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=resolve) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    assert len(results) == 2 and results[0] == results[1]
    assert results[0].read_bytes() == CONTENT
    assert requests == ["https://example.com/m.task"]
    assert [p.name for p in results[0].parent.iterdir()] == ["m.task"]


def test_download_failure_names_the_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GOSAI_HOME", str(tmp_path / "home"))
    url = (tmp_path / "missing.task").as_uri()

    with pytest.raises(ModelUnavailableError, match="could not download"):
        resolve_model(Model.download("m.task", url=url, sha256=CONTENT_SHA), _log)


def test_driver_models_are_pinned() -> None:
    downloads = [pose.MODEL, hand_pose.MODEL]
    for model in downloads:
        assert model.url is not None
        assert "/latest/" not in model.url
        assert model.sha256 is not None
    assert all(model.sha256 for model in slr.MODELS.values())
    assert ball.MODEL.path is not None


def test_ball_input_size_comes_from_the_session() -> None:
    def session(shape: list[object]) -> SimpleNamespace:
        inp = SimpleNamespace(name="images", shape=shape)
        return SimpleNamespace(get_inputs=lambda: [inp])

    assert ball._input_spec(session([1, 3, 640, 960])) == ("images", (640, 960))
    with pytest.raises(RuntimeError, match="fixed NCHW"):
        ball._input_spec(session([1, 3, "height", "width"]))


def test_ball_reads_the_accelerator_env_in_pre_run(
    identity_model: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GOSAI_CUDA_DEVICE_ID", "first")
    monkeypatch.setattr(ball, "resolve_model", lambda model, log_fn: identity_model)
    context = SimpleNamespace(
        log=_log, subscribe=lambda *args: None, unsubscribe=lambda *args: None
    )

    driver = ball.BallDriver(context)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="GOSAI_CUDA_DEVICE_ID"):
        driver.pre_run()
