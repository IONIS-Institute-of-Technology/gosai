"""The calibrated reflection path of `pose_to_mirror`, against known geometry.

A synthetic person is built in camera millimeters, projected through a
distorted lens and handed to the driver as a raw pose payload. Whatever the
driver has to undo on the way (a flipped frame, a lens at another resolution,
a stranger whose size nobody measured), its pixels must land where
`mirror_rig.project` puts the true 3D points seen from the true eye midpoint.

The mirror serves the public, so every visitor is built the same way: their
joints are MediaPipe's average model times their own scale, which is exactly
what makes the world landmarks say nothing about how big they are. Their
pupils are the exception, because a child's head is not a small adult's, and
the face mesh is what measures them. Their irises are the other way round:
almost the same in everybody, so they are built at 11.7 mm unless a test is
about a person whose own iris is unusual.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any

import cv2
import msgspec
import numpy as np
import pytest
from numpy.typing import NDArray

from fakes import RecordingContext, check_events, check_result
from gosai_py.clock import now_ms
from gosai_py.drivers.pose_to_mirror import (
    LEFT_HAND_ANCHOR,
    RIGHT_HAND_ANCHOR,
    SWAP_JUMP_MM,
    PoseToMirrorDriver,
)
from gosai_py.geometry import mirror_rig, placement
from gosai_py.geometry.camera_model import CameraModel
from gosai_py.mirror_profiles import LensProfile, RigProfile

Array = NDArray[np.float64]

FRAME_W, FRAME_H = 1280.0, 720.0
CANVAS_W, CANVAS_H = 1080.0, 1920.0
FRAME_MS = 1000.0 / 30.0
# Frames are stamped a few seconds back, so every capture time is in the past
# however long a test runs.
BASE_MS = now_ms() - 5_000.0

# A calibrated lens: square-ish pixels, an off-center principal point and mild
# distortion. The off-center point is what makes a flipped frame more than a
# sign change.
LENS = LensProfile(
    width=FRAME_W,
    height=FRAME_H,
    fx=1150.0,
    fy=1146.0,
    cx=632.0,
    cy=354.0,
    dist=[0.05, -0.03, 0.0012, -0.0009, 0.004],
)

# The rig: a 55 cm portrait screen, tilted back 12 degrees, turned 3 degrees,
# with the camera mounted on the mirror surface above and right of center.
SCREEN_W_MM, SCREEN_H_MM = 392.85, 698.4
GAP_MM = 8.0
TILT_DEG = 12.0
YAW_DEG = 3.0
CAMERA_IN_SCREEN_MM = (35.0, -(SCREEN_H_MM / 2.0 + 45.0), -GAP_MM)

IPD_MM = 63.0
TRUE_SCALE = 1.15  # the viewer is larger than MediaPipe's average body
FACE_POINTS = 478
MID_HIP_MM = (0.0, 380.0, -1600.0)  # in screen coordinates: 1.6 m in front

# Face-mesh landmarks `placement` reads. 33/133 and 468 belong to the subject's
# right eye, 362/263 and 473 to their left. The four points around each iris
# are its boundary, across then up and down.
RIGHT_EYE_CORNERS = (33, 133)
LEFT_EYE_CORNERS = (362, 263)
RIGHT_IRIS = 468
LEFT_IRIS = 473
RIGHT_IRIS_BOUNDARY = ((469, 471), (470, 472))
LEFT_IRIS_BOUNDARY = ((474, 476), (475, 477))
# The diameter of nearly everybody's iris, and what the rig assumes by default.
IRIS_MM = placement.GENERIC_IRIS_MM

# Joints of MediaPipe's average body, in millimeters relative to the mid-hip:
# u to the viewer's right, v down, w into the mirror. MediaPipe's "left" is the
# subject's own left, which sits at smaller u and therefore at larger camera x.
# The four foot landmarks share one height, so a standing person has them all
# on the floor at once.
JOINTS_MM: dict[int, tuple[float, float, float]] = {
    0: (0.0, -680.0, -90.0),  # nose
    1: (-17.0, -712.0, -70.0),
    2: (-31.5, -710.0, -72.0),  # left eye
    3: (-46.0, -708.0, -74.0),
    4: (17.0, -712.0, -70.0),
    5: (31.5, -710.0, -72.0),  # right eye
    6: (46.0, -708.0, -74.0),
    7: (-75.0, -700.0, -10.0),  # left ear
    8: (75.0, -700.0, -10.0),
    9: (-25.0, -628.0, -80.0),
    10: (25.0, -628.0, -80.0),
    11: (-190.0, -480.0, 0.0),  # left shoulder
    12: (190.0, -480.0, 0.0),
    13: (-250.0, -250.0, -40.0),
    14: (250.0, -250.0, -40.0),
    15: (-300.0, -20.0, -120.0),  # left wrist
    16: (300.0, -20.0, -120.0),
    17: (-322.0, 40.0, -140.0),
    18: (322.0, 40.0, -140.0),
    19: (-330.0, 28.0, -152.0),
    20: (330.0, 28.0, -152.0),
    21: (-302.0, 18.0, -128.0),
    22: (302.0, 18.0, -128.0),
    23: (-95.0, 0.0, 0.0),  # left hip
    24: (95.0, 0.0, 0.0),
    25: (-105.0, 430.0, -20.0),
    26: (105.0, 430.0, -20.0),
    27: (-110.0, 860.0, 10.0),
    28: (110.0, 860.0, 10.0),
    29: (-112.0, 900.0, 40.0),  # left heel
    30: (112.0, 900.0, 40.0),
    31: (-115.0, 900.0, -80.0),  # left foot index
    32: (115.0, 900.0, -80.0),
}
HEAD_CENTER_MM = (0.0, -690.0, 0.0)  # the face mesh's own depth reference
FOOT_V_MM = JOINTS_MM[29][1]


def _rig() -> mirror_rig.Rig:
    """The true rig: the nominal tilt, turned a few degrees about the screen's vertical."""
    base = mirror_rig.Rig.nominal(SCREEN_W_MM, SCREEN_H_MM, GAP_MM, CAMERA_IN_SCREEN_MM, TILT_DEG)
    yaw, _ = cv2.Rodrigues(np.array([0.0, math.radians(YAW_DEG), 0.0]))
    rotation = base.rotation_matrix @ np.asarray(yaw, dtype=np.float64)
    rotvec, _ = cv2.Rodrigues(rotation)
    center = -rotation @ np.asarray(CAMERA_IN_SCREEN_MM, dtype=np.float64)
    return mirror_rig.Rig(
        tuple(float(v) for v in rotvec.ravel()),  # type: ignore[arg-type]
        tuple(float(v) for v in center),  # type: ignore[arg-type]
        SCREEN_W_MM,
        SCREEN_H_MM,
        GAP_MM,
    )


