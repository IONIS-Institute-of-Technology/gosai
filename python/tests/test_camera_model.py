"""Independent checks of the calibrated pinhole camera.

Expected values come from the OpenCV distortion formula written out by hand,
not from the model under test.
"""

from __future__ import annotations

import math
import warnings

import numpy as np
import pytest

from gosai_py.geometry.camera_model import CameraModel, unflip

WIDTH, HEIGHT = 1280.0, 720.0

# Barrel distortion of the size a calibration reports for a wide webcam, with
# an off-center principal point and slightly different fx/fy so that no test
# can pass by symmetry alone.
WEBCAM = CameraModel(WIDTH, HEIGHT, 900.0, 902.0, 636.0, 358.0, (-0.28, 0.09, 0.0012, -0.0008))
PINHOLE = CameraModel(WIDTH, HEIGHT, 900.0, 902.0, 636.0, 358.0)


def _frame_grid(width: float = WIDTH, height: float = HEIGHT) -> np.ndarray:
    """Pixel centers spread over the whole frame, corners included."""
    xs, ys = np.meshgrid(np.linspace(0.0, width - 1.0, 17), np.linspace(0.0, height - 1.0, 13))
    return np.column_stack([xs.ravel(), ys.ravel()])


def _distort(camera: CameraModel, rays: np.ndarray) -> np.ndarray:
    """OpenCV's forward model, written out here so `project` has nothing to lean on."""
    k1, k2, p1, p2 = camera.dist
    x, y = rays[:, 0], rays[:, 1]
    r2 = x * x + y * y
    radial = 1.0 + k1 * r2 + k2 * r2 * r2
    xd = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
    yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
    return np.column_stack([camera.fx * xd + camera.cx, camera.fy * yd + camera.cy])


def _at_depth(rays: np.ndarray, depth: float) -> np.ndarray:
    return np.column_stack([rays * depth, np.full(len(rays), depth)])


def test_project_matches_the_distortion_formula() -> None:
    rng = np.random.default_rng(1)
    rays = rng.uniform(-0.7, 0.7, size=(200, 2))
    for depth in (300.0, 1500.0):
        pixels = WEBCAM.project(_at_depth(rays, depth))
        assert np.abs(pixels - _distort(WEBCAM, rays)).max() < 1e-9


def test_project_is_scale_invariant_along_each_ray() -> None:
    """Only the direction matters: a point twice as far lands on the same pixel."""
    rng = np.random.default_rng(2)
    rays = rng.uniform(-0.7, 0.7, size=(50, 2))
    near = WEBCAM.project(_at_depth(rays, 400.0))
    far = WEBCAM.project(_at_depth(rays, 2400.0))
    assert np.abs(near - far).max() < 1e-9


def test_project_cannot_tell_a_point_behind_the_camera_apart() -> None:
    """OpenCV's projection has no near plane, so callers have to check z themselves."""
    front = WEBCAM.project([[-100.0, -50.0, 1000.0]])
    behind = WEBCAM.project([[100.0, 50.0, -1000.0]])
    assert behind == pytest.approx(front)


def test_normalize_without_distortion_is_the_plain_pinhole() -> None:
    pixels = _frame_grid()
    rays = PINHOLE.normalize(pixels)
    expected = np.column_stack(
        [(pixels[:, 0] - PINHOLE.cx) / PINHOLE.fx, (pixels[:, 1] - PINHOLE.cy) / PINHOLE.fy]
    )
    assert np.abs(rays - expected).max() < 1e-10
    assert np.abs(PINHOLE.project(_at_depth(rays, 1000.0)) - pixels).max() < 1e-9


def test_normalize_inverts_project_roughly() -> None:
    """Loose bound that holds today, so a regression beyond it still fails.

    The tight bound the model claims is checked below and does not hold.
    """
    pixels = _frame_grid()
    back = WEBCAM.project(_at_depth(WEBCAM.normalize(pixels), 1000.0))
    assert np.abs(back - pixels).max() / WEBCAM.fx < 1e-3


def test_normalize_inverts_project_over_the_frame() -> None:
    pixels = _frame_grid()
    back = WEBCAM.project(_at_depth(WEBCAM.normalize(pixels), 1000.0))
    assert np.abs(back - pixels).max() / WEBCAM.fx < 1e-6


def test_from_hfov_spans_the_requested_field_of_view() -> None:
    for hfov in (55.0, 78.0, 110.0):
        camera = CameraModel.from_hfov(WIDTH, HEIGHT, hfov)
        assert camera.fx == camera.fy
        assert (camera.cx, camera.cy) == (WIDTH / 2.0, HEIGHT / 2.0)
        assert camera.dist == ()
        # The frame edge sits half a field of view off the axis.
        edge = camera.normalize([WIDTH, HEIGHT / 2.0])
        assert math.degrees(2.0 * math.atan(float(edge[0]))) == pytest.approx(hfov, abs=1e-9)
        assert float(edge[1]) == pytest.approx(0.0, abs=1e-12)


