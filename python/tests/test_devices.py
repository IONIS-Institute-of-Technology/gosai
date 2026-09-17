from __future__ import annotations

from pathlib import Path

import pytest

from conftest import BridgeFactory
from fakes import FakeSoundDevice
from gosai_py import devices
from gosai_py.devices import CameraDevice


def test_linux_cameras_skip_metadata_nodes(tmp_path: Path) -> None:
    for node, index, name in [(0, "0", "HD Camera"), (1, "1", "HD Camera"), (10, "0", "")]:
        entry = tmp_path / f"video{node}"
        entry.mkdir()
        (entry / "index").write_text(index)
        (entry / "name").write_text(name)

    assert devices._cameras_linux(str(tmp_path)) == [
        CameraDevice(index=0, label="HD Camera"),
        CameraDevice(index=10, label="Camera 10"),
    ]


def test_bridge_lists_devices(make_bridge: BridgeFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(devices, "sounddevice", FakeSoundDevice)
    monkeypatch.setattr(devices, "list_cameras", lambda: [CameraDevice(index=2, label="Cam")])
    bridge, collector = make_bridge([])

    bridge.handle({"type": "list-cameras", "id": "c"})
    bridge.handle({"type": "list-audio-devices", "id": "a"})

    assert collector.result("c")["data"] == {"devices": [{"index": 2, "label": "Cam"}]}
    assert collector.result("a")["data"] == {
        "ok": True,
        "microphones": [{"index": 1, "label": "Mic", "is_default": True}],
        "speakers": [{"index": 0, "label": "Speakers", "is_default": False}],
    }


def test_missing_portaudio_is_a_runtime_error(monkeypatch: pytest.MonkeyPatch) -> None:
    import builtins

    real_import = builtins.__import__

    def fail(name: str, *args: object, **kwargs: object) -> object:
        if name == "sounddevice":
            raise OSError("PortAudio library not found")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fail)
    with pytest.raises(RuntimeError, match="audio is unavailable"):
        devices.audio_devices()
