"""Manual focus for V4L2 cameras.

OpenCV can neither list a control's range nor tell whether a device has it, so
the focus controls are read and written on the device node directly. Control
ioctls are not exclusive: they work on a second descriptor while OpenCV
streams, so focus changes never need the capture reopened.

Only Linux has V4L2. Elsewhere (macOS AVFoundation exposes no focus through
OpenCV) every device reports no focus control.
"""

from __future__ import annotations

import os
import platform
import struct
from typing import Annotated

import msgspec
from msgspec import Meta

# linux/videodev2.h
CID_FOCUS_ABSOLUTE = 0x009A090A
CID_FOCUS_AUTO = 0x009A090C
CTRL_FLAG_DISABLED = 0x0001
VIDIOC_QUERYCTRL = 0xC0445624  # _IOWR('V', 36, struct v4l2_queryctrl)
VIDIOC_G_CTRL = 0xC008561B  # _IOWR('V', 27, struct v4l2_control)
VIDIOC_S_CTRL = 0xC008561C  # _IOWR('V', 28, struct v4l2_control)
# id, type, name, minimum, maximum, step, default, flags, reserved
QUERYCTRL_FORMAT = "=II32siiiiI8s"
CONTROL_FORMAT = "=Ii"


class FocusInfo(msgspec.Struct, kw_only=True):
    """A device's `focus_absolute` control, in device units."""

    min: int
    max: int
    step: int
    default: int
    autofocus: Annotated[bool, Meta(description="Whether the device also has autofocus.")]
    autofocus_enabled: bool | None = None
    value: Annotated[
        int | None,
        Meta(description="Current focus. Under autofocus, where it last settled."),
    ] = None


class _Range(msgspec.Struct):
    min: int
    max: int
    step: int
    default: int


def _open(device: int) -> int | None:
    if platform.system() != "Linux":
        return None
    try:
        return os.open(f"/dev/video{device}", os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return None


def _query(fd: int, cid: int) -> _Range | None:
    import fcntl

    buf = bytearray(struct.pack(QUERYCTRL_FORMAT, cid, 0, b"", 0, 0, 0, 0, 0, b""))
    try:
        fcntl.ioctl(fd, VIDIOC_QUERYCTRL, buf)
    except OSError:
        return None
    _, _, _, minimum, maximum, step, default, flags, _ = struct.unpack(QUERYCTRL_FORMAT, buf)
    if flags & CTRL_FLAG_DISABLED:
        return None
    return _Range(minimum, maximum, max(1, step), default)


def _get(fd: int, cid: int) -> int | None:
    import fcntl

    buf = bytearray(struct.pack(CONTROL_FORMAT, cid, 0))
    try:
        fcntl.ioctl(fd, VIDIOC_G_CTRL, buf)
    except OSError:
        return None
    return int(struct.unpack(CONTROL_FORMAT, buf)[1])


def _set(fd: int, cid: int, value: int) -> bool:
    import fcntl

    buf = bytearray(struct.pack(CONTROL_FORMAT, cid, value))
    try:
        fcntl.ioctl(fd, VIDIOC_S_CTRL, buf)
    except OSError:
        return False
    return True


def query_focus(device: int) -> FocusInfo | None:
    """The device's manual-focus control, or None when it has none."""
    fd = _open(device)
    if fd is None:
        return None
    try:
        absolute = _query(fd, CID_FOCUS_ABSOLUTE)
        if absolute is None:
            return None
        has_auto = _query(fd, CID_FOCUS_AUTO) is not None
        auto_value = _get(fd, CID_FOCUS_AUTO) if has_auto else None
        return FocusInfo(
            min=absolute.min,
            max=absolute.max,
            step=absolute.step,
            default=absolute.default,
            autofocus=has_auto,
            autofocus_enabled=None if auto_value is None else bool(auto_value),
            value=_get(fd, CID_FOCUS_ABSOLUTE),
        )
    finally:
        os.close(fd)


def clamp_focus(value: int, lo: int, hi: int, step: int) -> int:
    """`value` moved into the range and onto the nearest step."""
    value = max(lo, min(hi, value))
    return max(lo, min(hi, lo + round((value - lo) / step) * step))


def apply_focus(device: int, focus: int | None) -> str | None:
    """Pin the focus, or hand it back to autofocus with `None`.

    Returns why it could not be applied, or None on success. Asking for
    autofocus on a device without focus controls succeeds, as there is nothing
    to undo.
    """
    fd = _open(device)
    if fd is None:
        return None if focus is None else "manual focus needs a V4L2 device (Linux)"
    try:
        absolute = _query(fd, CID_FOCUS_ABSOLUTE)
        if absolute is None:
            return None if focus is None else "the device has no manual focus control"
        has_auto = _query(fd, CID_FOCUS_AUTO) is not None
        if focus is None:
            if has_auto and not _set(fd, CID_FOCUS_AUTO, 1):
                return "could not turn autofocus back on"
            return None
        # UVC rejects writes to focus_absolute while autofocus is on.
        if has_auto and not _set(fd, CID_FOCUS_AUTO, 0):
            return "could not turn autofocus off"
        target = clamp_focus(focus, absolute.min, absolute.max, absolute.step)
        if not _set(fd, CID_FOCUS_ABSOLUTE, target):
            return "could not set the focus value"
        return None
    finally:
        os.close(fd)
