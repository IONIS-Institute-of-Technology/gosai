"""Independent checks of the viewer-dependent mirror projection and its fit.

Expected screen positions are built here from scratch: the point is mirrored
through the foot of its perpendicular to the mirror plane, and the sight line
is crossed with the screen plane by solving a 3x3 system. Neither step reuses
the formula in `mirror_rig`.

Correspondences for the fit are built the other way round, from the answer
back to the inputs: pick an eye and a screen target, put the virtual image on
the line between them, fold it back through the mirror, and that is the body
point the viewer would have to align. `test_construction_reproduces_the_target`
guards that generator.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import cv2
import numpy as np
import pytest
from numpy.typing import ArrayLike

from gosai_py.geometry.mirror_rig import (
    MIN_CORRESPONDENCES,
    Correspondence,
    Rig,
    RigFit,
    RigFitError,
    fit_rig,
    mirror_distance,
    mm_to_pixels,
    pixels_to_mm,
    project,
    project_mm,
)

SCREEN_W, SCREEN_H = 600.0, 1000.0
GAP = 10.0
# The camera sits on the mirror plane, so the mirror stays put when the gap
# changes and "distance in front of the mirror" keeps one meaning.
ON_MIRROR = (0.0, 0.0, -GAP)

# Reachable alignment targets on the canvas, in mm from its center.
TARGETS = (
    (-250.0, -400.0),
    (250.0, -400.0),
    (-250.0, 350.0),
    (250.0, 350.0),
    (0.0, -80.0),
    (-180.0, 120.0),
    (180.0, -180.0),
    (0.0, 420.0),
)


def _triple(values: ArrayLike) -> tuple[float, float, float]:
    x, y, z = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y, z


def _to_camera(rig: Rig, screen: ArrayLike) -> np.ndarray:
    """A screen-frame (u, v, w) offset from the canvas center, in camera mm."""
    return rig.rotation_matrix @ np.asarray(screen, dtype=np.float64) + np.asarray(rig.center_mm)


def _to_screen(rig: Rig, camera: ArrayLike) -> np.ndarray:
    offset = np.asarray(camera, dtype=np.float64) - np.asarray(rig.center_mm)
    return rig.rotation_matrix.T @ offset


def _intersect(rig: Rig, eye: np.ndarray, point: np.ndarray) -> np.ndarray:
    """Screen mm of the reflection, from first principles."""
    axis_u, axis_v, axis_w = (rig.rotation_matrix[:, i] for i in range(3))
    center = np.asarray(rig.center_mm)
    on_mirror = center - rig.gap_mm * axis_w
    foot = point - float((point - on_mirror) @ axis_w) * axis_w
    virtual = 2.0 * foot - point
    # eye + t * (virtual - eye) == center + a * u + b * v
    columns = np.column_stack([virtual - eye, -axis_u, -axis_v])
    _, a, b = np.linalg.solve(columns, center - eye)
    return np.array([a, b])


def _rig(rng: np.random.Generator, gap: float = GAP) -> Rig:
    """A plausible rig: a downward tilt plus a few degrees of yaw and roll."""
    tilt = float(rng.uniform(-18.0, 18.0))
    rotation = Rig.nominal(SCREEN_W, SCREEN_H, gap, ON_MIRROR, tilt).rotation_matrix
    wobble, _ = cv2.Rodrigues(np.radians(rng.uniform(-3.0, 3.0, 3)))
    rotation = rotation @ wobble
    camera = np.array(
        [
            rng.uniform(-40.0, 40.0),
            -(SCREEN_H / 2.0 + rng.uniform(5.0, 40.0)),
            -gap + rng.uniform(-5.0, 5.0),
        ]
    )
    rotvec, _ = cv2.Rodrigues(rotation)
    center = -rotation @ camera
    return Rig(_triple(rotvec), _triple(center), SCREEN_W, SCREEN_H, gap)


def _correspondence(
    rig: Rig, eye_screen: ArrayLike, target: ArrayLike, point_depth: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Eye and body point (camera mm) whose reflection covers `target`.

    `point_depth` is the body point's distance in front of the canvas plane.
    """
    eye = np.asarray(eye_screen, dtype=np.float64)
    flat = np.asarray(target, dtype=np.float64)
    aim = np.array([flat[0], flat[1], 0.0])
    distance = -eye[2]
    # The virtual image lies on the eye-to-target line, beyond the canvas.
    reach = (distance + point_depth - 2.0 * rig.gap_mm) / distance
    virtual = eye + reach * (aim - eye)
    # Fold it back through the mirror plane at w = -gap.
    point = np.array([virtual[0], virtual[1], -2.0 * rig.gap_mm - virtual[2]])
    return _to_camera(rig, eye), _to_camera(rig, point), np.asarray(aim[:2])


