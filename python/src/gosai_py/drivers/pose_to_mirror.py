"""Pose-to-mirror driver (webcam-only).

Projects MediaPipe body/hand/face landmarks onto an augmented mirror so that the
on-screen skeleton lines up with the user's reflection, then maps the result
into the mirror's pixel space.

This is a faithful, webcam-only re-implementation of the legacy `pose_to_mirror`
driver. The legacy version required an Intel RealSense depth camera to recover a
per-pixel distance and deproject pixels into 3D. We remove that hardware
dependency by using the metric 3D that MediaPipe Holistic already produces
(`body_world_pose`, in meters) and a plain pinhole camera model:

- The legacy RealSense intrinsics used zero distortion coefficients, so
  `rs2_deproject_pixel_to_point` reduces to the exact pinhole formula used here
  (`x = (u - ppx) / fx * depth`). The projection math is therefore numerically
  identical to the legacy path; only the depth source changed.
- Absolute camera distance is recovered with a weak-perspective estimate from
  shoulder span (metric size from `body_world_pose` vs. pixel size from
  `body_pose`). Per-joint depth offsets come from `body_world_pose.z`.
- Hands and face are anchored to the relevant body joint's depth (the legacy
  `ref` trick), so no per-finger/per-face depth sensing is needed.

Emitted events:

- ``mirrored_data`` - landmarks mapped into mirror pixel space (1080x1920 by
  default) with temporal smoothing. Shape matches the legacy payload:
  ``{ body_pose, right_hand_pose, left_hand_pose, face_mesh, body_world_pose,
  ts }``. Each landmark is ``[x, y, depth_mm, visibility]``.
- ``projected_data`` - the same landmarks reflected onto the mirror plane but
  still in millimeters (pre pixel-mapping). Useful for debugging/calibration.

Two modes (selected via ``set_mirror_config`` ``{"mode": ...}``):

- ``direct`` (default) - a webcam selfie overlay. No mirror hardware: landmarks
  are normalized by the camera frame, mirrored horizontally, and "cover"-fit to
  the portrait canvas. Works on any laptop/webcam with no calibration.
- ``reflection`` - the calibrated projection for the physical augmented-mirror
  rig (uses the screen size / offsets / tilt / distance in ``DEFAULT_CONFIG``).

Actions:

- ``set_mirror_config`` - merge a partial config dict (see ``DEFAULT_CONFIG``)
  and/or switch ``mode`` (``"direct"`` | ``"reflection"``).
"""

from __future__ import annotations

import math
import time
from typing import Any, ClassVar

from gosai_py.driver import DriverContext
from gosai_py.processor import BaseProcessor

# MediaPipe pose landmark indices used as anchors (match the legacy driver).
NOSE = 0
FACE_ANCHOR = 2  # left-eye landmark; face mesh is anchored to its depth.
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
RIGHT_HAND_ANCHOR = 15  # left wrist (legacy swaps handedness upstream).
LEFT_HAND_ANCHOR = 16  # right wrist.

# Parts that get reflected + pixel-mapped. Other keys pass through untouched.
PARTS: tuple[str, ...] = ("body_pose", "right_hand_pose", "left_hand_pose", "face_mesh")

# Per-part temporal smoothing factor (lerp toward the new value). Matches legacy.
INTER_RATES: dict[str, float] = {
    "body_pose": 0.4,
    "right_hand_pose": 0.6,
    "left_hand_pose": 0.6,
    "face_mesh": 0.6,
}

# Defaults taken from the legacy second-self config.json + mirror.py. Distances
# are in millimeters; the screen is portrait 1080x1920.
DEFAULT_CONFIG: dict[str, float] = {
    "x_offset": -230.0,  # mm; increase to move the skeleton left.
    "y_offset": 100.0,  # mm; increase to move it down.
    "screen_width_mm": 392.85,
    "screen_height_mm": 698.4,
    "width": 1080.0,
    "height": 1920.0,
    "tilt_deg": 17.0,  # camera tilt; rotates the y-z plane.
    "hfov_deg": 60.0,  # used to derive focal length from frame width.
    "scale": 1.0,  # multiplies the estimated distance (per-install tuning).
    "default_distance_mm": 1500.0,  # fallback subject distance.
    "zoom": 1.0,  # direct mode: >1 crops in for a fuller portrait fill.
}


