"""Independent checks of metric placement from one camera.

The face tests build a rigid head model, turn it, and project it through a
pinhole, then hand the functions the relative `z` MediaPipe would report under
weak perspective: `z_px = (Z - Z_ref) * f / Z_ref`, divided by the same focal
length. Ground truth is the model's own 3D position, never a value the module
computed.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from gosai_py.geometry.placement import (
    BODY_LEFT_EYE,
    BODY_RIGHT_EYE,
    CUE_SIGMA,
    FLOOR_LANDMARKS,
    FOOT_CLEARANCE_MM,
    GENERIC_IPD_MM,
    GENERIC_IRIS_MM,
    IRIS_DIAMETERS,
    IRIS_MODEL_SIGMA,
    IRIS_PERSON_SIGMA,
    LEFT_EYE_CORNERS,
    LEFT_IRIS,
    MIN_DEPTH_MM,
    MIN_FLOOR_SLOPE,
    MIN_FLOOR_VISIBILITY,
    MIN_IRIS_PX,
    MIN_SCALE_SAMPLES,
    PRIOR_CUE,
    RIGHT_EYE_CORNERS,
    RIGHT_IRIS,
    SCALE_WINDOW,
    TRANSLATION_LANDMARKS,
    Eyes,
    SessionScale,
    apparent_iris_mm,
    body_scale_from_eyes,
    body_scale_from_floor,
    calibrated_iris_mm,
    face_depth,
    fit_translation,
    iris_depth,
    locate_eyes,
    place_body,
    place_face,
    place_hand,
)

IPD_MM = 63.0
# The iris sits in front of the plane through the eye corners, so the mesh
# depth the code reads is not the depth of the pupil it reports.
IRIS_BULGE_MM = 4.0
BODY_LANDMARKS = 33
# A 720p webcam of about 60 degrees, so the pixel counts below are the ones a
# real mirror works with.
FOCAL_PX = 1150.0


def _rays(points: np.ndarray) -> np.ndarray:
    return points[:, :2] / points[:, 2:3]


# ---------------------------------------------------------------------------
# Body
# ---------------------------------------------------------------------------


def _body_model(rng: np.random.Generator) -> np.ndarray:
    """A body in MediaPipe's world frame (mm), spread over all three axes."""
    world = rng.uniform([-250.0, -700.0, -120.0], [250.0, 500.0, 120.0], size=(BODY_LANDMARKS, 3))
    world[[BODY_LEFT_EYE, BODY_RIGHT_EYE], 2] = -45.0
    return world


def _observe_body(world: np.ndarray, translation: np.ndarray, scale: float) -> np.ndarray:
    return _rays(scale * world + translation)


def test_fit_translation_recovers_a_known_translation() -> None:
    rng = np.random.default_rng(5)
    world = _body_model(rng)
    truth = np.array([120.0, -60.0, 1800.0])
    visibility = np.full(BODY_LANDMARKS, 0.9)
    for scale in (1.0, 0.85, 1.25):
        rays = _observe_body(world, truth, scale)
        assert fit_translation(rays, world, visibility, scale) == pytest.approx(truth, abs=1e-6)


def test_fit_translation_is_proportional_to_scale() -> None:
    """The frame cannot tell a small near body from a large far one."""
    rng = np.random.default_rng(6)
    world = _body_model(rng)
    rays = _observe_body(world, np.array([120.0, -60.0, 1800.0]), 1.0)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    unit = fit_translation(rays, world, visibility, 1.0)
    assert unit is not None
    for scale in (0.7, 1.4, 2.0):
        assert fit_translation(rays, world, visibility, scale) == pytest.approx(scale * unit)


def test_fit_translation_ignores_unreliable_landmarks() -> None:
    rng = np.random.default_rng(7)
    world = _body_model(rng)
    truth = np.array([-90.0, 40.0, 2100.0])
    rays = _observe_body(world, truth, 1.0)
    visibility = np.full(BODY_LANDMARKS, 0.9)

    spoiled = rays.copy()
    spoiled[11] = [5.0, 5.0]  # wrong, but barely visible
    visibility[11] = 0.2
    spoiled[0] = [-9.0, 9.0]  # wrong, and reported as absent
    visibility[0] = 0.0
    spoiled[23] = np.nan
    world[7] = np.nan

    fitted = fit_translation(spoiled, world, visibility, 1.0)
    assert fitted == pytest.approx(truth, abs=1e-6)