def _dataset(
    rig: Rig,
    rng: np.random.Generator,
    distances: Sequence[float],
    count: int = 8,
    jitter: bool = False,
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray]]:
    """Alignments spread over the canvas and over the given standing distances."""
    rows = []
    for i in range(count):
        target = np.asarray(TARGETS[i % len(TARGETS)])
        if jitter:
            target = target * 0.6 + rng.uniform(-60.0, 60.0, 2)
        distance = distances[i % len(distances)]
        eye = np.array([rng.uniform(-200.0, 200.0), rng.uniform(-250.0, -50.0), -distance])
        # The board is held at arm's length in front of the eye plane.
        rows.append(_correspondence(rig, eye, target, distance - rng.uniform(250.0, 450.0)))
    return rows


def _pair(values: ArrayLike) -> tuple[float, float]:
    x, y = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y


def _as_correspondences(rows) -> list[Correspondence]:
    return [Correspondence(_triple(e), _triple(p), _pair(t)) for e, p, t in rows]


def _holdout_errors(rig: Rig, rows) -> np.ndarray:
    return np.array([float(np.linalg.norm(project_mm(rig, e, p) - t)) for e, p, t in rows])


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------


def test_matches_an_independent_plane_intersection() -> None:
    rng = np.random.default_rng(11)
    worst = 0.0
    for _ in range(40):
        rig = _rig(rng, gap=float(rng.uniform(0.0, 15.0)))
        for _ in range(10):
            eye = _to_camera(rig, rng.uniform([-300, -400, -2400], [300, 100, -700]))
            point = _to_camera(rig, rng.uniform([-600, -700, -2400], [600, 900, -400]))
            hit = project_mm(rig, eye, point)
            assert np.isfinite(hit).all()
            worst = max(worst, float(np.abs(hit - _intersect(rig, eye, point)).max()))
    assert worst < 1e-9


def test_equal_depth_hit_is_the_lateral_midpoint() -> None:
    """Your reflection on the glass is drawn half size, whatever the distance."""
    rng = np.random.default_rng(13)
    rig = _rig(rng, gap=0.0)
    for distance in (800.0, 1500.0, 2500.0):
        eye = np.array([-40.0, -120.0, -distance])
        point = np.array([200.0, 300.0, -distance])
        hit = project_mm(rig, _to_camera(rig, eye), _to_camera(rig, point))
        assert hit == pytest.approx((eye[:2] + point[:2]) / 2.0, abs=1e-9)


def test_eye_separation_of_64_mm_moves_the_hit_by_32_mm() -> None:
    rng = np.random.default_rng(17)
    rig = _rig(rng, gap=0.0)
    point = _to_camera(rig, [200.0, 300.0, -1500.0])
    left = project_mm(rig, _to_camera(rig, [-32.0, -100.0, -1500.0]), point)
    right = project_mm(rig, _to_camera(rig, [32.0, -100.0, -1500.0]), point)
    assert float(np.linalg.norm(left - right)) == pytest.approx(32.0, abs=1e-9)


def test_ignoring_the_screen_gap_shifts_the_hit_as_documented() -> None:
    """The design note's example: 10 mm of gap is worth about 2.54 mm on screen."""
    hits = {}
    for gap in (0.0, 5.0, 10.0):
        rig = Rig.nominal(SCREEN_W, SCREEN_H, gap, (0.0, 0.0, -gap), 12.0)
        eye = _to_camera(rig, [0.0, 0.0, -1500.0 - gap])
        point = _to_camera(rig, [-300.0, 700.0, -1500.0 - gap])
        assert float(mirror_distance(rig, point)) == pytest.approx(1500.0, abs=1e-9)
        hits[gap] = project_mm(rig, eye, point)
    # Eye and point are both 1.5 m from the mirror, so the hit is their midpoint.
    assert float(np.linalg.norm(hits[0.0])) == pytest.approx(380.8, abs=0.1)
    assert float(np.linalg.norm(hits[10.0] - hits[0.0])) == pytest.approx(2.54, abs=0.01)
    assert float(np.linalg.norm(hits[5.0] - hits[0.0])) == pytest.approx(1.27, abs=0.01)