RIG = _rig()


def _to_camera(points: Array) -> Array:
    """Screen-frame millimeters into camera millimeters."""
    return np.asarray(points, dtype=np.float64) @ RIG.rotation_matrix.T + np.asarray(RIG.center_mm)


@dataclass(frozen=True)
class Person:
    """One pose of a synthetic viewer, in camera millimeters."""

    body: Array  # (33, 3)
    face: Array  # (478, 3)
    right_hand: Array  # (21, 3), the hand at RIGHT_HAND_ANCHOR
    left_hand: Array  # (21, 3), the hand at LEFT_HAND_ANCHOR
    face_ref_z: float  # camera depth of the mesh's z = 0 reference
    scale: float  # their size against MediaPipe's average body

    @property
    def mid_hip(self) -> Array:
        return (self.body[23] + self.body[24]) / 2.0

    @property
    def eyes(self) -> tuple[Array, Array]:
        """The body model's eye landmarks, the viewer's own left first."""
        return self.body[2], self.body[5]

    @property
    def pupils(self) -> tuple[Array, Array]:
        """The face mesh's pupils, at this person's own spacing, left first."""
        return self.face[LEFT_IRIS], self.face[RIGHT_IRIS]

    @property
    def eye_mid(self) -> Array:
        return (self.body[2] + self.body[5]) / 2.0

    def world(self, points: Array) -> Array:
        """MediaPipe world landmarks: meters from the mid-hip, divided by the body scale."""
        return (points - self.mid_hip) / 1000.0 / self.scale


def _iris_boundary(pupil: Array, iris_mm: float) -> Array:
    """The four boundary landmarks of one iris, square to the ray it is seen along.

    A visitor looks at the mirror, and the camera is on it, so their irises
    face the camera wherever in the frame they stand. `across` stays horizontal
    in the world, which is where an upright head puts it.
    """
    radius = iris_mm / 2.0
    across = np.array([pupil[2], 0.0, -pupil[0]])
    across = radius * across / np.linalg.norm(across)
    up = np.cross(pupil, across)
    up = radius * up / np.linalg.norm(up)
    return np.array([pupil + across, pupil - across, pupil + up, pupil - up])


def _face_mesh(
    head_center: Array, left_pupil: Array, right_pupil: Array, iris_mm: float | None
) -> Array:
    """A 478-point mesh around the head, with the pupils, corners and irises in place.

    `iris_mm` of None leaves the eight iris boundary landmarks NaN, the way a
    tracker that never found them reports: the size cue then has nothing to
    read, which is how the cues before it are tested on their own.
    """
    rng = np.random.default_rng(11)
    directions = rng.normal(size=(FACE_POINTS, 3))
    directions /= np.linalg.norm(directions, axis=1, keepdims=True)
    mesh = head_center + directions * np.array([75.0, 95.0, 55.0])
    # The eye corners share their pupil's depth, so the mesh's own reference
    # depth is the only unknown left in the pupil spacing.
    for corners, iris, boundary, pupil in (
        (LEFT_EYE_CORNERS, LEFT_IRIS, LEFT_IRIS_BOUNDARY, left_pupil),
        (RIGHT_EYE_CORNERS, RIGHT_IRIS, RIGHT_IRIS_BOUNDARY, right_pupil),
    ):
        mesh[iris] = pupil
        mesh[corners[0]] = pupil + np.array([-16.0, -2.0, 0.0])
        mesh[corners[1]] = pupil + np.array([16.0, 2.0, 0.0])
        across, up = boundary
        indices = [across[0], across[1], up[0], up[1]]
        mesh[indices] = np.nan if iris_mm is None else _iris_boundary(pupil, iris_mm)
    return mesh