def test_from_hfov_clamps_a_degenerate_field_of_view() -> None:
    camera = CameraModel.from_hfov(WIDTH, HEIGHT, 0.0)
    assert camera.fx == pytest.approx((WIDTH / 2.0) / 1e-6)
    assert np.isfinite(camera.normalize([0.0, 0.0])).all()


@pytest.mark.parametrize("scale", [2.0, 0.5, 1.5])
def test_scaled_to_keeps_every_ray(scale: float) -> None:
    scaled = WEBCAM.scaled_to(WIDTH * scale, HEIGHT * scale)
    assert scaled is not None
    pixels = _frame_grid()
    # Pixel p of the base frame covers the area of pixel (p + 0.5) * s - 0.5.
    moved = (pixels + 0.5) * scale - 0.5
    assert np.abs(scaled.normalize(moved) - WEBCAM.normalize(pixels)).max() < 1e-10
    assert scaled.dist == WEBCAM.dist
    assert scaled.fx == pytest.approx(WEBCAM.fx * scale)


def test_scaled_to_keeps_the_frame_corners_at_the_corners() -> None:
    scaled = WEBCAM.scaled_to(WIDTH / 2.0, HEIGHT / 2.0)
    assert scaled is not None
    # The outer edge of the frame, at -0.5, must stay the outer edge.
    assert scaled.normalize([-0.5, -0.5]) == pytest.approx(WEBCAM.normalize([-0.5, -0.5]))


def test_scaled_to_refuses_a_different_aspect_ratio() -> None:
    assert WEBCAM.scaled_to(640.0, 480.0) is None
    assert WEBCAM.scaled_to(WIDTH, HEIGHT) is WEBCAM
    # A rounding-sized mismatch is still accepted, within one percent.
    assert WEBCAM.scaled_to(640.0, 361.0) is not None


@pytest.mark.parametrize("camera", [WEBCAM, PINHOLE])
def test_missing_pixels_stay_missing_and_stay_quiet(camera: CameraModel) -> None:
    pixels = np.array(
        [
            [np.nan, 10.0],
            [100.0, np.nan],
            [np.nan, np.nan],
            [500.0, 300.0],
            [np.inf, 2.0],
            [640.0, -np.inf],
        ]
    )
    with warnings.catch_warnings(), np.errstate(all="raise"):
        warnings.simplefilter("error")
        rays = camera.normalize(pixels)
    assert np.isnan(rays[[0, 1, 2, 4, 5]]).all()
    # The one usable row is untouched by its neighbours.
    assert rays[3] == pytest.approx(camera.normalize([[500.0, 300.0]])[0])


def test_normalize_keeps_the_input_shape() -> None:
    assert WEBCAM.normalize(np.full((3, 4, 2), np.nan)).shape == (3, 4, 2)
    assert WEBCAM.normalize(np.zeros((5, 6, 7, 2))).shape == (5, 6, 7, 2)
    assert WEBCAM.normalize(np.zeros((0, 2))).shape == (0, 2)
    assert WEBCAM.normalize([100.0, 200.0]).shape == (2,)


def test_project_accepts_an_empty_array() -> None:
    assert WEBCAM.project(np.zeros((0, 3))).shape == (0, 2)


def test_unflip_is_an_involution() -> None:
    pixels = np.array([[0.0, 5.0], [10.0, 5.0], [WIDTH - 1.0, 700.0], [639.5, 0.0]])
    once = unflip(pixels, WIDTH)
    assert once[:, 0] == pytest.approx([WIDTH - 1.0, WIDTH - 11.0, 0.0, 639.5])
    assert once[:, 1] == pytest.approx(pixels[:, 1])
    assert unflip(once, WIDTH) == pytest.approx(pixels)
    # The center of an even-width frame lies between two pixels, so it moves.
    assert float(unflip([WIDTH / 2.0, 0.0], WIDTH)[0]) == WIDTH / 2.0 - 1.0


def test_unflip_leaves_its_input_alone() -> None:
    pixels = np.array([[10.0, 5.0]])
    unflip(pixels, WIDTH)
    assert pixels.tolist() == [[10.0, 5.0]]
    assert np.isnan(unflip([[np.nan, 5.0]], WIDTH)[0, 0])


def test_unflip_then_normalize_sees_the_mirrored_scene() -> None:
    """A flipped preview at pixel x maps to the ray of the camera's own x."""
    flipped = np.array([[300.0, 200.0]])
    ray = WEBCAM.normalize(unflip(flipped, WIDTH))
    assert ray[0, 0] == pytest.approx(WEBCAM.normalize([[WIDTH - 1.0 - 300.0, 200.0]])[0, 0])
