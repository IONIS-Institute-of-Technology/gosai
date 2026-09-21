from __future__ import annotations

import struct
from collections.abc import Iterator

import pytest

from fakes import FakeCameras, RecordingContext, check_result
from gosai_py import camera_focus
from gosai_py.camera_focus import FocusInfo, apply_focus, clamp_focus, query_focus
from gosai_py.drivers import camera
from gosai_py.drivers.camera import CameraDriver


class FakeV4L2:
    """The focus controls of one device, behind the module's ioctl helpers."""

    def __init__(self, *, absolute: bool = True, auto: bool = True) -> None:
        self.ranges = {}
        self.values: dict[int, int] = {}
        self.writes: list[tuple[int, int]] = []
        self.reject: set[int] = set()
        if absolute:
            self.ranges[camera_focus.CID_FOCUS_ABSOLUTE] = camera_focus._Range(0, 250, 5, 0)
            self.values[camera_focus.CID_FOCUS_ABSOLUTE] = 120
        if auto:
            self.ranges[camera_focus.CID_FOCUS_AUTO] = camera_focus._Range(0, 1, 1, 1)
            self.values[camera_focus.CID_FOCUS_AUTO] = 1

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(camera_focus, "_open", lambda device: 99)
        monkeypatch.setattr(camera_focus.os, "close", lambda fd: None)
        monkeypatch.setattr(camera_focus, "_query", lambda fd, cid: self.ranges.get(cid))
        monkeypatch.setattr(camera_focus, "_get", lambda fd, cid: self.values.get(cid))
        monkeypatch.setattr(camera_focus, "_set", self._set)

    def _set(self, fd: int, cid: int, value: int) -> bool:
        if cid in self.reject:
            return False
        self.writes.append((cid, value))
        self.values[cid] = value
        return True


@pytest.fixture
def v4l2(monkeypatch: pytest.MonkeyPatch) -> FakeV4L2:
    fake = FakeV4L2()
    fake.install(monkeypatch)
    return fake


def test_query_describes_the_focus_control(v4l2: FakeV4L2) -> None:
    assert query_focus(0) == FocusInfo(
        min=0, max=250, step=5, default=0, autofocus=True, autofocus_enabled=True, value=120
    )


