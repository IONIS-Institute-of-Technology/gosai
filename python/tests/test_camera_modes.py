from __future__ import annotations

import numpy as np

from gosai_py.drivers.camera import _negotiate_mode


class FakeCv2:
    CAP_PROP_FRAME_WIDTH = 3
    CAP_PROP_FRAME_HEIGHT = 4
    CAP_PROP_FPS = 5


class FakeCapture:
    """Capture that always returns a frame of a fixed size."""

    def __init__(self, frame_width: int, frame_height: int) -> None:
        self.frame = np.zeros((frame_height, frame_width, 3), dtype=np.uint8)
        self.settings: dict[int, float] = {}

    def set(self, prop: int, value: float) -> bool:
        self.settings[prop] = value
        return True

    def get(self, prop: int) -> float:
        return self.settings.get(prop, 0)

    def read(self) -> tuple[bool, np.ndarray]:
        return True, self.frame


def test_negotiate_mode_returns_requested_size() -> None:
    actual = _negotiate_mode(FakeCapture(1280, 720), FakeCv2, 1280, 720, 30)

    assert actual == (1280, 720)


def test_negotiate_mode_reports_size_the_camera_actually_delivers() -> None:
    # Camera rounds the request down to a mode it supports.
    actual = _negotiate_mode(FakeCapture(640, 480), FakeCv2, 1920, 1080, 30)

    assert actual == (640, 480)


def test_negotiate_mode_returns_none_when_no_frame_decodes() -> None:
    class DeadCapture(FakeCapture):
        def read(self) -> tuple[bool, None]:
            return False, None

    actual = _negotiate_mode(DeadCapture(640, 480), FakeCv2, 640, 480, 30)

    assert actual is None


def test_negotiate_mode_survives_transient_decode_error() -> None:
    # The reshape error OpenCV raises mid-renegotiation must not abort the probe.
    class FlakyCapture(FakeCapture):
        def __init__(self, frame_width: int, frame_height: int) -> None:
            super().__init__(frame_width, frame_height)
            self.calls = 0

        def read(self) -> tuple[bool, np.ndarray]:
            self.calls += 1
            if self.calls == 1:
                raise Exception("OpenCV reshape: total elements not divisible")
            return True, self.frame

    actual = _negotiate_mode(FlakyCapture(1280, 720), FakeCv2, 1280, 720, 30)

    assert actual == (1280, 720)
