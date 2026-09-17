from __future__ import annotations

from collections.abc import Iterator

import numpy as np
import pytest

from fakes import FakeCameras, RecordingContext, check_events, check_result, wait_until
from gosai_py.drivers import camera
from gosai_py.drivers.camera import CameraDriver, _negotiate_mode, _rotate_frame


@pytest.fixture
def cameras(monkeypatch: pytest.MonkeyPatch) -> FakeCameras:
    fake = FakeCameras({0: [(1280, 720), (640, 480)], 1: [(640, 480)]})
    monkeypatch.setattr(camera, "open_capture", fake.open)
    monkeypatch.setattr(camera, "_format_cache", {})
    monkeypatch.setattr(camera, "_devices_in_use", {})
    return fake


@pytest.fixture
def running(cameras: FakeCameras) -> Iterator[tuple[CameraDriver, RecordingContext]]:
    context = RecordingContext()
    driver = CameraDriver(context)
    driver.apply_config({"device": 0, "width": 1280, "height": 720, "fps": 60})
    driver._bridge_start()
    try:
        yield driver, context
    finally:
        assert driver._bridge_stop(5.0)


def test_publishes_frames_at_the_negotiated_size(
    running: tuple[CameraDriver, RecordingContext], cameras: FakeCameras
) -> None:
    driver, context = running
    wait_until(lambda: len(context.emitted("color")) >= 2)

    frame = context.emitted("frame")[-1]
    assert frame["_frame"].shape == (720, 1280, 3)
    assert context.emitted("frame_size")[0] == {"width": 1280, "height": 720, "fps": 60.0, "codec": "MJPG"}
    snapshot = check_result(CameraDriver, "snapshot", driver.execute("snapshot", None))
    assert snapshot["jpeg_base64"]
    check_events(CameraDriver, context)


def test_mode_change_releases_the_device_before_reopening(
    running: tuple[CameraDriver, RecordingContext], cameras: FakeCameras
) -> None:
    driver, context = running

    result = check_result(
        CameraDriver, "set_mode", driver.execute("set_mode", {"width": 640, "height": 480, "rotation": 90})
    )

    # The fake refuses a second handle, so this only works if the first was released.
    assert result == {"device": 0, "width": 640, "height": 480, "fps": 60.0, "rotation": 90, "codec": "MJPG"}
    assert context.states == ["running"]
    wait_until(lambda: bool(context.emitted("frame")) and context.emitted("frame")[-1]["width"] == 480)
    assert context.emitted("frame_size")[-1]["width"] == 480
    assert list(cameras.open_handles) == [0]


def test_failed_mode_change_restores_the_previous_device(
    running: tuple[CameraDriver, RecordingContext], cameras: FakeCameras
) -> None:
    driver, _ = running

    with pytest.raises(RuntimeError, match="cannot open camera device=5"):
        driver.execute("set_device", 5)

    assert cameras.opens == [0, 5, 0]
    assert list(cameras.open_handles) == [0]
    assert driver.execute("set_resolution", {"width": 640, "height": 480}) == {"width": 640, "height": 480}


def test_setters_validate_their_data(running: tuple[CameraDriver, RecordingContext]) -> None:
    driver, _ = running
    with pytest.raises(ValueError, match="rotation"):
        driver.execute("set_mode", {"rotation": 45})
    with pytest.raises(ValueError, match="Expected `int`"):
        driver.execute("set_device", "front")


def test_list_formats_probes_a_free_device(cameras: FakeCameras) -> None:
    result = check_result(
        CameraDriver, "list_formats", CameraDriver.action_specs()["list_formats"].invoke(CameraDriver, {"device": 1})
    )

    assert result == {
        "ok": True,
        "device": 1,
        "formats": [{"width": 640, "height": 480, "fps": [24, 30, 60]}],
        "in_use": False,
    }
    assert cameras.open_handles == {}


def test_list_formats_answers_from_cache_for_a_device_in_use(
    running: tuple[CameraDriver, RecordingContext], cameras: FakeCameras
) -> None:
    opens = len(cameras.opens)

    result = CameraDriver.action_specs()["list_formats"].invoke(CameraDriver, {"device": 0})

    assert result["in_use"] is True
    assert result["formats"] == [{"width": 1280, "height": 720, "fps": [60]}]
    assert len(cameras.opens) == opens


def test_start_fails_when_the_device_is_missing(cameras: FakeCameras) -> None:
    driver = CameraDriver(RecordingContext())
    driver.apply_config({"device": 3})
    with pytest.raises(RuntimeError, match="cannot open camera device=3"):
        driver._bridge_start()
    assert cameras.open_handles == {}


class _Capture:
    """Capture that always returns a frame of a fixed size."""

    def __init__(self, width: int, height: int) -> None:
        self.frame = np.zeros((height, width, 3), dtype=np.uint8)

    def set(self, prop: int, value: float) -> bool:
        return True

    def read(self) -> tuple[bool, np.ndarray | None]:
        return True, self.frame


def test_negotiate_mode_reports_the_size_the_camera_delivers() -> None:
    assert _negotiate_mode(_Capture(1280, 720), 1280, 720, 30) == (1280, 720)
    assert _negotiate_mode(_Capture(640, 480), 1920, 1080, 30) == (640, 480)


def test_negotiate_mode_returns_none_when_no_frame_decodes() -> None:
    class Dead(_Capture):
        def read(self) -> tuple[bool, None]:
            return False, None

    assert _negotiate_mode(Dead(640, 480), 640, 480, 30) is None


def test_negotiate_mode_survives_a_transient_decode_error() -> None:
    import cv2

    class Flaky(_Capture):
        calls = 0

        def read(self) -> tuple[bool, np.ndarray | None]:
            self.calls += 1
            if self.calls == 1:
                raise cv2.error("reshape: total elements not divisible")
            return True, self.frame

    assert _negotiate_mode(Flaky(1280, 720), 1280, 720, 30) == (1280, 720)


def test_rotation_turns_clockwise() -> None:
    frame = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.uint8)
    assert _rotate_frame(frame, 90).tolist() == [[4, 1], [5, 2], [6, 3]]
    assert _rotate_frame(frame, 0) is frame
