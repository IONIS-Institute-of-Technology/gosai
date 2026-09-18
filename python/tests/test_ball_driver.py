from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from fakes import RecordingContext, check_events, check_result
from gosai_py.drivers import ball
from gosai_py.drivers.ball import BallDriver

INPUT = (640, 640)


class _Input:
    name = "images"
    shape = (1, 3, *INPUT)


class FakeSession:
    """Detects one 40x40 ball whose top-left corner is at (100, 200) in the letterboxed input."""

    def get_inputs(self) -> list[_Input]:
        return [_Input()]

    def run(self, _outputs: None, feeds: dict[str, Any]) -> list[np.ndarray]:
        assert feeds["images"].shape == (1, 3, *INPUT)
        rows = np.zeros((1, 300, 6), dtype=np.float32)
        rows[0, 0] = [100, 200, 140, 240, 0.9, 0]
        rows[0, 1] = [300, 300, 310, 310, 0.2, 0]
        return [rows]


@pytest.fixture
def driver(monkeypatch: pytest.MonkeyPatch) -> tuple[BallDriver, RecordingContext]:
    monkeypatch.setattr(ball, "resolve_model", lambda model, log: model.path)
    monkeypatch.setattr(
        ball, "create_onnx_session", lambda path, **_: (FakeSession(), {"backend": "onnxruntime"})
    )
    context = RecordingContext()
    instance = BallDriver(context)
    instance.pre_run()
    return instance, context


def _frame() -> dict[str, Any]:
    # 640x640 frames letterbox without scaling or padding.
    return {
        "_frame": np.zeros((*INPUT, 3), dtype=np.uint8),
        "capture_ts": 1.0,
        "width": 640,
        "height": 640,
    }


def test_emits_balls_with_their_diameter(driver: tuple[BallDriver, RecordingContext]) -> None:
    instance, context = driver

    instance.on_data("camera", "frame", _frame())
    instance.on_data("camera", "frame", _frame())

    payload = context.emitted("balls")[-1]
    assert payload["count"] == 1
    assert payload["balls"][0] == {"x": 120, "y": 220, "diameter": 40.0, "vx": 0.0, "vy": 0.0}
    assert context.emitted("fps")
    check_events(BallDriver, context)


def test_homography_warps_positions_and_sizes(driver: tuple[BallDriver, RecordingContext]) -> None:
    instance, context = driver
    assert (
        check_result(
            BallDriver,
            "set_homography",
            instance.execute("set_homography", [2, 0, 0, 0, 2, 0, 0, 0, 1]),
        )
        is None
    )
    check_result(
        BallDriver,
        "set_output_size",
        instance.execute("set_output_size", {"width": 1920, "height": 1080}),
    )

    instance.on_data("camera", "frame", _frame())

    assert context.emitted("balls")[-1]["balls"][0]["diameter"] == 80.0
    assert context.emitted("balls")[-1]["balls"][0]["x"] == 240


def test_setters(driver: tuple[BallDriver, RecordingContext]) -> None:
    instance, context = driver
    assert instance.execute("set_confidence", 5) == {"confidence": 1.0}
    instance.on_data("camera", "frame", _frame())
    assert context.emitted("balls")[-1]["count"] == 0
    assert instance.execute("set_frame_skip", -3) == {"frame_skip": 0}
    assert instance.execute("set_min_ball_px", 50) == {"min_ball_px": 50.0}
    assert instance.execute("set_max_ball_px", 60) == {"max_ball_px": 60.0}
    assert instance.execute("set_cuda_device", 1) == {"cuda_device_id": 1}
    with pytest.raises(ValueError, match="length"):
        instance.execute("set_homography", [1, 2, 3])


def test_drops_balls_that_map_to_infinity(driver: tuple[BallDriver, RecordingContext]) -> None:
    instance, context = driver
    # w = 1 - x / 120 is zero at the detected ball's centre, x = 120.
    instance.execute("set_homography", [1, 0, 0, 0, 1, 0, -1 / 120, 0, 1])

    instance.on_data("camera", "frame", _frame())

    assert context.emitted("balls")[-1]["balls"] == []


# Golden values for `_letterbox`. training/tests/test_yolo_detect.py runs the
# copy in training's ONNX export on the same image and expects the same pixels,
# so changing either letterbox fails a test until the other one matches.
LETTERBOX_IMAGE = [[0, 40, 80, 120, 160, 200], [20, 60, 100, 140, 180, 220]]
# Target (height, width), the expected image, the scale and the (top, left) padding.
LETTERBOX_CASES = [
    # Shrinks by 2/3 and pads rows unevenly.
    (
        (4, 4),
        [
            [114, 114, 114, 114],
            [20, 80, 140, 200],
            [114, 114, 114, 114],
            [114, 114, 114, 114],
        ],
        2 / 3,
        (1, 0),
    ),
    # Already the target height: no resize, one column of padding on each side.
    (
        (2, 8),
        [
            [114, 0, 40, 80, 120, 160, 200, 114],
            [114, 20, 60, 100, 140, 180, 220, 114],
        ],
        1.0,
        (0, 1),
    ),
    # Grows by 1.5 and pads the last row.
    (
        (4, 9),
        [
            [0, 20, 47, 73, 100, 127, 153, 180, 200],
            [10, 30, 57, 83, 110, 137, 163, 190, 210],
            [20, 40, 67, 93, 120, 146, 173, 200, 220],
            [114, 114, 114, 114, 114, 114, 114, 114, 114],
        ],
        1.5,
        (0, 0),
    ),
]


def _three_channels(rows: list[list[int]]) -> np.ndarray:
    return np.repeat(np.array(rows, dtype=np.uint8)[:, :, None], 3, axis=2)


@pytest.mark.parametrize(("size", "expected", "scale", "pad"), LETTERBOX_CASES)
def test_letterbox_matches_the_training_export(
    size: tuple[int, int], expected: list[list[int]], scale: float, pad: tuple[int, int]
) -> None:
    out, out_scale, out_pad = ball._letterbox(_three_channels(LETTERBOX_IMAGE), size)

    assert out.dtype == np.uint8 and out.shape == (*size, 3)
    assert np.array_equal(out, _three_channels(expected))
    assert out_scale == pytest.approx(scale)
    assert out_pad == pad
