from __future__ import annotations

import numpy as np

from gosai_py.drivers.camera import _configure_existing_capture, _format_probe_results


class FakeCv2:
    CAP_PROP_FRAME_WIDTH = 3
    CAP_PROP_FRAME_HEIGHT = 4
    CAP_PROP_FPS = 5


class FakeCapture:
    def __init__(self, frame_width: int, frame_height: int, reported_fps: float) -> None:
        self.frame = np.zeros((frame_height, frame_width, 3), dtype=np.uint8)
        self.reported_fps = reported_fps
        self.settings: dict[int, float] = {}

    def set(self, prop: int, value: float) -> bool:
        self.settings[prop] = value
        return True

    def get(self, prop: int) -> float:
        if prop == FakeCv2.CAP_PROP_FPS:
            return self.reported_fps
        return self.settings.get(prop, 0)

    def read(self) -> tuple[bool, np.ndarray]:
        return True, self.frame


def test_configure_exact_camera_mode_accepts_decoded_frame() -> None:
    ok, info = _configure_existing_capture(
        FakeCapture(1280, 720, 30),
        FakeCv2,
        width=1280,
        height=720,
        fps=30,
        codec=None,
    )

    assert ok is True
    assert info["width"] == 1280
    assert info["height"] == 720


def test_configure_exact_camera_mode_rejects_lower_resolution() -> None:
    ok, _info = _configure_existing_capture(
        FakeCapture(640, 480, 30),
        FakeCv2,
        width=1280,
        height=720,
        fps=30,
        codec=None,
    )

    assert ok is False


def test_configure_exact_camera_mode_rejects_lower_reported_fps() -> None:
    ok, _info = _configure_existing_capture(
        FakeCapture(1280, 720, 15),
        FakeCv2,
        width=1280,
        height=720,
        fps=30,
        codec=None,
    )

    assert ok is False


def test_format_probe_results_skips_modes_with_no_usable_fps() -> None:
    result = _format_probe_results(
        {
            (640, 480): {
                "width": 640,
                "height": 480,
                "fps": set(),
                "codecs": {"native"},
            },
            (1280, 720): {
                "width": 1280,
                "height": 720,
                "fps": {24, 30},
                "codecs": {"native"},
            },
        }
    )

    assert result == [
        {"width": 1280, "height": 720, "fps": [24, 30], "codecs": ["native"]},
    ]