def _hand(wrist: Array, reach: float) -> Array:
    """21 landmarks spread around a wrist, each at its own depth."""
    rng = np.random.default_rng(int(reach))
    offsets = rng.uniform(-1.0, 1.0, size=(21, 3)) * np.array([45.0, 55.0, 35.0])
    offsets[0] = 0.0
    offsets[:, 1] += np.linspace(0.0, reach, 21)
    return wrist + offsets


def _build(
    scale: float = TRUE_SCALE,
    ipd_mm: float = IPD_MM,
    hip_mm: tuple[float, float, float] = MID_HIP_MM,
    iris_mm: float | None = IRIS_MM,
) -> Person:
    """A visitor of that size, pupil spacing and iris, built in screen coordinates.

    Their joints are the average model's times `scale`, so MediaPipe reports
    the same world landmarks whoever is standing there. Their pupils are set
    on their own, because head proportions do not follow body size. Their
    irises are 11.7 mm like almost everybody's unless a test says otherwise.
    """
    hip = np.asarray(hip_mm, dtype=np.float64)
    offsets = scale * np.array([JOINTS_MM[i] for i in range(33)])
    body = _to_camera(hip + offsets)
    head = _to_camera(hip + scale * np.asarray(HEAD_CENTER_MM))
    eye_mid = hip + scale * (np.asarray(JOINTS_MM[2]) + np.asarray(JOINTS_MM[5])) / 2.0
    # u runs to the viewer's right, so their left pupil sits at the smaller u.
    half = np.array([ipd_mm / 2.0, 0.0, 0.0])
    face = _face_mesh(head, _to_camera(eye_mid - half), _to_camera(eye_mid + half), iris_mm)
    return Person(
        body=body,
        face=face,
        right_hand=_hand(body[RIGHT_HAND_ANCHOR], 80.0),
        left_hand=_hand(body[LEFT_HAND_ANCHOR], 60.0),
        face_ref_z=float(head[2]),
        scale=scale,
    )


PERSON = _build()
AVERAGE = _build(scale=1.0)


def _camera(width: float = FRAME_W, height: float = FRAME_H) -> CameraModel:
    scaled = LENS.camera().scaled_to(width, height)
    assert scaled is not None
    return scaled


def _moved(person: Person, offset: Array) -> Person:
    """The same viewer somewhere else: their world landmarks do not change."""
    return replace(
        person,
        body=person.body + offset,
        face=person.face + offset,
        right_hand=person.right_hand + offset,
        left_hand=person.left_hand + offset,
        face_ref_z=person.face_ref_z + float(offset[2]),
    )


def _raw(
    camera: CameraModel,
    *,
    step: int = 0,
    flipped: bool = False,
    face: bool = True,
    hands: bool = True,
    person: Person | None = None,
) -> dict[str, Any]:
    """One raw pose payload for the synthetic person, as the `pose` driver sends it."""
    who = person or PERSON
    width = camera.width

    def pixels(points: Array) -> Array:
        uv = camera.project(points)
        # A flipped frame mirrors the image, so mirror the pixels rather than
        # projecting a mirrored person: the principal point does not move.
        return np.column_stack([(width - 1.0) - uv[:, 0], uv[:, 1]]) if flipped else uv

    def world(points: Array) -> Array:
        rows = who.world(points)
        return np.column_stack([-rows[:, 0], rows[:, 1:]]) if flipped else rows

    body_px = pixels(who.body)
    body_world = world(who.body)
    face_px = pixels(who.face)
    # MediaPipe reports face z in the pixels of its own x, relative to the mesh
    # reference. Mirroring the frame leaves depth alone.
    face_z = (who.face[:, 2] - who.face_ref_z) * camera.fx / who.face_ref_z
    payload: dict[str, Any] = {
        "body_pose": [[float(u), float(v), 0.9] for u, v in body_px],
        "body_world_pose": [[float(x), float(y), float(z), 0.9] for x, y, z in body_world],
        "face_mesh": [[float(u), float(v), 1.0] for u, v in face_px] if face else [],
        "right_hand_pose": [],
        "left_hand_pose": [],
        "frame_width": camera.width,
        "frame_height": camera.height,
        "flipped": flipped,
        "ts": BASE_MS + step * FRAME_MS,
        "capture_ts": BASE_MS + step * FRAME_MS,
    }
    if face:
        payload["_face_xyz"] = np.column_stack([face_px, face_z])
    if hands:
        for name, key, points in (
            ("right_hand_pose", "_right_hand_world", who.right_hand),
            ("left_hand_pose", "_left_hand_world", who.left_hand),
        ):
            payload[name] = [[float(u), float(v), 0.8] for u, v in pixels(points)]
            payload[key] = world(points)
    return payload


def _expected(points: Array, person: Person = PERSON) -> Array:
    """Where the true 3D points belong on the canvas, seen from the true eye midpoint."""
    return mirror_rig.project(RIG, person.eye_mid, points, CANVAS_W, CANVAS_H)


def _settings(**overrides: Any) -> dict[str, Any]:
    return {
        "mode": "reflection",
        "rig": msgspec.to_builtins(RigProfile.of(RIG)),
        "lens": msgspec.to_builtins(LENS),
        "width": CANVAS_W,
        "height": CANVAS_H,
        "ipd_mm": IPD_MM,
        **overrides,
    }


