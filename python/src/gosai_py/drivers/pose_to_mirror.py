"""Pose-to-mirror driver (webcam-only).

Maps MediaPipe body, hand and face landmarks from `pose.raw_data` onto a
portrait screen, so the drawn skeleton lines up with the user.

Two paths, chosen with `set_mirror_config`:

- `mode: "direct"` (default): a webcam selfie overlay. Landmarks are normalised
  by the camera frame, optionally flipped, and fitted to the canvas (`contain`
  or `cover`, times `zoom`). No calibration needed.
- `mode: "reflection"`: the calibrated projection. Landmarks are placed in
  camera millimeters by `gosai_py.geometry.placement`, then projected from the
  viewer's eye onto the screen behind the mirror by
  `gosai_py.geometry.mirror_rig`. Lens intrinsics come from `lens` and the
  mirror pose from `rig`. Without a `rig` there is no geometry at all: every
  landmark leaves marked invalid and the driver warns once, since the app
  calibrates before it switches the mode.

The mirror stands in a public space, so nothing here is measured per visitor.
Each visitor's size is estimated every frame from three cues: the pupil
spacing, the apparent size of their irises, and, when their feet are in view,
the floor. `placement.SessionScale` fuses them and starts over when the next
person arrives. `ipd_mm` is the population prior that the pupil cue assumes,
not one person's measurement; the iris diameter the cue assumes comes from the
rig profile, because the calibration measured how this camera reads one.

Output is smoothed per part by a One Euro filter in canvas pixels, timed by the
frame's capture timestamp. Setting `face_mesh` to false sends empty face meshes
and skips their projection.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Annotated, Any, ClassVar, Literal

import msgspec
import numpy as np
from msgspec import UNSET, Meta, UnsetType

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import latency_ms
from gosai_py.geometry import mirror_rig, placement
from gosai_py.geometry.camera_model import Array, CameraModel, unflip
from gosai_py.mirror_profiles import LensProfile, RigProfile
from gosai_py.payloads import CaptureMs, EpochMs
from gosai_py.smoothing import OneEuro

FACE_ANCHOR = 2  # left-eye landmark; the face mesh takes its depth.
RIGHT_HAND_ANCHOR = 15  # left wrist; pose swaps hand keys upstream.
LEFT_HAND_ANCHOR = 16  # right wrist.
SHOULDERS = (11, 12)

PARTS = ("body_pose", "right_hand_pose", "left_hand_pose", "face_mesh")
# One Euro parameters per part, in canvas pixels: (min_cutoff_hz, beta). Hands
# and the face are small and fast, so they give way to motion sooner.
SMOOTHING = {
    "body_pose": (1.5, 0.02),
    "right_hand_pose": (2.5, 0.03),
    "left_hand_pose": (2.5, 0.03),
    "face_mesh": (2.5, 0.03),
}
# Eyes and body translation, in camera millimeters. Depth from one camera is
# the noisiest input here and the eyes move the whole drawing, so these smooth
# harder than the output filters.
VIEWER_SMOOTHING = (1.0, 0.01)

# No body for this long ends a visit: the next person gets their own scale.
SESSION_GAP_MS = 1000.0
# Eye midpoints this far apart on consecutive frames are two different people,
# one walking in while the tracker still held the other.
SWAP_JUMP_MM = 250.0
# How long a frame without a usable translation may reuse the last good one.
TRANSLATION_HOLD_MS = 1000.0
# MediaPipe carries a landmark past the edge of the image and still reports it
# as visible, which feet below the frame do often enough to poison the floor
# cue. Anything outside the frame, less this margin of each side, counts as
# unseen.
FRAME_MARGIN = 0.02

Ipd = Annotated[
    float,
    Meta(
        ge=45.0,
        le=80.0,
        description="Assumed pupil spacing of the viewer, in mm. The population prior: the "
        "calibration operator pushes their own measured value while checking a fit.",
    ),
]
TrimPx = Annotated[
    list[float],
    Meta(min_length=2, max_length=2, description="[dx, dy] added to every projected pixel."),
]
Landmark = list[float]


class MirrorSettings(msgspec.Struct, kw_only=True):
    """Every setting of the driver. Distances are millimeters."""

    mode: Literal["direct", "reflection"] = "direct"
    fit: Literal["contain", "cover"] = "contain"
    mirror: bool = True
    face_mesh: bool = True
    width: float = 1080.0
    height: float = 1920.0
    hfov_deg: float = 60.0
    default_distance_mm: float = 1500.0
    zoom: float = 1.0
    lens: LensProfile | None = None
    rig: RigProfile | None = None
    ipd_mm: Ipd = placement.GENERIC_IPD_MM
    trim_px: TrimPx = msgspec.field(default_factory=lambda: [0.0, 0.0])

    def camera(self, frame_w: float, frame_h: float) -> tuple[CameraModel, bool]:
        """The frame's camera model, and whether a lens profile had to be ignored.

        A lens calibrated at another aspect ratio says nothing about this
        frame's crop, so the uncalibrated field of view takes over.
        """
        if self.lens is not None:
            scaled = self.lens.camera().scaled_to(frame_w, frame_h)
            if scaled is not None:
                return scaled, False
            return CameraModel.from_hfov(frame_w, frame_h, self.hfov_deg), True
        return CameraModel.from_hfov(frame_w, frame_h, self.hfov_deg), False


class MirrorSettingsUpdate(msgspec.Struct, kw_only=True):
    """Settings to change; omitted fields keep their value.

    `lens: null` and `rig: null` drop the calibration.
    """

    mode: Literal["direct", "reflection"] | UnsetType = UNSET
    fit: Literal["contain", "cover"] | UnsetType = UNSET
    mirror: bool | UnsetType = UNSET
    face_mesh: bool | UnsetType = UNSET
    width: float | UnsetType = UNSET
    height: float | UnsetType = UNSET
    hfov_deg: float | UnsetType = UNSET
    default_distance_mm: float | UnsetType = UNSET
    zoom: float | UnsetType = UNSET
    lens: LensProfile | UnsetType | None = UNSET
    rig: RigProfile | UnsetType | None = UNSET
    ipd_mm: Ipd | UnsetType = UNSET
    trim_px: TrimPx | UnsetType = UNSET


class MirroredPayload(msgspec.Struct, kw_only=True):
    """Landmarks as `[x, y, depth_mm, visibility]`.

    `mirrored_data` is canvas pixels, with `(-1, -1)` where the projection has
    no answer. `depth_mm` is the distance in front of the mirror; direct mode
    reports 0. A row with no answer reads `-1` in all three, because a depth
    that is not a number cannot travel as one.

    `projected_data` carries the same rows as canvas-centered screen
    millimeters, before `trim_px`.
    """

    body_pose: list[Landmark]
    right_hand_pose: list[Landmark]
    left_hand_pose: list[Landmark]
    face_mesh: list[Landmark]
    body_world_pose: list[Landmark]
    ts: EpochMs
    capture_ts: CaptureMs | None = None
    latency_ms: Annotated[
        float | None, Meta(description="Milliseconds from capture to this payload.")
    ] = None


class ScaleCues(msgspec.Struct, kw_only=True):
    """Each size cue's median over its window, null while it has too few frames."""

    eyes: Annotated[float | None, Meta(description="From the pupil spacing assumed in `ipd_mm`.")]
    iris: Annotated[
        float | None,
        Meta(
            description="From the apparent size of the irises, at the diameter the rig profile "
            "says to assume. Null when no iris is large enough in the image to read."
        ),
    ]
    floor: Annotated[
        float | None, Meta(description="From the visible feet standing on the known floor.")
    ]