def test_nothing_behind_the_mirror_has_an_image() -> None:
    rng = np.random.default_rng(19)
    rig = _rig(rng)
    eye = _to_camera(rig, [0.0, -100.0, -1500.0])
    point = _to_camera(rig, [100.0, 200.0, -1200.0])
    assert np.isfinite(project_mm(rig, eye, point)).all()
    for behind in (-GAP + 1.0, 0.0, 200.0):
        assert np.isnan(project_mm(rig, eye, _to_camera(rig, [100.0, 200.0, behind]))).all()
        assert np.isnan(project_mm(rig, _to_camera(rig, [0.0, 0.0, behind]), point)).all()
    assert np.isnan(project_mm(rig, eye, [np.nan, 0.0, 0.0])).all()
    # A point resting on the mirror is its own image, so the sight line runs
    # straight through it to the canvas a gap further on.
    on_glass = _to_camera(rig, [100.0, 200.0, -GAP])
    reach = 1500.0 / (1500.0 - GAP)
    assert project_mm(rig, eye, on_glass) == pytest.approx(
        [reach * 100.0, -100.0 + reach * 300.0], abs=1e-6
    )


def test_projection_broadcasts_over_points_and_frames() -> None:
    rng = np.random.default_rng(23)
    rig = _rig(rng)
    eye = _to_camera(rig, [0.0, -100.0, -1500.0])
    points = np.stack([_to_camera(rig, [u, 200.0, -1300.0]) for u in (-200.0, 0.0, 200.0)])
    many = project_mm(rig, eye, points)
    assert many.shape == (3, 2)
    for i in range(3):
        assert many[i] == pytest.approx(project_mm(rig, eye, points[i]))
    # One eye per row works too, and a bad row only spoils its own.
    eyes = np.stack([eye, eye, _to_camera(rig, [0.0, 0.0, 500.0])])
    per_row = project_mm(rig, eyes, points)
    assert per_row[:2] == pytest.approx(many[:2])
    assert np.isnan(per_row[2]).all()
    assert project_mm(rig, eye, points.reshape(3, 1, 3)).shape == (3, 1, 2)


def test_canvas_millimeters_and_pixels_round_trip() -> None:
    rng = np.random.default_rng(29)
    rig = _rig(rng)
    width_px, height_px = 1080.0, 1920.0
    mm = rng.uniform([-SCREEN_W, -SCREEN_H], [SCREEN_W, SCREEN_H], size=(20, 2))
    pixels = mm_to_pixels(rig, mm, width_px, height_px)
    assert pixels_to_mm(rig, pixels, width_px, height_px) == pytest.approx(mm)
    # The canvas center is the middle of the pixel rectangle; +u is +x.
    assert mm_to_pixels(rig, [0.0, 0.0], width_px, height_px) == pytest.approx([540.0, 960.0])
    assert mm_to_pixels(
        rig, [SCREEN_W / 2.0, SCREEN_H / 2.0], width_px, height_px
    ) == pytest.approx([1080.0, 1920.0])
    eye = _to_camera(rig, [0.0, -100.0, -1500.0])
    point = _to_camera(rig, [100.0, 200.0, -1300.0])
    assert project(rig, eye, point, width_px, height_px) == pytest.approx(
        mm_to_pixels(rig, project_mm(rig, eye, point), width_px, height_px)
    )


def test_mirror_distance_is_the_signed_distance_to_the_mirror() -> None:
    rng = np.random.default_rng(31)
    rig = _rig(rng)
    for depth in (-2000.0, -500.0, -GAP, 0.0, 300.0):
        point = _to_camera(rig, [120.0, -80.0, depth])
        # In front of the mirror is positive, behind it negative, zero on it.
        assert float(mirror_distance(rig, point)) == pytest.approx(-GAP - depth, abs=1e-9)
    assert mirror_distance(rig, np.zeros((4, 3))).shape == (4,)