def _driver(**overrides: Any) -> tuple[PoseToMirrorDriver, RecordingContext]:
    context = RecordingContext()
    driver = PoseToMirrorDriver(context)
    check_result(
        PoseToMirrorDriver,
        "set_mirror_config",
        driver.execute("set_mirror_config", _settings(**overrides)),
    )
    return driver, context


# Enough identical frames for the size cues to settle and for the filters to
# follow them the rest of the way.
SETTLED_FRAMES = 80


def _feed(driver: PoseToMirrorDriver, frames: int = SETTLED_FRAMES, start: int = 0, **raw: Any):
    camera = raw.pop("camera", None) or _camera()
    for step in range(start, start + frames):
        driver.on_data("pose", "raw_data", _raw(camera, step=step, **raw))


def _last(context: RecordingContext, part: str, event: str = "mirrored_data") -> Array:
    return np.asarray(context.emitted(event)[-1][part], dtype=np.float64)


def _error(rows: Array, truth: Array) -> float:
    """Largest distance in pixels between emitted rows and the expected projection."""
    assert np.isfinite(truth).all()
    return float(np.linalg.norm(rows[:, :2] - truth, axis=1).max())


def test_the_synthetic_pixels_invert_exactly() -> None:
    """Any error below is the driver's, not the lens round trip's."""
    camera = _camera()
    rays = camera.normalize(camera.project(PERSON.body))

    assert rays == pytest.approx(PERSON.body[:, :2] / PERSON.body[:, 2:3], abs=1e-9)


def test_body_hands_and_face_land_where_the_rig_projects_them() -> None:
    driver, context = _driver()

    _feed(driver)

    check_events(PoseToMirrorDriver, context)
    body = _error(_last(context, "body_pose"), _expected(PERSON.body))
    right = _error(_last(context, "right_hand_pose"), _expected(PERSON.right_hand))
    left = _error(_last(context, "left_hand_pose"), _expected(PERSON.left_hand))
    face = _error(_last(context, "face_mesh"), _expected(PERSON.face))
    # The design asks for about 2 px on this canvas. This person is invertible
    # by construction, so the driver either recovers them or has a real bug:
    # a body scale off by one part in ten already costs 180 px here.
    assert body < 0.05, f"body off by {body:.3f} px"
    assert right < 0.05 and left < 0.05, f"hands off by {max(right, left):.3f} px"
    assert face < 0.05, f"face off by {face:.3f} px"


def test_a_flipped_frame_gives_the_same_drawing() -> None:
    upright, upright_ctx = _driver()
    flipped, flipped_ctx = _driver()

    _feed(upright)
    _feed(flipped, flipped=True)

    for part in ("body_pose", "right_hand_pose", "left_hand_pose", "face_mesh"):
        assert _last(flipped_ctx, part) == pytest.approx(_last(upright_ctx, part), abs=1e-6)


def test_a_lens_at_twice_the_resolution_gives_the_same_drawing() -> None:
    driver, context = _driver()
    doubled, doubled_ctx = _driver()

    _feed(driver)
    _feed(doubled, camera=_camera(2.0 * FRAME_W, 2.0 * FRAME_H))

    assert _last(doubled_ctx, "body_pose") == pytest.approx(_last(context, "body_pose"), abs=1e-4)


def test_an_aspect_mismatch_warns_once_per_frame_size() -> None:
    driver, context = _driver()

    _feed(driver, frames=5, camera=CameraModel(960.0, 720.0, 1150.0, 1146.0, 474.0, 354.0))
    _feed(driver, frames=5, start=5, camera=CameraModel(640.0, 480.0, 575.0, 573.0, 316.0, 236.0))

    warnings = [message for level, message in context.logs if level == "warn"]
    assert len(warnings) == 2, warnings
    assert "960x720" in warnings[0] and "640x480" in warnings[1]
    # The fallback still draws: the field of view replaces the profile.
    assert np.isfinite(_last(context, "body_pose")[:, :2]).all()


def test_the_public_viewpoint_is_the_eye_midpoint() -> None:
    """A flat display registers with one eye at a time, and nobody here picks one."""
    driver, context = _driver()

    _feed(driver)

    left, right = PERSON.eyes
    from_left = mirror_rig.project(RIG, left, PERSON.body, CANVAS_W, CANVAS_H)
    from_right = mirror_rig.project(RIG, right, PERSON.body, CANVAS_W, CANVAS_H)
    drawn = _last(context, "body_pose")
    assert _error(drawn, _expected(PERSON.body)) < 0.05
    # Landmark 2 is the viewer's left eye, at the eyes' own depth, so the two
    # single-eye answers straddle the drawing by half the pupil separation.
    half_px = float(np.linalg.norm(left - right)) / 2.0 / SCREEN_W_MM * CANVAS_W
    assert from_left[2][0] < drawn[2][0] < from_right[2][0]
    assert from_right[2][0] - from_left[2][0] == pytest.approx(half_px, rel=0.05)


def test_trim_shifts_every_point_exactly() -> None:
    driver, context = _driver()
    trimmed, trimmed_ctx = _driver(trim_px=[-12.0, 7.5])

    _feed(driver)
    _feed(trimmed)

    shift = _last(trimmed_ctx, "body_pose")[:, :2] - _last(context, "body_pose")[:, :2]
    assert shift == pytest.approx(np.broadcast_to([-12.0, 7.5], shift.shape), abs=1e-9)