class ViewerPayload(msgspec.Struct, kw_only=True):
    """Who the projection thinks is standing there. Diagnostics for the calibration wizard."""

    left_eye_mm: Annotated[
        list[float] | None, Meta(description="Viewer's left pupil in camera millimeters.")
    ]
    right_eye_mm: list[float] | None
    eye_source: Literal["face", "body", "none"]
    body_scale: Annotated[
        float, Meta(description="This visitor's size against MediaPipe's average body.")
    ]
    scale_cues: ScaleCues
    distance_mm: Annotated[
        float | None, Meta(description="Eye midpoint in front of the mirror, in millimeters.")
    ]
    capture_ts: CaptureMs | None
    ts: EpochMs


@dataclass
class _Session:
    """One visitor's state on the rig path. Touched only from `on_data`.

    An action that has to clear it bumps the driver's generation counter under
    the lock instead, and `on_data` notices on its next frame.
    """

    eyes: OneEuro = field(default_factory=lambda: OneEuro(*VIEWER_SMOOTHING))
    translation_filter: OneEuro = field(default_factory=lambda: OneEuro(*VIEWER_SMOOTHING))
    scale: placement.SessionScale = field(default_factory=placement.SessionScale)
    translation: Array | None = None
    translation_ms: float = 0.0
    last_frame_ms: float | None = None
    last_eye_mid: Array | None = None

    def restart(self) -> None:
        """Begin the next visitor: their size and their position are their own."""
        self.eyes = OneEuro(*VIEWER_SMOOTHING)
        self.translation_filter = OneEuro(*VIEWER_SMOOTHING)
        self.scale.reset()
        self.translation = None
        self.last_eye_mid = None