def test_fit_translation_drops_a_landmark_with_no_visibility_score() -> None:
    rng = np.random.default_rng(7)
    world = _body_model(rng)
    truth = np.array([-90.0, 40.0, 2100.0])
    rays = _observe_body(world, truth, 1.0)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    spoiled = rays.copy()
    spoiled[24] = [4.0, -4.0]
    visibility[24] = np.nan
    assert fit_translation(spoiled, world, visibility, 1.0) == pytest.approx(truth, abs=1e-6)


def test_fit_translation_needs_enough_landmarks() -> None:
    rng = np.random.default_rng(8)
    world = _body_model(rng)
    rays = _observe_body(world, np.array([0.0, 0.0, 1500.0]), 1.0)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    visibility[[11, 12, 23, 24, 0]] = 0.1
    assert fit_translation(rays, world, visibility, 1.0) is None
    # A truncated frame cannot reach the torso indices at all.
    assert fit_translation(rays[:3], world[:3], np.full(3, 0.9), 1.0) is None


def test_fit_translation_needs_rays_that_spread() -> None:
    rng = np.random.default_rng(9)
    world = _body_model(rng)
    for index in TRANSLATION_LANDMARKS:
        world[index] = [0.0, 0.0, 0.0]
    rays = _observe_body(world, np.array([0.0, 0.0, 1500.0]), 1.0)
    assert fit_translation(rays, world, np.full(BODY_LANDMARKS, 0.9), 1.0) is None


def test_fit_translation_rejects_an_impossible_depth() -> None:
    rng = np.random.default_rng(10)
    world = _body_model(rng)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    for depth in (30.0, 12000.0):
        rays = _observe_body(world, np.array([0.0, 0.0, depth]), 1.0)
        assert fit_translation(rays, world, visibility, 1.0) is None


def test_fit_translation_survives_a_short_visibility_array() -> None:
    rng = np.random.default_rng(11)
    world = _body_model(rng)
    rays = _observe_body(world, np.array([0.0, 0.0, 1500.0]), 1.0)
    assert fit_translation(rays, world, np.full(4, 0.9), 1.0) is None


def test_place_body_keeps_every_ray_and_takes_its_depth_from_the_model() -> None:
    rng = np.random.default_rng(12)
    world = _body_model(rng)
    translation = np.array([120.0, -60.0, 1800.0])
    scale = 1.15
    rays = _observe_body(world, translation, scale)

    placed = place_body(rays, world, translation, scale)
    assert placed.shape == (BODY_LANDMARKS, 3)
    assert _rays(placed) == pytest.approx(rays, abs=1e-12)
    assert placed[:, 2] == pytest.approx(scale * world[:, 2] + translation[2])
    # With the translation the fit produced, the placement is the true body.
    assert placed == pytest.approx(scale * world + translation, abs=1e-9)


def test_place_body_handles_a_short_or_impossible_model() -> None:
    rng = np.random.default_rng(13)
    world = _body_model(rng)
    translation = np.array([0.0, 0.0, 1500.0])
    rays = _observe_body(world, translation, 1.0)

    short = place_body(rays, world[:10], translation, 1.0)
    assert short[10:, 2] == pytest.approx(translation[2])
    assert _rays(short) == pytest.approx(rays, abs=1e-12)

    world[5, 2] = np.nan
    assert place_body(rays, world, translation, 1.0)[5, 2] == pytest.approx(translation[2])
    # A joint the model puts behind the camera is pulled to the near limit.
    world[6, 2] = -1e5
    assert place_body(rays, world, translation, 1.0)[6, 2] == MIN_DEPTH_MM


def test_body_scale_from_eyes_recovers_a_known_scale() -> None:
    rng = np.random.default_rng(14)
    world = _body_model(rng)
    translation = np.array([70.0, -30.0, 1700.0])
    visibility = np.full(BODY_LANDMARKS, 0.9)
    for scale in (0.82, 1.0, 1.31):
        rays = _observe_body(world, translation, scale)
        eye_depth = scale * float(np.mean(world[[BODY_LEFT_EYE, BODY_RIGHT_EYE], 2])) + 1700.0
        assert body_scale_from_eyes(rays, world, visibility, eye_depth) == pytest.approx(
            scale, abs=1e-9
        )
    # A scale outside human range is refused rather than trusted.
    rays = _observe_body(world, translation, 1.0)
    assert body_scale_from_eyes(rays, world, visibility, 6000.0) is None
    assert body_scale_from_eyes(rays, world[:2], visibility, 1655.0) is None


# ---------------------------------------------------------------------------
# The floor
# ---------------------------------------------------------------------------

FLOOR_HEIGHT_MM = 1550.0  # the camera's lens above the floor
STANDING = np.array([60.0, 480.0, 2400.0])  # mid-hips, below the camera and 2.4 m away