def _lerp(a: float, b: float, t: float) -> float:
    return (1.0 - t) * a + t * b


def _deproject(u: float, v: float, depth: float, fx: float, fy: float, ppx: float, ppy: float) -> tuple[float, float, float]:
    """Pinhole back-projection (matches RealSense deproject with zero distortion)."""
    x = (u - ppx) / fx * depth
    y = (v - ppy) / fy * depth
    return x, y, depth


def _map_location(
    point: list[float],
    eyes_depth: float,
    eyes_coords: tuple[float, float, float],
    point_depth: float,
    fx: float,
    fy: float,
    ppx: float,
    ppy: float,
    theta: float,
) -> list[float]:
    """Reflect a single point onto the mirror plane (legacy ``map_location``).

    Finds where the line from the eye to the point's mirror image crosses the
    mirror (the reflection the user sees), weighted by ``da / (da + db)``.
    """
    da = eyes_depth
    db = point_depth
    xa, ya, za = eyes_coords
    xb, yb, zb = _deproject(point[0], point[1], db, fx, fy, ppx, ppy)

    ya = ya * math.cos(theta) + za * math.sin(theta)
    yb = yb * math.cos(theta) + zb * math.sin(theta)

    dz = db + da
    if dz != 0:
        xi = xa + (da / dz) * (xb - xa)
        yi = ya + (da / dz) * (yb - ya)
        if not math.isnan(xi) and not math.isnan(yi):
            return [xi, yi]
    return [-1.0, -1.0]