class PoseToMirrorDriver(BaseDriver):
    """Maps MediaPipe landmarks onto an augmented mirror (webcam-only)."""

    name = "pose_to_mirror"
    description = "Map MediaPipe landmarks onto an augmented mirror (webcam-only)."
    events: ClassVar[Mapping[str, Event]] = {
        "mirrored_data": Event(MirroredPayload, "Landmarks in screen pixels, smoothed."),
        "projected_data": Event(
            MirroredPayload, "Reflection mode only: landmarks in millimeters, before smoothing."
        ),
        "viewer": Event(ViewerPayload, "Reflection mode only: the viewer the projection assumes."),
    }
    stream_events = ("mirrored_data", "projected_data", "viewer")
    dependencies = ("pose",)
    subscribed = (("pose", "raw_data"),)
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._lock = threading.Lock()
        self._settings = MirrorSettings()
        # Bumped under the lock when an action invalidates the per-frame state.
        self._generation = 0
        self._generation_seen = 0
        self._filters = _output_filters()
        self._session = _Session()
        self._lens_warned: set[tuple[float, float]] = set()
        self._rig_warned = False

    @action("Change settings and return all of them.")
    def set_mirror_config(self, params: MirrorSettingsUpdate | None) -> MirrorSettings:
        with self._lock:
            if params is not None:
                changes = {
                    field: value
                    for field in params.__struct_fields__
                    if (value := getattr(params, field)) is not UNSET
                }
                previous = self._settings
                self._settings = msgspec.structs.replace(previous, **changes)
                # A different path or canvas makes the filtered pixels
                # meaningless, and a different pupil spacing makes the visitor's
                # size, which was estimated through it, meaningless too.
                if any(
                    getattr(previous, name) != getattr(self._settings, name)
                    for name in ("mode", "rig", "lens", "width", "height", "ipd_mm")
                ):
                    self._generation += 1
            return self._settings

    @action("Forget the viewer's body scale and smoothing state.")
    def reset_viewer(self) -> None:
        with self._lock:
            self._generation += 1

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        body_raw = data.get("body_pose")
        if not isinstance(body_raw, list) or not body_raw:
            return
        frame_w = float(data.get("frame_width") or 1280.0)
        frame_h = float(data.get("frame_height") or 720.0)
        body_world = data.get("body_world_pose") or []
        with self._lock:
            settings = self._settings
            generation = self._generation
        capture_ts = data.get("capture_ts")
        capture_ts = float(capture_ts) if isinstance(capture_ts, int | float) else None
        # Filters follow the camera's own clock, so a late or duplicated frame
        # changes the smoothing instead of the lag.
        t_ms = capture_ts if capture_ts is not None else float(data.get("ts") or now_ms())
        self._start_frame(generation, t_ms)

        face_raw = (data.get("_face_mesh") or data.get("face_mesh")) if settings.face_mesh else None
        parts = {
            "body_pose": _landmarks(body_raw),
            "right_hand_pose": _landmarks(data.get("right_hand_pose")),
            "left_hand_pose": _landmarks(data.get("left_hand_pose")),
            "face_mesh": _landmarks(face_raw),
        }
        if settings.mode == "direct":
            pixels = self._direct(settings, parts, frame_w, frame_h)
        elif settings.rig is not None:
            pixels, projected, viewer = self._project_rig(
                settings, settings.rig, data, parts, frame_w, frame_h, t_ms
            )
            viewer["capture_ts"] = capture_ts
            viewer["ts"] = now_ms()
            self.emit("projected_data", _payload(projected, body_world, capture_ts))
            self.emit("viewer", viewer)
        else:
            self._warn_missing_rig()
            pixels = _invalid(parts)
            self.emit("projected_data", _payload(pixels, body_world, capture_ts))
        self.emit("mirrored_data", _payload(self._smooth(pixels, t_ms), body_world, capture_ts))

    def _start_frame(self, generation: int, t_ms: float) -> None:
        """Drop state an action invalidated, or that belongs to a viewer who left."""
        if generation != self._generation_seen:
            self._generation_seen = generation
            self._filters = _output_filters()
            self._session = _Session()
            # New settings deserve their own warnings, even at the same frame size.
            self._lens_warned.clear()
            self._rig_warned = False
        elif (
            self._session.last_frame_ms is not None
            and t_ms - self._session.last_frame_ms > SESSION_GAP_MS
        ):
            self._session.restart()
        self._session.last_frame_ms = t_ms

    def _warn_missing_rig(self) -> None:
        if not self._rig_warned:
            self._rig_warned = True
            self.log(
                "warn",
                "reflection mode has no rig profile, so nothing can be projected; "
                "run the mirror calibration and send its rig to set_mirror_config",
            )

    def _direct(
        self, settings: MirrorSettings, parts: dict[str, Array], frame_w: float, frame_h: float
    ) -> dict[str, Array]:
        """Fit the camera frame to the canvas, keeping the aspect ratio."""
        width_ratio = settings.width / max(frame_w, 1.0)
        height_ratio = settings.height / max(frame_h, 1.0)
        ratio = (
            max(width_ratio, height_ratio)
            if settings.fit == "cover"
            else min(width_ratio, height_ratio)
        )
        scale = ratio * max(settings.zoom, 0.1)
        sx, sy = frame_w * scale, frame_h * scale
        ox, oy = (settings.width - sx) / 2.0, (settings.height - sy) / 2.0
        out: dict[str, Array] = {}
        for name, points in parts.items():
            nx = points[:, 0] / frame_w
            if settings.mirror:
                nx = 1.0 - nx
            visibility = np.where(np.isnan(points[:, 2]), 1.0, points[:, 2])
            out[name] = np.column_stack(
                [nx * sx + ox, points[:, 1] / frame_h * sy + oy, np.zeros(len(points)), visibility]
            )
        return out

    def _project_rig(
        self,
        settings: MirrorSettings,
        profile: RigProfile,
        data: Mapping[str, Any],
        parts: dict[str, Array],
        frame_w: float,
        frame_h: float,
        t_ms: float,
    ) -> tuple[dict[str, Array], dict[str, Array], dict[str, Any]]:
        """Place the landmarks in camera millimeters, then draw them for the viewer's eye.

        Returns canvas pixels, canvas-centered screen millimeters and the
        `viewer` payload. Everything here runs in unflipped camera coordinates,
        so a mirrored frame is mapped back before any geometry.
        """
        rig = profile.rig()
        camera = self._camera(settings, frame_w, frame_h)
        flipped = bool(data.get("flipped"))

        def rays(part: Array) -> Array:
            uv = part[:, :2]
            return camera.normalize(unflip(uv, frame_w) if flipped else uv)

        body_rays = rays(parts["body_pose"])
        world_mm = _landmarks(data.get("body_world_pose") or [])[:, :3] * 1000.0
        if flipped and len(world_mm):
            world_mm[:, 0] = -world_mm[:, 0]
        visibility = _visible_in_frame(parts["body_pose"], frame_w, frame_h)

        face = _face_shape(data.get("_face_xyz"), camera, frame_w, flipped)
        # The head at the assumed spacing. The size cue has to read it there,
        # not at the spacing the session already derived, or it feeds on itself.
        assumed_eyes = None if face is None else placement.locate_eyes(*face, settings.ipd_mm)
        session = self._session
        if _swapped(session.last_eye_mid, assumed_eyes):
            session.restart()
        session.last_eye_mid = None if assumed_eyes is None else assumed_eyes.midpoint

        # The irises measure this person rather than assuming them, and they are
        # there whenever the face is. `profile.iris_mm` is what this camera's
        # landmark model reads a generic iris as, from the rig calibration.
        iris_depth_mm = (
            None if face is None else placement.iris_depth(face[0], camera.fx, profile.iris_mm)
        )
        scale = self._body_scale(
            profile, body_rays, world_mm, visibility, assumed_eyes, iris_depth_mm
        )
        # The head belongs to the body: placing it at the spacing the fused
        # scale implies keeps the two from drifting apart.
        head_ipd = settings.ipd_mm * session.scale.head_factor
        translation = self._translation(settings, body_rays, world_mm, visibility, scale, t_ms)
        body = placement.place_body(body_rays, world_mm, translation, scale)

        eyes = None if face is None else placement.locate_eyes(*face, head_ipd)
        source = "face"
        if eyes is None:
            eyes, source = _body_eyes(body), "body"
        cues = {name: session.scale.cue(name) for name in ("eyes", "iris", "floor")}
        if eyes is None:
            return (
                _invalid(parts),
                _invalid(parts),
                _viewer_payload(None, "none", scale, cues, None),
            )
        smoothed = session.eyes(np.stack([eyes.left, eyes.right]), t_ms)
        eyes = placement.Eyes(left=smoothed[0], right=smoothed[1])
        # A flat display can register with one eye at a time; in a public space
        # nobody picks one, so the midpoint is everybody's compromise.
        viewpoint = eyes.midpoint
        eye_depth = float(viewpoint[2])
        trim = np.asarray(settings.trim_px, dtype=np.float64)

        def hand(name: str, anchor: int, key: str) -> tuple[Array, Array]:
            part = parts[name]
            wrist = body[anchor] if anchor < len(body) else None
            depth = float(wrist[2]) if wrist is not None and np.isfinite(wrist[2]) else eye_depth
            hand_mm = _hand_world_mm(data.get(key), flipped)
            seen = float(visibility[anchor]) if anchor < len(visibility) else np.nan
            return placement.place_hand(rays(part), hand_mm, depth, scale), _seen(part, seen)

        def project(points: Array, seen: Array) -> tuple[Array, Array]:
            mm = mirror_rig.project_mm(rig, viewpoint, points)
            pixels = mirror_rig.mm_to_pixels(rig, mm, settings.width, settings.height) + trim
            depth = mirror_rig.mirror_distance(rig, points)
            invalid = ~np.isfinite(pixels).all(axis=-1)
            pixels[invalid] = -1.0
            mm[invalid] = -1.0
            # A NaN depth would reach the wire as JSON null, which the payload's
            # rows of plain numbers do not allow; it is meaningless here anyway.
            depth[invalid] = -1.0
            return np.column_stack([pixels, depth, seen]), np.column_stack([mm, depth, seen])

        placed = {
            "body_pose": (body, _seen(parts["body_pose"], np.nan)),
            "right_hand_pose": hand("right_hand_pose", RIGHT_HAND_ANCHOR, "_right_hand_world"),
            "left_hand_pose": hand("left_hand_pose", LEFT_HAND_ANCHOR, "_left_hand_world"),
            "face_mesh": self._face_part(settings, parts, face, head_ipd, body, eye_depth, rays),
        }
        pixels, projected = {}, {}
        for name, (points, seen) in placed.items():
            pixels[name], projected[name] = project(points, seen)
        distance = float(mirror_rig.mirror_distance(rig, viewpoint))
        return pixels, projected, _viewer_payload(eyes, source, scale, cues, distance)

    def _camera(self, settings: MirrorSettings, frame_w: float, frame_h: float) -> CameraModel:
        """The frame's camera model, warning once per frame size about an unusable lens."""
        camera, mismatch = settings.camera(frame_w, frame_h)
        lens = settings.lens
        if mismatch and lens is not None and (frame_w, frame_h) not in self._lens_warned:
            self._lens_warned.add((frame_w, frame_h))
            self.log(
                "warn",
                f"lens profile covers {lens.width:.0f}x{lens.height:.0f}, a different aspect "
                f"ratio than this {frame_w:.0f}x{frame_h:.0f} frame; falling back to hfov_deg",
            )
        return camera

    def _body_scale(
        self,
        profile: RigProfile,
        rays: Array,
        world_mm: Array,
        visibility: Array,
        eyes: placement.Eyes | None,
        iris_depth_mm: float | None,
    ) -> float:
        """This visitor's size, from the head, the irises and the feet, fused for the session.

        Nobody in a public space is measured beforehand, so every cue runs on
        every frame and `SessionScale` keeps a sliding median of each. Only the
        face may give the head's depth: taking it from the body's own eyes
        would divide the estimate by itself. The pupil spacing and the irises
        both place the head, so each is turned into a body size the same way,
        and only the depth they hand over differs.
        """
        scale = self._session.scale
        if eyes is not None:
            scale.add(
                "eyes",
                placement.body_scale_from_eyes(rays, world_mm, visibility, float(eyes.midpoint[2])),
            )
        if iris_depth_mm is not None:
            scale.add(
                "iris",
                placement.body_scale_from_eyes(rays, world_mm, visibility, iris_depth_mm),
            )
        floor = profile.floor()
        if floor is not None:
            down, camera_height_mm = floor
            scale.add(
                "floor",
                placement.body_scale_from_floor(rays, world_mm, visibility, down, camera_height_mm),
            )
        return scale.value

    def _translation(
        self,
        settings: MirrorSettings,
        rays: Array,
        world_mm: Array,
        visibility: Array,
        scale: float,
        t_ms: float,
    ) -> Array:
        """Smoothed camera position of the mid-hips, holding the last good fit over a gap."""
        session = self._session
        fitted = placement.fit_translation(rays, world_mm, visibility, scale)
        held = session.translation
        if fitted is not None:
            session.translation, session.translation_ms = fitted, t_ms
        elif held is not None and t_ms - session.translation_ms <= TRANSLATION_HOLD_MS:
            fitted = held
        else:
            fitted = _default_translation(rays, settings.default_distance_mm)
        return session.translation_filter(fitted, t_ms)

    def _face_part(
        self,
        settings: MirrorSettings,
        parts: dict[str, Array],
        face: tuple[Array, Array] | None,
        head_ipd_mm: float,
        body: Array,
        eye_depth: float,
        rays: Callable[[Array], Array],
    ) -> tuple[Array, Array]:
        """The face mesh in camera millimeters, from its own depths when it has them."""
        if not settings.face_mesh:
            return np.empty((0, 3)), np.empty(0)
        depth = None if face is None else placement.face_depth(*face, head_ipd_mm)
        if face is not None and depth is not None:
            # The mesh carries no visibility of its own; it exists or it does not.
            return placement.place_face(*face, depth), np.ones(len(face[0]))
        mesh = parts["face_mesh"]
        anchor = body[FACE_ANCHOR] if len(body) > FACE_ANCHOR else None
        flat = float(anchor[2]) if anchor is not None and np.isfinite(anchor[2]) else eye_depth
        return _flat(rays(mesh), flat), _seen(mesh, np.nan)

    def _smooth(self, parts: dict[str, Array], t_ms: float) -> dict[str, Array]:
        """Filter every part's pixels, leaving depth and visibility alone.

        Invalid points go into the filter as NaN, so they neither drag the
        valid ones nor get approached from the last place they were seen.
        """
        out: dict[str, Array] = {}
        for name, points in parts.items():
            invalid = ((points[:, 0] == -1.0) & (points[:, 1] == -1.0))[:, None]
            smoothed = self._filters[name](np.where(invalid, np.nan, points[:, :2]), t_ms)
            out[name] = np.column_stack([np.where(invalid, -1.0, smoothed), points[:, 2:]])
        return out