def _down(tilt_deg: float) -> np.ndarray:
    """The way to the floor in camera coordinates, for a camera pitched down."""
    theta = math.radians(tilt_deg)
    return np.array([0.0, math.cos(theta), math.sin(theta)])


def _stand_on_floor(
    world: np.ndarray, translation: np.ndarray, scale: float, down: np.ndarray, height_mm: float
) -> np.ndarray:
    """The same model with its foot landmarks moved onto the floor.

    The floor is `down . X = height_mm` and the landmarks sit
    `FOOT_CLEARANCE_MM` above the sole, so each one has to satisfy
    `down . X = height_mm - FOOT_CLEARANCE_MM` once placed.
    """
    model = world.copy()
    target = height_mm - FOOT_CLEARANCE_MM
    for index in FLOOR_LANDMARKS:
        placed = scale * model[index] + translation
        model[index] = model[index] + (target - float(down @ placed)) / scale * down
    return model


@pytest.mark.parametrize("tilt_deg", [0.0, 12.0, -8.0])
def test_body_scale_from_floor_recovers_a_known_scale(tilt_deg: float) -> None:
    """A foot on a known floor has a depth that owes nothing to the person's size."""
    rng = np.random.default_rng(15)
    down = _down(tilt_deg)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    for scale in (0.65, 1.0, 1.28):
        world = _stand_on_floor(_body_model(rng), STANDING, scale, down, FLOOR_HEIGHT_MM)
        rays = _observe_body(world, STANDING, scale)
        assert body_scale_from_floor(rays, world, visibility, down, FLOOR_HEIGHT_MM) == (
            pytest.approx(scale, abs=1e-9)
        )


def test_body_scale_from_floor_ignores_the_feet_it_cannot_trust() -> None:
    rng = np.random.default_rng(16)
    down = _down(0.0)
    scale = 1.1
    world = _stand_on_floor(_body_model(rng), STANDING, scale, down, FLOOR_HEIGHT_MM)
    rays = _observe_body(world, STANDING, scale)
    visibility = np.full(BODY_LANDMARKS, 0.9)

    # A foot the tracker is unsure about drops out; the other three carry it.
    spoiled, unsure = rays.copy(), visibility.copy()
    spoiled[FLOOR_LANDMARKS[0]] = [0.0, 0.05]
    unsure[FLOOR_LANDMARKS[0]] = MIN_FLOOR_VISIBILITY - 0.05
    assert body_scale_from_floor(spoiled, world, unsure, down, FLOOR_HEIGHT_MM) == (
        pytest.approx(scale, abs=1e-9)
    )

    # Every foot below the bar leaves nothing to measure.
    hidden = visibility.copy()
    hidden[list(FLOOR_LANDMARKS)] = MIN_FLOOR_VISIBILITY - 0.05
    assert body_scale_from_floor(rays, world, hidden, down, FLOOR_HEIGHT_MM) is None

    # A ray close to horizontal meets the floor too far away to be worth it.
    flat = rays.copy()
    flat[list(FLOOR_LANDMARKS)] = [0.0, MIN_FLOOR_SLOPE - 0.05]
    assert body_scale_from_floor(flat, world, visibility, down, FLOOR_HEIGHT_MM) is None


def test_body_scale_from_floor_refuses_an_inhuman_answer() -> None:
    """A wrong camera height says the visitor is a giant or a doll; neither is kept."""
    rng = np.random.default_rng(17)
    down = _down(0.0)
    world = _stand_on_floor(_body_model(rng), STANDING, 1.1, down, FLOOR_HEIGHT_MM)
    rays = _observe_body(world, STANDING, 1.1)
    visibility = np.full(BODY_LANDMARKS, 0.9)
    assert body_scale_from_floor(rays, world, visibility, down, 4000.0) is None
    assert body_scale_from_floor(rays, world, visibility, down, 500.0) is None
    # A frame too short to hold a foot landmark has no cue at all.
    assert body_scale_from_floor(rays[:20], world[:20], visibility[:20], down, FLOOR_HEIGHT_MM) is (
        None
    )


# ---------------------------------------------------------------------------
# Fusing the cues over one visit
# ---------------------------------------------------------------------------


def test_session_scale_answers_the_average_person_until_a_cue_settles() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES - 1):
        session.add("eyes", 0.8)
    assert session.cue("eyes") is None
    assert session.value == 1.0
    assert session.head_factor == 1.0

    session.add("eyes", 0.8)
    assert session.cue("eyes") == pytest.approx(0.8)
    assert session.value == pytest.approx(0.8)
    # With the eyes cue alone the head keeps the spacing that cue assumed.
    assert session.head_factor == pytest.approx(1.0)