class PoseToMirrorDriver(BaseProcessor):
    """Reflects MediaPipe landmarks onto an augmented mirror (webcam-only)."""

    name: ClassVar[str] = "pose_to_mirror"
    description: ClassVar[str] = "Reflect MediaPipe landmarks onto an augmented mirror (webcam-only)."
    events: ClassVar[tuple[str, ...]] = ("mirrored_data", "projected_data")
    actions: ClassVar[tuple[str, ...]] = ("set_mirror_config",)
    dependencies: ClassVar[tuple[str, ...]] = ("pose",)
    subscribed: ClassVar[tuple[tuple[str, str], ...]] = (("pose", "raw_data"),)
    loop_interval_s: ClassVar[float | None] = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._config: dict[str, float] = dict(DEFAULT_CONFIG)
        # "direct"  -> webcam selfie overlay (no mirror hardware; default).
        # "reflection" -> calibrated projection for the physical mirror rig.
        self._mode: str = "direct"
        # Direct-mode knobs.
        self._mirror_flip: bool = True  # horizontal flip (selfie view).
        self._fit: str = "contain"  # "contain" (letterbox) | "cover" (fill+crop).
        self._mirrored: dict[str, Any] = {}

    def execute(self, action: str, data: Any) -> Any:
        if action == "set_mirror_config":
            if isinstance(data, dict):
                mode = data.get("mode")
                if isinstance(mode, str) and mode in ("direct", "reflection"):
                    self._mode = mode
                fit = data.get("fit")
                if isinstance(fit, str) and fit in ("contain", "cover"):
                    self._fit = fit
                if "mirror" in data:
                    self._mirror_flip = bool(data["mirror"])
                for key, value in data.items():
                    if key in self._config:
                        try:
                            self._config[key] = float(value)
                        except (TypeError, ValueError):
                            self.log("warn", f"set_mirror_config: bad value for {key!r}")
            return {"mode": self._mode, "fit": self._fit, "mirror": self._mirror_flip, **self._config}
        return super().execute(action, data)

    # ------------------------------------------------------------------

    def _intrinsics(self, frame_w: float, frame_h: float) -> tuple[float, float, float, float]:
        """Derive pinhole intrinsics from the frame size and horizontal FOV."""
        hfov = math.radians(self._config["hfov_deg"])
        fx = (frame_w / 2.0) / max(math.tan(hfov / 2.0), 1e-6)
        fy = fx  # assume square pixels.
        return fx, fy, frame_w / 2.0, frame_h / 2.0

    def _estimate_distance(
        self,
        body_pose: list[list[float]],
        body_world: list[list[float]],
        fx: float,
    ) -> float:
        """Weak-perspective distance (mm) from shoulder span; fallback to default."""
        default = self._config["default_distance_mm"]
        if len(body_pose) <= RIGHT_SHOULDER or len(body_world) <= RIGHT_SHOULDER:
            return default
        try:
            lp, rp = body_pose[LEFT_SHOULDER], body_pose[RIGHT_SHOULDER]
            lw, rw = body_world[LEFT_SHOULDER], body_world[RIGHT_SHOULDER]
            px = math.hypot(lp[0] - rp[0], lp[1] - rp[1])
            meters = math.hypot(lw[0] - rw[0], lw[1] - rw[1])
            if px > 1.0 and meters > 0.05:
                return fx * (meters * 1000.0) / px * self._config["scale"]
        except (IndexError, TypeError):
            pass
        return default

    def _project(
        self,
        points: list[list[float]],
        depths: list[float] | None,
        eyes_depth: float,
        eyes_coords: tuple[float, float, float],
        fx: float,
        fy: float,
        ppx: float,
        ppy: float,
        theta: float,
        ref: list[float] | None = None,
    ) -> list[list[float]]:
        projected: list[list[float]] = []
        for i, point in enumerate(points):
            if not point:
                projected.append([])
                continue
            if ref is None:
                visibility = point[2] if len(point) > 2 else 1.0
                point_depth = depths[i] if depths is not None and i < len(depths) else eyes_depth
            else:
                visibility = ref[3] if len(ref) > 3 else 1.0
                point_depth = ref[2] if len(ref) > 2 else eyes_depth
            loc = _map_location(point[:2], eyes_depth, eyes_coords, point_depth, fx, fy, ppx, ppy, theta)
            projected.append([loc[0], loc[1], point_depth, visibility])
        return projected

    def _smooth(self, name: str, points: list[list[float]]) -> list[list[float]]:
        """Temporally lerp pixel-space points toward the previous frame."""
        old = self._mirrored.get(name)
        t = INTER_RATES.get(name, 1.0)
        if not (isinstance(old, list) and len(old) == len(points) and t < 1.0):
            old = None
        out: list[list[float]] = []
        for i, point in enumerate(points):
            if not point:
                out.append([])
                continue
            x, y = point[0], point[1]
            if old is not None and old[i]:
                rate = t if y > 0 else 0.01
                x = _lerp(old[i][0], x, rate)
                y = _lerp(old[i][1], y, rate)
            out.append([x, y, *point[2:]])
        return out

    def _mirror_part(self, name: str, points: list[list[float]]) -> list[list[float]]:
        """Map reflected millimeters into mirror pixel space, then smooth."""
        cfg = self._config
        mapped: list[list[float]] = []
        for point in points:
            if not point:
                mapped.append([])
                continue
            x = cfg["width"] * (point[0] - cfg["x_offset"]) / cfg["screen_width_mm"]
            y = cfg["height"] * (point[1] - cfg["y_offset"]) / cfg["screen_height_mm"]
            mapped.append([x, y, *point[2:]])
        return self._smooth(name, mapped)

    def _direct_part(
        self,
        name: str,
        points: list[list[float]],
        sx: float,
        sy: float,
        ox: float,
        oy: float,
        frame_w: float,
        frame_h: float,
    ) -> list[list[float]]:
        """Map camera-frame pixels to a mirrored, aspect-correct portrait fill."""
        mapped: list[list[float]] = []
        for point in points:
            if not point:
                mapped.append([])
                continue
            nx = point[0] / frame_w
            ny = point[1] / frame_h
            if self._mirror_flip:
                nx = 1.0 - nx  # horizontal mirror (selfie view).
            x = nx * sx + ox
            y = ny * sy + oy
            vis = point[2] if len(point) > 2 else 1.0
            mapped.append([x, y, 0.0, vis])
        return self._smooth(name, mapped)

    def _project_direct(
        self,
        frame_w: float,
        frame_h: float,
        body_pose: list[list[float]],
        body_world: list[list[float]],
        face_mesh: list[list[float]],
        right_hand: list[list[float]],
        left_hand: list[list[float]],
    ) -> None:
        """Webcam selfie overlay: aspect-correct fit of the camera to the canvas.

        ``fit='contain'`` (default) shows the whole camera frame (letterboxed if
        aspect ratios differ); ``fit='cover'`` fills the canvas and crops the
        overflow. ``zoom`` (>1) crops in further, ``mirror`` flips horizontally
        for a selfie view. The user's movements map 1:1.
        """
        cfg = self._config
        out_w, out_h = cfg["width"], cfg["height"]
        zoom = max(cfg.get("zoom", 1.0), 0.1)
        wr = out_w / max(frame_w, 1.0)
        hr = out_h / max(frame_h, 1.0)
        ratio = max(wr, hr) if self._fit == "cover" else min(wr, hr)
        scale = ratio * zoom
        sx = frame_w * scale
        sy = frame_h * scale
        ox = (out_w - sx) / 2.0
        oy = (out_h - sy) / 2.0

        mirrored: dict[str, Any] = {}
        for name, pts in (
            ("body_pose", body_pose),
            ("right_hand_pose", right_hand),
            ("left_hand_pose", left_hand),
            ("face_mesh", face_mesh),
        ):
            mirrored[name] = self._direct_part(name, pts, sx, sy, ox, oy, frame_w, frame_h)
        mirrored["body_world_pose"] = body_world
        mirrored["ts"] = time.time()
        self._mirrored = mirrored
        self.emit("mirrored_data", mirrored)

    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        body_pose = data.get("body_pose") or []
        if not isinstance(body_pose, list) or not body_pose:
            return

        body_world = data.get("body_world_pose") or []
        face_mesh = data.get("face_mesh") or []
        right_hand = data.get("right_hand_pose") or []
        left_hand = data.get("left_hand_pose") or []

        # Actual camera frame size (reported by the pose driver). MediaPipe
        # landmark x/y are pixel coordinates in this frame.
        frame_w = float(data.get("frame_width") or 1280.0)
        frame_h = float(data.get("frame_height") or 720.0)

        if self._mode == "direct":
            self._project_direct(
                frame_w, frame_h, body_pose, body_world, face_mesh, right_hand, left_hand
            )
            return

        fx, fy, ppx, ppy = self._intrinsics(frame_w, frame_h)
        theta = math.radians(self._config["tilt_deg"])

        distance = self._estimate_distance(body_pose, body_world, fx)

        # Per-joint depth (mm): absolute distance plus the metric z offset from
        # MediaPipe world landmarks (origin at the hips, meters).
        def world_z_mm(i: int) -> float:
            if i < len(body_world) and body_world[i] and len(body_world[i]) > 2:
                return body_world[i][2] * 1000.0
            return 0.0

        body_depths = [max(distance + world_z_mm(i), 1.0) for i in range(len(body_pose))]

        eyes_depth = body_depths[NOSE] if len(body_depths) > NOSE else distance
        eyes_px = body_pose[NOSE][:2] if body_pose[NOSE] else [frame_w / 2.0, frame_h / 2.0]
        eyes_coords = _deproject(eyes_px[0], eyes_px[1], eyes_depth, fx, fy, ppx, ppy)

        projected: dict[str, Any] = {}
        projected["body_pose"] = self._project(
            body_pose, body_depths, eyes_depth, eyes_coords, fx, fy, ppx, ppy, theta
        )

        pbody = projected["body_pose"]

        def anchor(idx: int) -> list[float] | None:
            return pbody[idx] if idx < len(pbody) and pbody[idx] else None

        projected["right_hand_pose"] = self._project(
            right_hand, None, eyes_depth, eyes_coords, fx, fy, ppx, ppy, theta, ref=anchor(RIGHT_HAND_ANCHOR)
        )
        projected["left_hand_pose"] = self._project(
            left_hand, None, eyes_depth, eyes_coords, fx, fy, ppx, ppy, theta, ref=anchor(LEFT_HAND_ANCHOR)
        )
        projected["face_mesh"] = self._project(
            face_mesh, None, eyes_depth, eyes_coords, fx, fy, ppx, ppy, theta, ref=anchor(FACE_ANCHOR)
        )
        projected["body_world_pose"] = body_world
        projected["ts"] = time.time()
        self.emit("projected_data", projected)

        # Map the reflected millimeters into mirror pixel space, with smoothing.
        mirrored: dict[str, Any] = dict(projected)
        for part in PARTS:
            mirrored[part] = self._mirror_part(part, projected.get(part) or [])
        self._mirrored = mirrored
        self.emit("mirrored_data", mirrored)