def _output_filters() -> dict[str, OneEuro]:
    return {name: OneEuro(*SMOOTHING[name]) for name in PARTS}


def _landmarks(points: Any, columns: int = 3) -> Array:
    """Rows of landmark values as a (len, columns) array, NaN where missing."""
    rows = points if isinstance(points, Sequence) else []
    out = np.full((len(rows), columns), np.nan)
    for i, row in enumerate(rows):
        if isinstance(row, Sequence):
            values = [float(v) for v in row[:columns]]
            out[i, : len(values)] = values
    return out


def _visible_in_frame(part: Array, frame_w: float, frame_h: float) -> Array:
    """Visibility of the body landmarks, zeroed for anything outside the frame."""
    margin_x, margin_y = FRAME_MARGIN * frame_w, FRAME_MARGIN * frame_h
    u, v = part[:, 0], part[:, 1]
    inside = (
        (u >= margin_x) & (u <= frame_w - margin_x) & (v >= margin_y) & (v <= frame_h - margin_y)
    )
    return np.where(inside, part[:, 2], 0.0)


def _swapped(previous: Array | None, eyes: placement.Eyes | None) -> bool:
    """Whether the head jumped far enough between two frames to be another person."""
    if previous is None or eyes is None:
        return False
    return bool(np.linalg.norm(eyes.midpoint - previous) > SWAP_JUMP_MM)


