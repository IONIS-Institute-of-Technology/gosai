"""Camera and audio device listing, shared by the bridge and the device drivers."""

from __future__ import annotations

import contextlib
import json
import os
import platform
import re
import subprocess
from types import ModuleType
from typing import Any

import cv2
import msgspec


class CameraDevice(msgspec.Struct, kw_only=True):
    index: int
    label: str


class AudioDevice(msgspec.Struct, kw_only=True):
    index: int
    name: str
    max_input_channels: int
    max_output_channels: int
    default_samplerate: float


class AudioDevices(msgspec.Struct, kw_only=True):
    devices: list[AudioDevice]
    default_input: int | None
    default_output: int | None


def sounddevice() -> ModuleType:
    """Import `sounddevice`, which raises OSError when PortAudio is missing."""
    try:
        import sounddevice as sd
    except OSError as exc:
        raise RuntimeError(f"audio is unavailable: {exc}") from exc
    return sd


def audio_devices() -> AudioDevices:
    sd = sounddevice()
    defaults = sd.default.device

    def default(slot: int) -> int | None:
        index = int(defaults[slot])
        return index if index >= 0 else None

    return AudioDevices(
        devices=[
            AudioDevice(
                index=index,
                name=str(info.get("name") or f"Device {index}"),
                max_input_channels=int(info.get("max_input_channels", 0)),
                max_output_channels=int(info.get("max_output_channels", 0)),
                default_samplerate=float(info.get("default_samplerate", 0)),
            )
            for index, info in enumerate(sd.query_devices())
        ],
        default_input=default(0),
        default_output=default(1),
    )


def open_capture(device: int) -> Any:
    if platform.system() == "Linux":
        return cv2.VideoCapture(device, cv2.CAP_V4L2)
    return cv2.VideoCapture(device)


def list_cameras(max_index: int = 8) -> list[CameraDevice]:
    """Connected cameras, with indices that `open_capture` accepts.

    Native enumeration (macOS `system_profiler`, Linux sysfs) gives real names
    without opening devices. Opening each index with OpenCV takes about a
    second per device, so it only runs when native enumeration finds nothing.
    """
    system = platform.system()
    with contextlib.suppress(OSError, subprocess.SubprocessError, ValueError):
        devices = []
        if system == "Darwin":
            devices = _cameras_macos()
        elif system == "Linux":
            devices = _cameras_linux()
        if devices:
            return devices
    return _cameras_opencv(max_index)


def _cameras_macos() -> list[CameraDevice]:
    # OpenCV's AVFoundation backend orders devices by unique id; match it.
    out = subprocess.check_output(
        ["system_profiler", "-json", "-detailLevel", "full", "SPCameraDataType"],
        timeout=10,
        stderr=subprocess.DEVNULL,
    )
    cams = sorted(
        json.loads(out).get("SPCameraDataType", []),
        key=lambda cam: str(cam.get("spcamera_unique-id", "")),
    )
    return [
        CameraDevice(index=index, label=cam.get("_name") or f"Camera {index}")
        for index, cam in enumerate(cams)
    ]


def _cameras_linux(base: str = "/sys/class/video4linux") -> list[CameraDevice]:
    """V4L2 capture nodes. Metadata nodes have a sysfs `index` other than 0."""
    if not os.path.isdir(base):
        return []
    nodes = sorted(
        (int(match.group(1)), entry)
        for entry in os.listdir(base)
        if (match := re.fullmatch(r"video(\d+)", entry))
    )
    devices: list[CameraDevice] = []
    for node, entry in nodes:
        path = os.path.join(base, entry)
        with contextlib.suppress(OSError), open(os.path.join(path, "index")) as fh:
            if fh.read().strip() != "0":
                continue
        label = f"Camera {node}"
        with contextlib.suppress(OSError), open(os.path.join(path, "name")) as fh:
            label = fh.read().strip() or label
        devices.append(CameraDevice(index=node, label=label))
    return devices


def _cameras_opencv(max_index: int) -> list[CameraDevice]:
    """Open each index until two consecutive misses."""
    devices: list[CameraDevice] = []
    misses = 0
    for index in range(max_index):
        cap = open_capture(index)
        opened = bool(cap.isOpened())
        cap.release()
        if opened:
            devices.append(CameraDevice(index=index, label=f"Camera {index}"))
            misses = 0
        else:
            misses += 1
            if misses >= 2 and index > 0:
                break
    return devices
