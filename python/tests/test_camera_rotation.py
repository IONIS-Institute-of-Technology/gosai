from __future__ import annotations

import numpy as np
import pytest

from gosai_py.drivers.camera import _normalise_rotation, _rotate_frame


class _FakeCv2:
    ROTATE_90_CLOCKWISE = 0
    ROTATE_180 = 1
    ROTATE_90_COUNTERCLOCKWISE = 2

    @staticmethod
    def rotate(frame: np.ndarray, code: int) -> np.ndarray:
        turns = {0: 3, 1: 2, 2: 1}[code]
        return np.rot90(frame, turns)


def test_camera_rotation_clockwise_and_dimensions() -> None:
    frame = np.array([[1, 2, 3], [4, 5, 6]])
    rotated = _rotate_frame(frame, 90, _FakeCv2)
    assert rotated.tolist() == [[4, 1], [5, 2], [6, 3]]
    assert rotated.shape == (3, 2)


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_normalise_rotation_accepts_quarter_turns(rotation: int) -> None:
    assert _normalise_rotation(rotation) == rotation


def test_normalise_rotation_rejects_other_angles() -> None:
    with pytest.raises(ValueError, match="camera rotation"):
        _normalise_rotation(45)