def test_session_scale_medians_away_outliers() -> None:
    session = SessionScale()
    for value in (0.9, 0.92, 0.88, 0.91, 5.0, 0.89, 0.9, 0.93, 0.01):
        session.add("eyes", value)
    assert session.cue("eyes") == pytest.approx(0.9, abs=1e-9)
    # Nothing that cannot be a scale ever enters the window.
    for unusable in (None, math.nan, math.inf, 0.0, -1.0):
        session.add("eyes", unusable)
    assert session.cue("eyes") == pytest.approx(0.9, abs=1e-9)


def test_session_scale_averages_cues_that_roughly_agree() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 1.03)
        session.add("floor", 1.0)

    # Half a sigma apart: close to the plain inverse-variance average.
    weights = {name: 1.0 / sigma**2 for name, sigma in CUE_SIGMA.items()}
    plain = math.exp(weights["eyes"] * math.log(1.03) / sum(weights.values()))
    assert 1.0 < session.value < 1.03
    assert session.value == pytest.approx(plain, rel=2e-3)


def test_session_scale_lets_the_floor_overrule_a_prior_that_is_far_off() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 0.8)
        session.add("floor", 0.65)

    # Over three sigmas apart, as for a child: the prior's weight collapses.
    disagreement = (math.log(0.8) - math.log(0.65)) / CUE_SIGMA["eyes"]
    weight_eyes = 1.0 / CUE_SIGMA["eyes"] ** 2 / (1.0 + disagreement**2)
    weight_floor = 1.0 / CUE_SIGMA["floor"] ** 2
    expected = math.exp(
        (weight_eyes * math.log(0.8) + weight_floor * math.log(0.65)) / (weight_eyes + weight_floor)
    )
    assert session.value == pytest.approx(expected)
    assert session.value == pytest.approx(0.65, rel=0.01)
    # The head is placed at this much more than the assumed pupil spacing, so
    # that it ends up on the body the floor cue just resized.
    assert session.head_factor == pytest.approx(session.value / 0.8)


def test_session_scale_takes_a_measured_cue_with_no_prior_at_all() -> None:
    """The irises alone size a visitor whose pupil spacing never settled."""
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES - 1):
        session.add("iris", 0.7)
    assert session.value == 1.0

    session.add("iris", 0.7)
    assert session.cue("iris") == pytest.approx(0.7)
    assert session.value == pytest.approx(0.7)
    # Nothing places the head against the pupil cue, so it keeps its own spacing.
    assert session.head_factor == pytest.approx(1.0)


def test_session_scale_averages_a_prior_and_an_iris_that_agree() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 1.03)
        session.add("iris", 1.0)

    # Half a sigma apart: close to the plain inverse-variance average.
    weights = {name: 1.0 / CUE_SIGMA[name] ** 2 for name in ("eyes", "iris")}
    plain = math.exp(weights["eyes"] * math.log(1.03) / sum(weights.values()))
    assert 1.0 < session.value < 1.03
    assert session.value == pytest.approx(plain, rel=2e-3)


def test_session_scale_lets_the_iris_overrule_a_prior_that_is_far_off() -> None:
    """A child: the pupil prior is 20 % wrong and the iris is not."""
    session = SessionScale()
    prior_sigma = CUE_SIGMA[PRIOR_CUE]
    iris = 0.8 * math.exp(-3.0 * prior_sigma)
    for _ in range(MIN_SCALE_SAMPLES):
        session.add(PRIOR_CUE, 0.8)
        session.add("iris", iris)

    prior_weight = 1.0 / prior_sigma**2 / (1.0 + 3.0**2)
    iris_weight = 1.0 / CUE_SIGMA["iris"] ** 2
    expected = math.exp(
        (prior_weight * math.log(0.8) + iris_weight * math.log(iris)) / (prior_weight + iris_weight)
    )
    assert session.value == pytest.approx(expected)
    assert session.value == pytest.approx(iris, rel=0.03)
    assert iris < session.value < 0.8


def test_session_scale_fuses_all_three_cues_when_it_has_them() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 0.79)
        session.add("iris", 0.65)
        session.add("floor", 0.66)

    # The two cues that measured this visitor are averaged by their variances,
    # and the prior that disagrees with both of them is left with little say.
    measured_weight = sum(1.0 / CUE_SIGMA[name] ** 2 for name in ("iris", "floor"))
    measured = (
        math.log(0.65) / CUE_SIGMA["iris"] ** 2 + math.log(0.66) / CUE_SIGMA["floor"] ** 2
    ) / measured_weight
    prior_sigma = CUE_SIGMA[PRIOR_CUE]
    disagreement = (math.log(0.79) - measured) / prior_sigma
    prior_weight = 1.0 / prior_sigma**2 / (1.0 + disagreement**2)
    expected = math.exp(
        (measured_weight * measured + prior_weight * math.log(0.79))
        / (measured_weight + prior_weight)
    )
    assert session.value == pytest.approx(expected)
    assert 0.65 < session.value < 0.67
    # The head follows the body it belongs to, not the spacing that was assumed.
    assert session.head_factor == pytest.approx(session.value / 0.79)