def _face_shape(
    face_xyz: Any, camera: CameraModel, frame_w: float, flipped: bool
) -> tuple[Array, Array] | None:
    """Face-mesh rays and relative depths, or None when this frame has no face.

    MediaPipe's face `z` shares the scale of its pixel `x`, so dividing by the
    focal length makes `1 + rel_z` each landmark's depth relative to the mesh's
    own reference. Mirroring the frame moves `x` and leaves `z` alone.
    """
    if face_xyz is None:
        return None
    xyz = np.asarray(face_xyz, dtype=np.float64)
    if xyz.ndim != 2 or len(xyz) == 0 or xyz.shape[1] < 3:
        return None
    uv = unflip(xyz[:, :2], frame_w) if flipped else xyz[:, :2]
    return camera.normalize(uv), xyz[:, 2] / camera.fx


def _hand_world_mm(world: Any, flipped: bool) -> Array | None:
    """(21, 3) hand landmarks in millimeters, in the camera's own orientation."""
    if world is None:
        return None
    rows = np.asarray(world, dtype=np.float64)
    if rows.ndim != 2 or rows.shape[1] < 3:
        return None
    millimeters = rows[:, :3] * 1000.0
    if flipped:
        millimeters[:, 0] = -millimeters[:, 0]
    return millimeters