@pytest.mark.parametrize("tilt", [-30.0, -5.0, 0.0, 12.5, 40.0])
def test_nominal_keeps_its_tilt_and_camera_position(tilt: float) -> None:
    camera = (12.0, -540.0, -GAP)
    rig = Rig.nominal(SCREEN_W, SCREEN_H, GAP, camera, tilt)
    assert rig.tilt_deg == pytest.approx(tilt, abs=1e-9)
    assert _to_screen(rig, [0.0, 0.0, 0.0]) == pytest.approx(camera, abs=1e-9)
    # A positive tilt points the camera axis downward, toward +v.
    axis = _to_screen(rig, [0.0, 0.0, 1.0]) - _to_screen(rig, [0.0, 0.0, 0.0])
    assert axis == pytest.approx([0.0, math.sin(math.radians(tilt)), -math.cos(math.radians(tilt))])
    # The columns are a right-handed orthonormal frame.
    rotation = rig.rotation_matrix
    assert rotation.T @ rotation == pytest.approx(np.eye(3), abs=1e-12)
    assert float(np.linalg.det(rotation)) == pytest.approx(1.0)


def test_nominal_defaults_put_the_camera_above_the_top_edge() -> None:
    rig = Rig.nominal(SCREEN_W, SCREEN_H, GAP)
    assert _to_screen(rig, [0.0, 0.0, 0.0]) == pytest.approx([0.0, -(SCREEN_H / 2.0 + 20.0), -GAP])
    assert rig.tilt_deg == pytest.approx(0.0)
    assert rig.gap_mm == GAP


# ---------------------------------------------------------------------------
# Calibration fit
# ---------------------------------------------------------------------------


def test_construction_reproduces_the_target() -> None:
    """The generator below is only useful if the rig already agrees with it."""
    rng = np.random.default_rng(37)
    for _ in range(5):
        rig = _rig(rng, gap=float(rng.uniform(0.0, 15.0)))
        for eye, point, target in _dataset(rig, rng, (900.0, 1500.0)):
            assert float(mirror_distance(rig, point)) > 0.0
            assert project_mm(rig, eye, point) == pytest.approx(target, abs=1e-9)


@pytest.mark.parametrize("seed", [0, 1, 2, 3, 4])
def test_fit_recovers_a_rig_exactly_without_noise(seed: int) -> None:
    rng = np.random.default_rng(seed)
    truth = _rig(rng)
    rows = _dataset(truth, rng, (900.0, 1500.0))
    fit = fit_rig(_as_correspondences(rows), SCREEN_W, SCREEN_H, GAP)

    assert fit.rms_mm < 1e-6
    assert fit.residuals_mm.shape == (8,)
    assert fit.starts_converged >= 2
    holdout = _dataset(truth, rng, (1000.0, 1700.0), count=6, jitter=True)
    assert _holdout_errors(fit.rig, holdout).max() < 1e-6
    # The pose itself comes back, not just its predictions.
    assert np.asarray(fit.rig.center_mm) == pytest.approx(np.asarray(truth.center_mm), abs=1e-6)
    assert fit.rig.rotation_matrix == pytest.approx(truth.rotation_matrix, abs=1e-8)


def test_fit_works_from_the_minimum_number_of_alignments() -> None:
    rng = np.random.default_rng(41)
    truth = _rig(rng)
    rows = _dataset(truth, rng, (900.0, 1500.0), count=MIN_CORRESPONDENCES)
    fit = fit_rig(_as_correspondences(rows), SCREEN_W, SCREEN_H, GAP)
    assert fit.rms_mm < 1e-6


def test_fit_rejects_too_few_alignments() -> None:
    rng = np.random.default_rng(43)
    truth = _rig(rng)
    rows = _dataset(truth, rng, (900.0, 1500.0), count=MIN_CORRESPONDENCES - 1)
    with pytest.raises(RigFitError, match="at least"):
        fit_rig(_as_correspondences(rows), SCREEN_W, SCREEN_H, GAP)
    with pytest.raises(RigFitError, match="at least"):
        fit_rig([], SCREEN_W, SCREEN_H, GAP)