def test_without_a_face_the_body_eyes_take_over() -> None:
    """No face means no size cue either, so this visitor is drawn as the average one."""
    driver, context = _driver()

    _feed(driver, face=False, person=AVERAGE)

    viewer = context.emitted("viewer")[-1]
    assert viewer["eye_source"] == "body"
    assert viewer["scale_cues"] == {"eyes": None, "iris": None, "floor": None}
    assert viewer["body_scale"] == pytest.approx(1.0)
    assert viewer["left_eye_mm"] == pytest.approx(list(AVERAGE.eyes[0]), abs=1.0)
    assert _error(_last(context, "body_pose"), _expected(AVERAGE.body, AVERAGE)) < 2.0
    assert _last(context, "face_mesh").size == 0


def test_the_pupil_cue_settles_into_this_visitors_size() -> None:
    driver, context = _driver()

    _feed(driver, frames=placement.MIN_SCALE_SAMPLES - 1)
    early = context.emitted("viewer")[-1]
    _feed(driver, frames=2, start=placement.MIN_SCALE_SAMPLES - 1)
    settled = context.emitted("viewer")[-1]
    check_result(PoseToMirrorDriver, "reset_viewer", driver.execute("reset_viewer", None))
    _feed(driver, frames=1, start=placement.MIN_SCALE_SAMPLES + 1)
    after_reset = context.emitted("viewer")[-1]

    # Until the cue has enough frames the visitor is MediaPipe's average one.
    assert early["scale_cues"]["eyes"] is None
    assert early["body_scale"] == pytest.approx(1.0)
    assert settled["scale_cues"]["eyes"] == pytest.approx(TRUE_SCALE, rel=1e-3)
    assert settled["scale_cues"]["floor"] is None
    assert settled["body_scale"] == pytest.approx(TRUE_SCALE, rel=1e-3)
    assert settled["distance_mm"] == pytest.approx(
        float(mirror_rig.mirror_distance(RIG, PERSON.eye_mid)), abs=5.0
    )
    assert after_reset["scale_cues"]["eyes"] is None
    assert after_reset["body_scale"] == pytest.approx(1.0)


def test_a_new_pupil_spacing_re_estimates_the_visitor() -> None:
    """The settled cue was measured through the old spacing, so it cannot stand."""
    driver, context = _driver()
    frames = placement.MIN_SCALE_SAMPLES + 2

    _feed(driver, frames=frames)
    assert context.emitted("viewer")[-1]["scale_cues"]["eyes"] is not None

    driver.execute("set_mirror_config", {"ipd_mm": IPD_MM + 5.0})
    _feed(driver, frames=1, start=frames)

    assert context.emitted("viewer")[-1]["scale_cues"]["eyes"] is None


def test_a_gap_in_the_stream_starts_a_new_visit() -> None:
    driver, context = _driver()
    frames = placement.MIN_SCALE_SAMPLES + 2

    _feed(driver, frames=frames)
    assert context.emitted("viewer")[-1]["scale_cues"]["eyes"] is not None
    # Over a second without a body: the next person is estimated from scratch.
    _feed(driver, frames=1, start=frames + 40)

    assert context.emitted("viewer")[-1]["scale_cues"]["eyes"] is None


def test_hands_without_world_landmarks_stay_flat_at_the_wrist() -> None:
    driver, context = _driver()
    camera = _camera()

    for step in range(SETTLED_FRAMES):
        raw = _raw(camera, step=step)
        del raw["_right_hand_world"]
        driver.on_data("pose", "raw_data", raw)

    # Without them the hand lies on the wrist's depth plane, along its own rays.
    hand = PERSON.right_hand
    wrist_z = PERSON.body[RIGHT_HAND_ANCHOR][2]
    flat = hand[:, :2] / hand[:, 2:3] * wrist_z
    assert (
        _error(
            _last(context, "right_hand_pose"),
            _expected(np.column_stack([flat, wrist_z * np.ones(21)])),
        )
        < 0.05
    )
    # The other hand still has its own depths, and they matter.
    assert _error(_last(context, "left_hand_pose"), _expected(PERSON.left_hand)) < 0.05


def test_the_eyes_are_smoothed_before_they_move_the_drawing() -> None:
    driver, context = _driver()
    closer = _moved(PERSON, np.array([0.0, 0.0, -150.0]))

    _feed(driver, frames=10)
    settled = context.emitted("viewer")[-1]["left_eye_mm"]
    _feed(driver, frames=1, start=10, person=closer)
    stepped = context.emitted("viewer")[-1]["left_eye_mm"]

    # A step toward the mirror moves the viewpoint, but not all the way at once.
    assert settled[2] == pytest.approx(float(PERSON.pupils[0][2]), abs=1.0)
    assert float(closer.pupils[0][2]) < stepped[2] < settled[2]