def _body_eyes(body: Array) -> placement.Eyes | None:
    """The body model's eyes as a fallback viewpoint, told apart by their camera x."""
    if len(body) <= max(placement.BODY_LEFT_EYE, placement.BODY_RIGHT_EYE):
        return None
    a, b = body[placement.BODY_LEFT_EYE], body[placement.BODY_RIGHT_EYE]
    if not (np.isfinite(a).all() and np.isfinite(b).all()):
        return None
    # The camera faces the viewer, so the viewer's left eye is at larger x.
    return placement.Eyes(left=a, right=b) if a[0] > b[0] else placement.Eyes(left=b, right=a)


def _default_translation(rays: Array, distance_mm: float) -> Array:
    """Hips at the default distance along the mid-shoulder ray: the last resort."""
    ray = np.zeros(2)
    if len(rays) > max(SHOULDERS):
        mid = rays[list(SHOULDERS)].mean(axis=0)
        ray = mid if np.isfinite(mid).all() else ray
    return np.array([ray[0] * distance_mm, ray[1] * distance_mm, distance_mm])


def _flat(rays: Array, depth_mm: float) -> Array:
    """Landmarks on a single depth plane, each along its own observed ray."""
    depth = np.full(len(rays), max(depth_mm, placement.MIN_DEPTH_MM))
    return np.column_stack([rays[:, 0] * depth, rays[:, 1] * depth, depth])