def test_session_scale_resets_for_the_next_visitor() -> None:
    session = SessionScale()
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 0.8)
        session.add("floor", 0.65)

    session.reset()

    assert session.cue("eyes") is None
    assert session.cue("floor") is None
    assert session.value == 1.0
    for _ in range(MIN_SCALE_SAMPLES):
        session.add("eyes", 1.2)
    assert session.value == pytest.approx(1.2)


def test_session_scale_forgets_beyond_its_window() -> None:
    """A sliding window, not a frozen value: one visitor can replace another."""
    session = SessionScale()
    for _ in range(SCALE_WINDOW):
        session.add("eyes", 0.7)
    for _ in range(SCALE_WINDOW):
        session.add("eyes", 1.3)
    assert session.cue("eyes") == pytest.approx(1.3)


# ---------------------------------------------------------------------------
# Face
# ---------------------------------------------------------------------------


def _face_model(count: int = 478, iris_mm: float = GENERIC_IRIS_MM) -> np.ndarray:
    """A rigid head in millimeters: x to the viewer's left, y down, z away.

    The two eyes are symmetric about x = 0, the corners straddle the pupil,
    and the iris sits in front of them. Each iris is a real circle of
    `iris_mm` in the face's own plane, with its four boundary landmarks on it,
    so the size cue reads this head rather than the noise around it.
    """
    rng = np.random.default_rng(21)
    model = rng.uniform([-70.0, -90.0, -20.0], [70.0, 90.0, 40.0], size=(count, 3))
    half = IPD_MM / 2.0
    eyes = (
        (1.0, LEFT_EYE_CORNERS, LEFT_IRIS, IRIS_DIAMETERS[1]),
        (-1.0, RIGHT_EYE_CORNERS, RIGHT_IRIS, IRIS_DIAMETERS[0]),
    )
    for side, (inner, outer), iris, ((across_a, across_b), (up, down)) in eyes:
        model[inner] = [side * (half - 15.0), 0.0, -2.0]
        model[outer] = [side * (half + 15.0), 0.0, 6.0]
        if iris >= count:
            continue
        center = np.array([side * half, 0.0, -IRIS_BULGE_MM])
        radius = iris_mm / 2.0
        model[iris] = center
        across = np.array([radius, 0.0, 0.0])
        vertical = np.array([0.0, radius, 0.0])
        model[across_a] = center + across
        model[across_b] = center - across
        model[up] = center - vertical
        model[down] = center + vertical
    return model


def _turn(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    yaw, pitch = np.radians(yaw_deg), np.radians(pitch_deg)
    about_y = np.array(
        [[np.cos(yaw), 0.0, np.sin(yaw)], [0.0, 1.0, 0.0], [-np.sin(yaw), 0.0, np.cos(yaw)]]
    )
    about_x = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, np.cos(pitch), -np.sin(pitch)],
            [0.0, np.sin(pitch), np.cos(pitch)],
        ]
    )
    return about_y @ about_x