def test_reflection_without_a_rig_draws_nothing_and_says_so_once() -> None:
    driver, context = _driver()

    _feed(driver, frames=3)
    driver.execute("set_mirror_config", {"rig": None})
    _feed(driver, frames=3, start=3)

    check_events(PoseToMirrorDriver, context)
    # No rig, no geometry: there is no viewer to report either.
    assert len(context.emitted("viewer")) == 3
    assert len(context.emitted("mirrored_data")) == 6
    assert len(context.emitted("projected_data")) == 6
    rows = _last(context, "body_pose")
    assert np.isfinite(rows).all()
    assert rows[:, :3] == pytest.approx(-1.0)
    warnings = [message for level, message in context.logs if level == "warn"]
    assert len(warnings) == 1 and "no rig profile" in warnings[0]


def test_the_payloads_carry_the_capture_time() -> None:
    driver, context = _driver()

    _feed(driver, frames=2)

    payload = context.emitted("mirrored_data")[-1]
    assert payload["capture_ts"] == pytest.approx(context.emitted("viewer")[-1]["capture_ts"])
    assert 0.0 < payload["latency_ms"] < 60_000.0


def test_projected_data_is_canvas_centered_screen_millimeters() -> None:
    driver, context = _driver()

    _feed(driver)

    mm = _last(context, "body_pose", "projected_data")
    expected = mirror_rig.project_mm(RIG, PERSON.eye_mid, PERSON.body)
    assert mm[:, :2] == pytest.approx(expected, abs=0.5)
    # Depth is the distance in front of the mirror, positive for a real viewer.
    assert mm[:, 2] == pytest.approx(mirror_rig.mirror_distance(RIG, PERSON.body), abs=5.0)


def test_missing_landmarks_stay_invalid() -> None:
    driver, context = _driver()
    camera = _camera()

    for step in range(4):
        raw = _raw(camera, step=step)
        raw["body_pose"] = [[], *raw["body_pose"][1:]]
        driver.on_data("pose", "raw_data", raw)

    assert _last(context, "body_pose")[0][:2] == pytest.approx([-1.0, -1.0])
    assert np.isfinite(_last(context, "body_pose")[1:, :2]).all()
    # Nothing on the rig path may leave as NaN: msgspec writes that as JSON
    # null, which a row of plain numbers does not allow.
    for event in ("mirrored_data", "projected_data"):
        for part in ("body_pose", "right_hand_pose", "left_hand_pose", "face_mesh"):
            assert np.isfinite(_last(context, part, event)).all(), f"{event}.{part}"


def test_a_frame_without_a_viewpoint_still_sends_finite_rows() -> None:
    driver, context = _driver()

    # No face and a body whose eyes are missing leaves nothing to project from.
    raw = _raw(_camera(), face=False)
    raw["body_pose"] = [
        [] if index in (placement.BODY_LEFT_EYE, placement.BODY_RIGHT_EYE) else row
        for index, row in enumerate(raw["body_pose"])
    ]
    driver.on_data("pose", "raw_data", raw)

    assert context.emitted("viewer")[-1]["eye_source"] == "none"
    rows = _last(context, "body_pose")
    assert np.isfinite(rows).all()
    assert rows[:, :3] == pytest.approx(-1.0)


# ---------------------------------------------------------------------------
# A stranger's size: the pupil prior, the floor, and the next visitor
# ---------------------------------------------------------------------------

# A wider lens, so the feet are in the frame at a sensible standing distance.
# The narrow one above, mounted on top of the mirror, only sees them meters
# back, which is the mounting lesson rather than a property of the cue.
WIDE_LENS = LensProfile(width=1280.0, height=960.0, fx=600.0, fy=600.0, cx=640.0, cy=480.0)
CAMERA_HEIGHT_MM = 1550.0
# The camera sits at CAMERA_IN_SCREEN_MM in the screen frame, so the floor's
# screen height follows from how high the camera is above it.
FLOOR_V_MM = CAMERA_HEIGHT_MM + CAMERA_IN_SCREEN_MM[1]
STANDING_MM = 2500.0
CHILD_SCALE = 0.65
CHILD_IPD_MM = 52.0
ADULT_SCALE = 1.15


def _standing(
    scale: float,
    ipd_mm: float,
    distance_mm: float = STANDING_MM,
    iris_mm: float | None = IRIS_MM,
) -> Person:
    """A visitor of that size standing on the floor, that far in front of the canvas.

    The foot landmarks sit `FOOT_CLEARANCE_MM` above the sole whoever is
    standing, so their height above the floor is the same for everybody and
    only the hips move.
    """
    hip_v = FLOOR_V_MM - placement.FOOT_CLEARANCE_MM - scale * FOOT_V_MM
    return _build(scale, ipd_mm, (0.0, hip_v, -distance_mm), iris_mm)


def _floor_driver(
    camera_height_mm: float | None, **overrides: Any
) -> tuple[PoseToMirrorDriver, RecordingContext]:
    return _driver(
        rig=msgspec.to_builtins(RigProfile.of(RIG, camera_height_mm)),
        lens=msgspec.to_builtins(WIDE_LENS),
        **overrides,
    )


def _wide() -> CameraModel:
    return WIDE_LENS.camera()