def test_a_mirrored_camera_cannot_be_fitted() -> None:
    """Flipping the frame left to right negates every x; no rig explains that."""
    rng = np.random.default_rng(47)
    failures, worst_rms = 0, 0.0
    for _ in range(6):
        truth = _rig(rng)
        rows = _dataset(truth, rng, (900.0, 1500.0))
        clean = fit_rig(_as_correspondences(rows), SCREEN_W, SCREEN_H, GAP)
        assert clean.rms_mm < 1e-6
        flipped = [(e * [-1, 1, 1], p * [-1, 1, 1], t) for e, p, t in rows]
        try:
            bad = fit_rig(_as_correspondences(flipped), SCREEN_W, SCREEN_H, GAP)
        except RigFitError:
            failures += 1
            continue
        assert bad.rms_mm > 100.0
        worst_rms = max(worst_rms, bad.rms_mm)
    # Either outcome is a usable signal; a quiet low-residual fit would not be.
    assert failures > 0 or worst_rms > 100.0


# Alignment noise a careful user still leaves behind: the eye depth is the
# weak part, the board pose is better, and the target is judged by eye.
EYE_RAY_MM, EYE_ISO_MM = 25.0, 6.0
POINT_RAY_MM, POINT_ISO_MM = 8.0, 2.0
TARGET_MM = 3.0
TRIALS = 20


def _noisy(rng: np.random.Generator, rows) -> list[Correspondence]:
    out = []
    for eye, point, target in rows:
        along_eye = 1.0 + rng.normal(0.0, EYE_RAY_MM) / float(np.linalg.norm(eye))
        along_point = 1.0 + rng.normal(0.0, POINT_RAY_MM) / float(np.linalg.norm(point))
        out.append(
            Correspondence(
                _triple(eye * along_eye + rng.normal(0.0, EYE_ISO_MM, 3)),
                _triple(point * along_point + rng.normal(0.0, POINT_ISO_MM, 3)),
                _pair(target + rng.normal(0.0, TARGET_MM, 2)),
            )
        )
    return out


def _trial(seed: int, distances: Sequence[float]) -> tuple[RigFit, np.ndarray]:
    rng = np.random.default_rng(seed)
    truth = _rig(rng)
    fit = fit_rig(_noisy(rng, _dataset(truth, rng, distances)), SCREEN_W, SCREEN_H, GAP)
    holdout = _dataset(truth, rng, (1000.0, 1700.0), count=6, jitter=True)
    return fit, _holdout_errors(fit.rig, holdout)


@pytest.fixture(scope="module")
def noisy_trials() -> dict[str, list[tuple[RigFit, np.ndarray]]]:
    return {
        "two": [_trial(seed, (900.0, 1500.0)) for seed in range(TRIALS)],
        "one": [_trial(seed, (1500.0,)) for seed in range(TRIALS)],
    }


def test_noisy_fit_stays_usable_over_two_distances(noisy_trials) -> None:
    errors = np.array([np.median(e) for _, e in noisy_trials["two"]])
    worst = np.array([e.max() for _, e in noisy_trials["two"]])
    assert np.median(errors) < 10.0
    assert np.percentile(errors, 90) < 15.0
    assert np.median(worst) < 15.0
    # Measured with these seeds: median 4.2 mm, p90 7.2 mm, median worst 7.0 mm.


def test_predicted_error_is_the_size_of_the_real_one(noisy_trials) -> None:
    predicted = np.array([fit.predicted_error_mm for fit, _ in noisy_trials["two"]])
    worst = np.array([e.max() for _, e in noisy_trials["two"]])
    assert np.isfinite(predicted).all()
    # Same order of magnitude, and never optimistic by more than a factor of two.
    assert 0.5 < np.median(predicted) / np.median(worst) < 5.0
    assert (predicted > worst / 2.0).all()


def test_one_standing_distance_is_reported_as_worse(noisy_trials) -> None:
    """The observability check the wizard relies on to ask for a second distance."""
    two = np.array([fit.predicted_error_mm for fit, _ in noisy_trials["two"]])
    one = np.array([fit.predicted_error_mm for fit, _ in noisy_trials["one"]])
    ratio = one / two
    assert np.median(ratio) > 2.5
    assert ratio.min() > 1.5
    # The residuals do not give the wizard that warning on their own.
    rms_one = np.median([fit.rms_mm for fit, _ in noisy_trials["one"]])
    rms_two = np.median([fit.rms_mm for fit, _ in noisy_trials["two"]])
    assert abs(rms_one - rms_two) < 2.0
    # And the extra predicted error is real: the holdout error follows it.
    assert np.median([np.median(e) for _, e in noisy_trials["one"]]) > 10.0
