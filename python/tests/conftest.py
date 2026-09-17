from __future__ import annotations

from pathlib import Path

import pytest


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _field(number: int, payload: bytes | int) -> bytes:
    if isinstance(payload, int):
        return _varint(number << 3) + _varint(payload)
    return _varint(number << 3 | 2) + _varint(len(payload)) + payload


def _float_tensor_value(name: str, dims: tuple[int, ...]) -> bytes:
    shape = b"".join(_field(1, _field(1, dim)) for dim in dims)
    tensor_type = _field(1, 1) + _field(2, shape)  # elem_type FLOAT, shape
    return _field(1, name.encode()) + _field(2, _field(1, tensor_type))


@pytest.fixture
def identity_model(tmp_path: Path) -> Path:
    """Write a float32 [1, 3] Identity model, encoded by hand to avoid the onnx package."""
    node = _field(1, b"x") + _field(2, b"y") + _field(4, b"Identity")
    graph = (
        _field(1, node)
        + _field(2, b"identity")
        + _field(11, _float_tensor_value("x", (1, 3)))
        + _field(12, _float_tensor_value("y", (1, 3)))
    )
    model = _field(1, 8) + _field(7, graph) + _field(8, _field(2, 17))
    path = tmp_path / "identity.onnx"
    path.write_bytes(model)
    return path