def _observe_face(
    model: np.ndarray, yaw: float, pitch: float, distance: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Camera-frame truth, rays, and MediaPipe-style relative z."""
    camera = model @ _turn(yaw, pitch).T + np.array([0.0, 0.0, distance])
    # z_px = (Z - Z_ref) * f / Z_ref, then divided by f as the module expects.
    return camera, _rays(camera), camera[:, 2] / distance - 1.0


FACE_POSES = [
    (distance, yaw, pitch)
    for distance in (700.0, 1000.0, 1600.0)
    for yaw in (0.0, 15.0, 30.0, -30.0)
    for pitch in (0.0, 15.0, -15.0)
]


@pytest.mark.parametrize(("distance", "yaw", "pitch"), FACE_POSES)
def test_eyes_land_within_one_percent_of_the_distance(
    distance: float, yaw: float, pitch: float
) -> None:
    model = _face_model()
    camera, rays, rel_z = _observe_face(model, yaw, pitch, distance)

    depth = face_depth(rays, rel_z, IPD_MM)
    assert depth is not None
    assert abs(depth - distance) < 0.01 * distance

    eyes = locate_eyes(rays, rel_z, IPD_MM)
    assert eyes is not None
    assert np.linalg.norm(eyes.left - camera[LEFT_IRIS]) < 0.01 * distance
    assert np.linalg.norm(eyes.right - camera[RIGHT_IRIS]) < 0.01 * distance
    assert np.linalg.norm(eyes.left - eyes.right) == pytest.approx(IPD_MM, rel=0.02)
    assert eyes.midpoint == pytest.approx((eyes.left + eyes.right) / 2.0)


@pytest.mark.parametrize("yaw", [10.0, 20.0, 30.0])
def test_a_turned_head_needs_the_mesh_depth(yaw: float) -> None:
    """Treating both pupils as equally distant fails as soon as the head turns.

    This is why the estimate uses the mesh z instead of the pupil spacing in
    the image alone.
    """
    model = _face_model()
    distance = 900.0
    camera, rays, rel_z = _observe_face(model, yaw, 0.0, distance)
    eyes = locate_eyes(rays, rel_z, IPD_MM)
    assert eyes is not None
    with_depth = max(
        float(np.linalg.norm(eyes.left - camera[LEFT_IRIS])),
        float(np.linalg.norm(eyes.right - camera[RIGHT_IRIS])),
    )

    # The frontal shortcut: one depth for both eyes, from their image spacing.
    flat_depth = IPD_MM / float(np.linalg.norm(rays[LEFT_IRIS] - rays[RIGHT_IRIS]))
    flat = flat_depth * np.column_stack([rays, np.ones(len(rays))])
    frontal = max(
        float(np.linalg.norm(flat[LEFT_IRIS] - camera[LEFT_IRIS])),
        float(np.linalg.norm(flat[RIGHT_IRIS] - camera[RIGHT_IRIS])),
    )
    assert frontal > 10.0 * with_depth
    # At 30 degrees the shortcut is off by more than a head width.
    if yaw == 30.0:
        assert frontal > 100.0
        assert with_depth < 3.0


def test_the_viewers_left_eye_is_the_one_at_larger_camera_x() -> None:
    model = _face_model()
    for yaw in (-30.0, 0.0, 30.0):
        camera, rays, rel_z = _observe_face(model, yaw, 0.0, 1100.0)
        eyes = locate_eyes(rays, rel_z, IPD_MM)
        assert eyes is not None
        assert eyes.left[0] > eyes.right[0]
        # The model's left eye is the one the mesh calls left.
        assert np.linalg.norm(eyes.left - camera[LEFT_IRIS]) < 10.0


def test_a_mesh_without_irises_falls_back_to_the_eye_corners() -> None:
    model = _face_model(468)
    for yaw in (0.0, 30.0):
        camera, rays, rel_z = _observe_face(model, yaw, 10.0, 1000.0)
        eyes = locate_eyes(rays, rel_z, IPD_MM)
        assert eyes is not None
        left_center = camera[list(LEFT_EYE_CORNERS)].mean(axis=0)
        right_center = camera[list(RIGHT_EYE_CORNERS)].mean(axis=0)
        assert np.linalg.norm(eyes.left - left_center) < 10.0
        assert np.linalg.norm(eyes.right - right_center) < 10.0
    # A NaN iris in a full mesh takes the same path.
    camera, rays, rel_z = _observe_face(_face_model(), 0.0, 0.0, 1000.0)
    rays[[LEFT_IRIS, RIGHT_IRIS]] = np.nan
    eyes = locate_eyes(rays, rel_z, IPD_MM)
    assert eyes is not None and np.isfinite(np.concatenate([eyes.left, eyes.right])).all()


def test_a_short_or_impossible_mesh_gives_no_eyes() -> None:
    model = _face_model()
    _, rays, rel_z = _observe_face(model, 0.0, 0.0, 1000.0)
    assert face_depth(rays[:263], rel_z[:263], IPD_MM) is None
    assert locate_eyes(rays[:263], rel_z[:263], IPD_MM) is None
    assert locate_eyes(np.zeros((0, 2)), np.zeros(0), IPD_MM) is None
    # An eye corner the tracker lost leaves the spacing undefined.
    broken = rays.copy()
    broken[[*LEFT_EYE_CORNERS, LEFT_IRIS]] = np.nan
    assert locate_eyes(broken, rel_z, IPD_MM) is None
    # A pupil spacing that puts the head 20 m away is refused.
    assert face_depth(rays, rel_z, GENERIC_IPD_MM * 25.0) is None


# ---------------------------------------------------------------------------
# The iris
# ---------------------------------------------------------------------------


def _facing_iris(center: np.ndarray, diameter_mm: float) -> np.ndarray:
    """The four boundary landmarks of one iris turned square to the camera.

    An eye looking at the camera has its iris perpendicular to the ray it is
    seen along, wherever in the frame that is. `across` stays horizontal in the
    world, which is where an upright head puts it.
    """
    radius = diameter_mm / 2.0
    across = np.array([center[2], 0.0, -center[0]])
    across = radius * across / np.linalg.norm(across)
    up = np.cross(center, across)
    up = radius * up / np.linalg.norm(up)
    return np.array([center + across, center - across, center + up, center - up])


def _iris_mesh(centers: np.ndarray, diameter_mm: float = GENERIC_IRIS_MM) -> np.ndarray:
    """A 478-point mesh holding nothing but two irises facing the camera."""
    mesh = np.full((478, 3), np.nan)
    for center, ((across_a, across_b), (up, down)) in zip(centers, IRIS_DIAMETERS, strict=True):
        mesh[[across_a, across_b, up, down]] = _facing_iris(center, diameter_mm)
    return mesh


# Both eyes of a visitor: on the optical axis, far off it, and far off it at range.
IRIS_POSITIONS = [
    np.array([[-31.5, 0.0, 900.0], [31.5, 0.0, 900.0]]),
    np.array([[400.0, -260.0, 900.0], [460.0, -260.0, 900.0]]),
    np.array([[-620.0, 340.0, 1800.0], [-560.0, 340.0, 1800.0]]),
]


@pytest.mark.parametrize("centers", IRIS_POSITIONS)
@pytest.mark.parametrize("diameter_mm", [10.8, GENERIC_IRIS_MM, 12.6])
def test_iris_depth_measures_a_circular_iris_of_that_diameter(
    centers: np.ndarray, diameter_mm: float
) -> None:
    """The one cue that owes nothing to how big the person is."""
    mesh = _iris_mesh(centers, diameter_mm)
    rays = _rays(mesh)

    depth = iris_depth(rays, FOCAL_PX, diameter_mm)

    # Not exact to the last bit: the ray of the iris center is taken as the
    # average of two boundary rays, which is a hair off when they differ in
    # depth. It is six orders of magnitude below what the cue is trusted to.
    assert depth == pytest.approx(float(np.mean(centers[:, 2])), rel=1e-4)


def test_iris_depth_reads_the_diameter_it_is_given() -> None:
    """An iris a tenth larger than assumed reads a tenth too far, and that is all."""
    centers = IRIS_POSITIONS[0]
    rays = _rays(_iris_mesh(centers, 1.1 * GENERIC_IRIS_MM))
    depth = iris_depth(rays, FOCAL_PX)
    assert depth is not None
    assert depth == pytest.approx(900.0 / 1.1, rel=1e-4)


@pytest.mark.parametrize(("yaw", "pitch"), [(0.0, 0.0), (25.0, 0.0), (0.0, 15.0), (25.0, 15.0)])
def test_a_turned_head_still_gives_the_range(yaw: float, pitch: float) -> None:
    """A turned iris is an ellipse; its long axis is still the diameter.

    Turning about both axes at once shortens both measured chords, so taking
    the larger one would read a few percent too far. The chords are conjugate
    diameters of the ellipse, which give the long axis exactly.
    """
    model = _face_model()
    camera, rays, _ = _observe_face(model, yaw, pitch, 1100.0)
    truth = float(np.mean(camera[[LEFT_IRIS, RIGHT_IRIS], 2]))

    depth = iris_depth(rays, FOCAL_PX)

    assert depth is not None
    assert depth == pytest.approx(truth, rel=1e-3)


def test_an_iris_too_small_in_the_image_is_not_read() -> None:
    """Below a few pixels across, the boundary landmarks are noise."""
    depths = {}
    for distance in (2500.0, 3000.0):
        centers = np.array([[-31.5, 0.0, distance], [31.5, 0.0, distance]])
        pixels = GENERIC_IRIS_MM * FOCAL_PX / distance
        depths[round(pixels, 1)] = iris_depth(_rays(_iris_mesh(centers)), FOCAL_PX)
    assert depths == {5.4: pytest.approx(2500.0, rel=1e-4), 4.5: None}
    assert MIN_IRIS_PX == 5.0


def test_a_mesh_without_iris_boundaries_gives_no_iris_depth() -> None:
    # The 468-point mesh has no iris landmarks at all.
    _, rays, _ = _observe_face(_face_model(468), 0.0, 0.0, 900.0)
    assert iris_depth(rays, FOCAL_PX) is None
    # Nor does a full mesh whose boundary points the tracker lost.
    _, rays, _ = _observe_face(_face_model(), 0.0, 0.0, 900.0)
    lost = rays.copy()
    lost[[index for pairs in IRIS_DIAMETERS for pair in pairs for index in pair]] = np.nan
    assert iris_depth(lost, FOCAL_PX) is None
    # A depth no human eye could be at is refused rather than reported.
    assert (
        iris_depth(_rays(_iris_mesh(IRIS_POSITIONS[0])), FOCAL_PX, 15.0 * GENERIC_IRIS_MM) is None
    )


def test_apparent_iris_mm_inverts_iris_depth() -> None:
    """What the landmarks show for an eye whose depth is already known."""
    centers = IRIS_POSITIONS[1]
    truth = float(np.mean(centers[:, 2]))
    for diameter in (10.8, GENERIC_IRIS_MM, 12.6):
        rays = _rays(_iris_mesh(centers, diameter))
        apparent = apparent_iris_mm(rays, FOCAL_PX, truth)
        assert apparent is not None
        assert apparent == pytest.approx(diameter, rel=1e-4)
        assert iris_depth(rays, FOCAL_PX, apparent) == pytest.approx(truth, rel=1e-4)
    assert apparent_iris_mm(np.zeros((468, 2)), FOCAL_PX, truth) is None


def test_calibrated_iris_mm_keeps_only_the_camera_s_share_of_one_reading() -> None:
    """One operator cannot say whether it is the camera or their own iris."""
    assert calibrated_iris_mm(GENERIC_IRIS_MM) == pytest.approx(GENERIC_IRIS_MM)

    share = IRIS_MODEL_SIGMA**2 / (IRIS_MODEL_SIGMA**2 + IRIS_PERSON_SIGMA**2)
    assert calibrated_iris_mm(12.6) == pytest.approx(
        GENERIC_IRIS_MM * (12.6 / GENERIC_IRIS_MM) ** share
    )
    # Just over two thirds of the way, and the same either side of the average.
    assert calibrated_iris_mm(12.6) == pytest.approx(12.316, abs=1e-3)
    assert calibrated_iris_mm(10.8) == pytest.approx(11.06, abs=1e-2)


def test_place_face_rebuilds_the_whole_mesh() -> None:
    model = _face_model()
    distance = 1200.0
    camera, rays, rel_z = _observe_face(model, 20.0, -10.0, distance)
    placed = place_face(rays, rel_z, distance)
    assert placed == pytest.approx(camera, abs=1e-9)


# ---------------------------------------------------------------------------
# Hands
# ---------------------------------------------------------------------------


def test_place_hand_anchors_relative_depth_at_the_wrist() -> None:
    rng = np.random.default_rng(31)
    rays = rng.uniform(-0.3, 0.3, size=(21, 2))
    world = rng.uniform(-90.0, 90.0, size=(21, 3))
    wrist_depth = 1200.0
    for scale in (1.0, 1.2):
        placed = place_hand(rays, world, wrist_depth, scale)
        assert _rays(placed) == pytest.approx(rays, abs=1e-12)
        assert placed[0, 2] == pytest.approx(wrist_depth)
        expected = wrist_depth + scale * (world[:, 2] - world[0, 2])
        assert placed[:, 2] == pytest.approx(expected)


def test_place_hand_goes_flat_without_usable_world_landmarks() -> None:
    rng = np.random.default_rng(32)
    rays = rng.uniform(-0.3, 0.3, size=(21, 2))
    world = rng.uniform(-90.0, 90.0, size=(21, 3))
    for bad in (None, world[:5], np.zeros((42, 3))):
        placed = place_hand(rays, bad, 1200.0)
        assert placed[:, 2] == pytest.approx(1200.0)
        assert _rays(placed) == pytest.approx(rays, abs=1e-12)
    # A missing joint depth falls back to the wrist plane, not to NaN.
    world[4, 2] = np.nan
    assert place_hand(rays, world, 1200.0)[4, 2] == pytest.approx(1200.0)
    assert place_hand(np.zeros((0, 2)), None, 1200.0).shape == (0, 3)
    # A finger the model folds behind the camera is clamped to the near limit.
    world[5, 2] = -1e5
    assert place_hand(rays, world, 1200.0)[5, 2] == MIN_DEPTH_MM


def test_the_eye_midpoint_is_halfway_between_the_pupils() -> None:
    """The public view is always the midpoint: nobody picks an eye at a mirror."""
    eyes = Eyes(left=np.array([32.0, 0.0, 1000.0]), right=np.array([-32.0, 0.0, 1000.0]))
    assert eyes.midpoint == pytest.approx([0.0, 0.0, 1000.0])