def test_the_synthetic_visitor_really_stands_on_the_floor() -> None:
    """Guards the generator: the feet below are on the plane the profile describes."""
    floor = RigProfile.of(RIG, CAMERA_HEIGHT_MM).floor()
    assert floor is not None
    down, height_mm = floor
    camera = _wide()
    for scale in (CHILD_SCALE, ADULT_SCALE):
        person = _standing(scale, IPD_MM)
        soles = person.body[list(placement.FLOOR_LANDMARKS)] @ down
        assert soles == pytest.approx(height_mm - placement.FOOT_CLEARANCE_MM, abs=1e-9)
        # And the whole of them is in this camera's frame, feet included.
        pixels = camera.project(person.body)
        assert (pixels[:, 1] < 0.98 * camera.height).all()
        assert (pixels[:, 1] > 0.02 * camera.height).all()


def test_the_floor_pulls_a_childs_size_toward_the_truth() -> None:
    child = _standing(CHILD_SCALE, CHILD_IPD_MM)
    driver, context = _floor_driver(CAMERA_HEIGHT_MM)

    _feed(driver, camera=_wide(), person=child)

    cues = context.emitted("viewer")[-1]["scale_cues"]
    scale = context.emitted("viewer")[-1]["body_scale"]
    # The pupil cue believes the assumed 63 mm, so it reads a 52 mm child as
    # 63/52 too big. The floor owes nothing to the child's size at all.
    assert cues["eyes"] == pytest.approx(CHILD_SCALE * IPD_MM / CHILD_IPD_MM, rel=1e-3)
    assert cues["floor"] == pytest.approx(CHILD_SCALE, rel=1e-3)
    # The cues are three sigmas apart, so the prior gives way to the floor:
    # under 1 % out instead of 21 %.
    assert CHILD_SCALE < scale < cues["eyes"]
    assert scale == pytest.approx(CHILD_SCALE, rel=0.01)


def test_the_floor_cue_shrinks_the_drawing_error_for_a_child() -> None:
    child = _standing(CHILD_SCALE, CHILD_IPD_MM)
    fused, fused_ctx = _floor_driver(CAMERA_HEIGHT_MM)
    pupils_only, pupils_ctx = _floor_driver(None)

    for driver in (fused, pupils_only):
        _feed(driver, camera=_wide(), person=child)

    truth = _expected(child.body, child)
    with_floor = _error(_last(fused_ctx, "body_pose"), truth)
    without = _error(_last(pupils_ctx, "body_pose"), truth)
    assert with_floor < 0.25 * without, f"{with_floor:.1f} px against {without:.1f} px"


def test_a_null_camera_height_turns_the_floor_cue_off() -> None:
    child = _standing(CHILD_SCALE, CHILD_IPD_MM)
    driver, context = _floor_driver(None)

    _feed(driver, camera=_wide(), person=child)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["floor"] is None
    assert viewer["body_scale"] == pytest.approx(viewer["scale_cues"]["eyes"])


def test_feet_below_the_frame_are_ignored_however_visible_they_look() -> None:
    """MediaPipe carries a foot past the edge of the image and still calls it seen."""
    close = _standing(CHILD_SCALE, CHILD_IPD_MM, distance_mm=1150.0)
    camera = _wide()
    feet = camera.project(close.body[list(placement.FLOOR_LANDMARKS)])
    torso = camera.project(close.body[[0, 11, 12, 23, 24]])
    assert (feet[:, 1] > camera.height).all()
    assert (torso[:, 1] < 0.98 * camera.height).all()
    driver, context = _floor_driver(CAMERA_HEIGHT_MM)
    no_floor, no_floor_ctx = _floor_driver(None)

    for instance in (driver, no_floor):
        _feed(instance, camera=camera, person=close)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["floor"] is None
    # Exactly the visitor a rig with the floor cue switched off would size.
    assert viewer["body_scale"] == pytest.approx(no_floor_ctx.emitted("viewer")[-1]["body_scale"])