def test_query_is_none_without_a_focus_control(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeV4L2(absolute=False).install(monkeypatch)
    assert query_focus(0) is None


def test_query_is_none_without_a_device_node(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(camera_focus, "_open", lambda device: None)
    assert query_focus(0) is None
    assert apply_focus(0, None) is None
    assert apply_focus(0, 100) is not None


def test_manual_focus_turns_autofocus_off_first(v4l2: FakeV4L2) -> None:
    assert apply_focus(0, 102) is None
    # 102 lands on the nearest multiple of the control's step.
    assert v4l2.writes == [
        (camera_focus.CID_FOCUS_AUTO, 0),
        (camera_focus.CID_FOCUS_ABSOLUTE, 100),
    ]


def test_none_restores_autofocus(v4l2: FakeV4L2) -> None:
    apply_focus(0, 100)
    assert apply_focus(0, None) is None
    assert v4l2.writes[-1] == (camera_focus.CID_FOCUS_AUTO, 1)


def test_manual_focus_without_autofocus_control(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeV4L2(auto=False)
    fake.install(monkeypatch)
    assert apply_focus(0, 50) is None
    assert fake.writes == [(camera_focus.CID_FOCUS_ABSOLUTE, 50)]


def test_apply_reports_why_it_failed(v4l2: FakeV4L2, monkeypatch: pytest.MonkeyPatch) -> None:
    v4l2.reject.add(camera_focus.CID_FOCUS_ABSOLUTE)
    assert apply_focus(0, 100) == "could not set the focus value"
    FakeV4L2(absolute=False).install(monkeypatch)
    assert apply_focus(0, 100) == "the device has no manual focus control"
    assert apply_focus(0, None) is None


@pytest.mark.parametrize(
    ("value", "expected"), [(-10, 0), (999, 250), (102, 100), (103, 105), (250, 250)]
)
def test_clamp_focus(value: int, expected: int) -> None:
    assert clamp_focus(value, 0, 250, 5) == expected


def test_queryctrl_layout_matches_the_ioctl_size() -> None:
    # The size is encoded in the ioctl number: a wrong layout is EINVAL on a real device.
    assert (
        struct.calcsize(camera_focus.QUERYCTRL_FORMAT)
        == (camera_focus.VIDIOC_QUERYCTRL >> 16) & 0x3FFF
    )
    assert (
        struct.calcsize(camera_focus.CONTROL_FORMAT) == (camera_focus.VIDIOC_S_CTRL >> 16) & 0x3FFF
    )


@pytest.fixture
def cameras(monkeypatch: pytest.MonkeyPatch) -> FakeCameras:
    fake = FakeCameras({0: [(1280, 720), (640, 480)]})
    monkeypatch.setattr(camera, "open_capture", fake.open)
    monkeypatch.setattr(camera, "_format_cache", {})
    monkeypatch.setattr(camera, "_devices_in_use", {})
    return fake


@pytest.fixture
def running(cameras: FakeCameras, v4l2: FakeV4L2) -> Iterator[CameraDriver]:
    driver = CameraDriver(RecordingContext())
    driver.apply_config({"device": 0, "width": 1280, "height": 720, "fps": 30, "focus": 80})
    driver._bridge_start()
    try:
        yield driver
    finally:
        assert driver._bridge_stop(5.0)


def test_configured_focus_is_applied_on_open(running: CameraDriver, v4l2: FakeV4L2) -> None:
    assert v4l2.values[camera_focus.CID_FOCUS_ABSOLUTE] == 80
    status = check_result(CameraDriver, "get_focus", running.execute("get_focus", None))
    assert status["supported"] is True
    assert status["focus"] == 80
    assert status["info"]["max"] == 250


def test_set_focus_applies_without_reopening(
    running: CameraDriver, cameras: FakeCameras, v4l2: FakeV4L2
) -> None:
    opened = len(cameras.opens)
    status = check_result(CameraDriver, "set_focus", running.execute("set_focus", {"focus": 200}))
    assert status["focus"] == 200
    assert v4l2.values[camera_focus.CID_FOCUS_ABSOLUTE] == 200
    assert len(cameras.opens) == opened


def test_set_mode_with_only_a_focus_change_does_not_reopen(
    running: CameraDriver, cameras: FakeCameras, v4l2: FakeV4L2
) -> None:
    opened = len(cameras.opens)
    mode = {"device": 0, "width": 1280, "height": 720, "fps": 30, "rotation": 0}

    result = check_result(
        CameraDriver, "set_mode", running.execute("set_mode", {**mode, "focus": None})
    )
    assert result["focus"] is None
    assert v4l2.values[camera_focus.CID_FOCUS_AUTO] == 1
    assert len(cameras.opens) == opened

    # An omitted focus is left alone, unlike a null one.
    running.execute("set_focus", {"focus": 60})
    result = running.execute("set_mode", mode)
    assert result["focus"] == 60
    assert len(cameras.opens) == opened


def test_set_mode_keeps_the_focus_across_a_reopen(
    running: CameraDriver, cameras: FakeCameras, v4l2: FakeV4L2
) -> None:
    opened = len(cameras.opens)
    v4l2.writes.clear()
    result = running.execute("set_mode", {"width": 640, "height": 480})
    assert len(cameras.opens) > opened
    assert result["focus"] == 80
    assert (camera_focus.CID_FOCUS_ABSOLUTE, 80) in v4l2.writes


def test_set_focus_raises_when_the_device_refuses(running: CameraDriver, v4l2: FakeV4L2) -> None:
    v4l2.reject.add(camera_focus.CID_FOCUS_ABSOLUTE)
    with pytest.raises(RuntimeError, match="could not set the focus value"):
        running.execute("set_focus", {"focus": 10})
    assert running.execute("get_focus", None)["focus"] == 80


def test_camera_without_focus_control_still_starts(
    cameras: FakeCameras, monkeypatch: pytest.MonkeyPatch
) -> None:
    FakeV4L2(absolute=False).install(monkeypatch)
    driver = CameraDriver(RecordingContext())
    driver.apply_config({"device": 0, "focus": 80})
    driver._bridge_start()
    try:
        assert driver.execute("get_focus", None) == {
            "supported": False,
            "focus": 80,
            "info": None,
        }
    finally:
        assert driver._bridge_stop(5.0)


def test_list_formats_reports_the_focus_control(cameras: FakeCameras, v4l2: FakeV4L2) -> None:
    formats = CameraDriver.action_specs()["list_formats"].invoke(CameraDriver, {"device": 0})
    assert formats["focus"]["max"] == 250