def _seen(part: Array, anchor: float) -> Array:
    """Visibility column of a part: the anchor's when it has one."""
    if np.isfinite(anchor):
        return np.full(len(part), anchor)
    return np.where(np.isnan(part[:, 2]), 1.0, part[:, 2])


def _invalid(parts: dict[str, Array]) -> dict[str, Array]:
    """Every landmark marked invalid, keeping the row counts the payload promises."""
    return {
        name: np.column_stack([np.full((len(part), 3), -1.0), _seen(part, np.nan)])
        for name, part in parts.items()
    }


def _viewer_payload(
    eyes: placement.Eyes | None,
    source: str,
    scale: float,
    cues: Mapping[str, float | None],
    distance_mm: float | None,
) -> dict[str, Any]:
    """The diagnostics of one frame. The caller adds `capture_ts` and `ts`."""
    return {
        "left_eye_mm": None if eyes is None else _rounded(eyes.left),
        "right_eye_mm": None if eyes is None else _rounded(eyes.right),
        "eye_source": source,
        "body_scale": round(scale, 4),
        "scale_cues": {
            name: None if value is None else round(value, 4) for name, value in cues.items()
        },
        "distance_mm": None if distance_mm is None else round(distance_mm, 1),
    }


def _rounded(point: Array) -> list[float]:
    return [round(float(v), 1) for v in point]


def _payload(parts: dict[str, Array], body_world: Any, capture_ts: float | None) -> dict[str, Any]:
    payload: dict[str, Any] = {name: parts[name].tolist() for name in PARTS}
    payload["body_world_pose"] = body_world
    payload["ts"] = now_ms()
    payload["capture_ts"] = capture_ts
    payload["latency_ms"] = None if capture_ts is None else latency_ms(capture_ts)
    return payload