def test_the_floor_leaves_an_average_adult_where_the_pupils_put_them() -> None:
    """Both cues agree on a 63 mm adult, so adding the floor changes nothing."""
    adult = _standing(ADULT_SCALE, IPD_MM)
    driver, context = _floor_driver(CAMERA_HEIGHT_MM)

    _feed(driver, camera=_wide(), person=adult)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["eyes"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert viewer["scale_cues"]["floor"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert viewer["body_scale"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert _error(_last(context, "body_pose"), _expected(adult.body, adult)) < 1.0


def test_a_person_swap_without_a_gap_restarts_the_estimate() -> None:
    """A child steps in while the tracker still holds the adult who was there."""
    adult = _standing(ADULT_SCALE, IPD_MM)
    child = _standing(CHILD_SCALE, CHILD_IPD_MM)
    camera = _wide()
    assert float(np.linalg.norm(child.eye_mid - adult.eye_mid)) > SWAP_JUMP_MM
    driver, context = _floor_driver(CAMERA_HEIGHT_MM)

    _feed(driver, frames=40, camera=camera, person=adult)
    before = context.emitted("viewer")[-1]
    _feed(driver, frames=1, start=40, camera=camera, person=child)
    swapped = context.emitted("viewer")[-1]
    # A second and a half of frames at 30 Hz.
    _feed(driver, frames=45, start=41, camera=camera, person=child)
    after = context.emitted("viewer")[-1]

    assert before["body_scale"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert swapped["scale_cues"] == {"eyes": None, "iris": None, "floor": None}
    assert swapped["body_scale"] == pytest.approx(1.0)
    assert after["scale_cues"]["floor"] == pytest.approx(CHILD_SCALE, rel=1e-3)
    assert after["body_scale"] == pytest.approx(CHILD_SCALE, rel=0.06)


# ---------------------------------------------------------------------------
# The iris: the cue that does not depend on who the visitor is
# ---------------------------------------------------------------------------

# The camera on top of the mirror, with the narrow lens, standing two metres
# back: the head and torso are in the frame and the feet are well below it,
# which is what the owner reports seeing most of the time.
FEET_OUT_MM = 2000.0
# An iris 5 % above average. Almost nobody is this far from 11.7 mm.
WIDE_IRIS_MM = 12.3


def _iris_driver(
    iris_mm: float = IRIS_MM, camera_height_mm: float | None = CAMERA_HEIGHT_MM
) -> tuple[PoseToMirrorDriver, RecordingContext]:
    """A driver on the narrow lens, with the diameter this camera is told to assume."""
    return _driver(rig=msgspec.to_builtins(RigProfile.of(RIG, camera_height_mm, iris_mm)))


def test_the_iris_sizes_a_child_whose_feet_are_out_of_view() -> None:
    """The case the floor cue cannot help with, which is most of them."""
    child = _standing(CHILD_SCALE, CHILD_IPD_MM, distance_mm=FEET_OUT_MM)
    no_irises = _standing(CHILD_SCALE, CHILD_IPD_MM, distance_mm=FEET_OUT_MM, iris_mm=None)
    camera = _camera()
    feet = camera.project(child.body[list(placement.FLOOR_LANDMARKS)])
    assert (feet[:, 1] > camera.height).all()
    fused, fused_ctx = _iris_driver()
    prior_only, prior_ctx = _iris_driver()

    _feed(fused, camera=camera, person=child)
    _feed(prior_only, camera=camera, person=no_irises)

    viewer = fused_ctx.emitted("viewer")[-1]
    cues = viewer["scale_cues"]
    assert cues["floor"] is None
    # The prior believes 63 mm, so it reads a 52 mm child 21 % too large. The
    # iris owes nothing to the child's size, and the prior gives way to it.
    assert cues["eyes"] == pytest.approx(CHILD_SCALE * IPD_MM / CHILD_IPD_MM, rel=1e-3)
    assert cues["iris"] == pytest.approx(CHILD_SCALE, rel=1e-3)
    assert CHILD_SCALE < viewer["body_scale"] < cues["eyes"]
    assert viewer["body_scale"] == pytest.approx(CHILD_SCALE, rel=0.03)

    truth = _expected(child.body, child)
    with_iris = _error(_last(fused_ctx, "body_pose"), truth)
    without = _error(_last(prior_ctx, "body_pose"), truth)
    assert with_iris < 0.25 * without, f"{with_iris:.1f} px against {without:.1f} px"


def test_an_adult_whose_own_iris_is_unusual_is_still_placed_closely() -> None:
    """A 12.3 mm iris is read as 5 % nearer, and the prior holds most of that back."""
    adult = _standing(ADULT_SCALE, IPD_MM, distance_mm=FEET_OUT_MM, iris_mm=WIDE_IRIS_MM)
    driver, context = _iris_driver()

    _feed(driver, camera=_camera(), person=adult)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["eyes"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert viewer["scale_cues"]["iris"] == pytest.approx(
        ADULT_SCALE * IRIS_MM / WIDE_IRIS_MM, rel=2e-3
    )
    assert viewer["body_scale"] == pytest.approx(ADULT_SCALE, rel=0.04)


def test_a_rig_that_measured_this_cameras_iris_gets_that_adult_exactly() -> None:
    """`iris_mm` is what to assume on this camera, so a rig that says 12.3 is right here."""
    adult = _standing(ADULT_SCALE, IPD_MM, distance_mm=FEET_OUT_MM, iris_mm=WIDE_IRIS_MM)
    driver, context = _iris_driver(iris_mm=WIDE_IRIS_MM)

    _feed(driver, camera=_camera(), person=adult)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["iris"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert viewer["body_scale"] == pytest.approx(ADULT_SCALE, rel=1e-3)
    assert _error(_last(context, "body_pose"), _expected(adult.body, adult)) < 1.0


def test_an_iris_too_small_in_the_image_leaves_the_estimate_as_it_was() -> None:
    """Past about 2.5 m this 720p camera has fewer than five pixels across an iris."""
    far = _standing(CHILD_SCALE, CHILD_IPD_MM, distance_mm=3000.0)
    no_irises = _standing(CHILD_SCALE, CHILD_IPD_MM, distance_mm=3000.0, iris_mm=None)
    camera = _camera()
    assert IRIS_MM * camera.fx / float(far.eye_mid[2]) < placement.MIN_IRIS_PX
    driver, context = _iris_driver(camera_height_mm=None)
    blind, blind_ctx = _iris_driver(camera_height_mm=None)

    _feed(driver, camera=camera, person=far)
    _feed(blind, camera=camera, person=no_irises)

    viewer = context.emitted("viewer")[-1]
    assert viewer["scale_cues"]["iris"] is None
    assert viewer["scale_cues"] == blind_ctx.emitted("viewer")[-1]["scale_cues"]
    # Which leaves the pupil prior alone, as before the cue existed.
    assert viewer["body_scale"] == pytest.approx(viewer["scale_cues"]["eyes"])
