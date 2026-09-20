"""Guided calibration of the augmented mirror: first the lens, then the rig pose.

This driver serves steps 2 to 5 of the setup flow in
`docs/second-self-mirror-redesign.md`. It holds no storage: the app saves the
`LensProfile` and `RigProfile` it returns and hands them back to
`pose_to_mirror`.

Three stages, set with `set_stage`:

- `idle`: nothing is detected, so the driver costs nothing while the app is
  running its own experience.
- `lens`: the operator waves the printed ChArUco sheet around.
  `charuco.LensCalibrator` keeps the sharp, mutually different views and
  `solve_lens` turns them into camera intrinsics.
- `align`: the operator lines the reflection of the sheet's designated corner
  up with a target drawn on the screen, one eye closed, and confirms by
  calling `capture_alignment`. Stillness never confirms anything on its own:
  the app calls the action at the moment the operator says so, and the driver
  averages the short window that ended right then. An operator working alone,
  with the keyboard on another display, gets the same thing from a countdown:
  the app calls the action when its timer ends and the window is the moment
  before that, so no separate timed action is needed here.

The operator's own pupil spacing and open eye are settings of this driver
alone. `pose_to_mirror` serves the public and measures nobody, so the only
person-shaped number that crosses over is `camera_height_mm`, which belongs to
the rig: `solve_rig` carries it into the `RigProfile` it returns, so the app
stores one object.

The operator's measured pupil spacing also makes their eye depth metric, which
is the one chance to see what this camera's landmark model reads an iris as.
Every alignment keeps that reading, and `solve_rig` turns the median into the
rig's `iris_mm`, shrunk toward the population average because one operator's
own iris is mixed into it (`placement.calibrated_iris_mm`). It is a property of
the camera, not of the operator, which is why it travels with the rig.

Every camera frame outside `idle` is detected and reported as `board`, so the
app can draw the hull over the preview and tell the operator when the pose is
too ambiguous to use. Camera frames are never flipped (the flip lives in the
`pose` driver), so board geometry is already in the unflipped camera
coordinates `geometry.camera_model` describes. Face landmarks come from
`pose.raw_data`, which may be flipped, and are mapped back before use.

`solve_rig` judges the result by `predicted_error_mm`, not by the residuals: a
set of alignments taken at a single standing distance fits its own targets just
as well as a good set and still leaves the rig loosely constrained.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar, Literal

import msgspec
import numpy as np
from msgspec import UNSET, Meta, UnsetType
from numpy.typing import NDArray

from gosai_py.clock import now_ms
from gosai_py.driver import BaseDriver, DriverContext, Event, action
from gosai_py.frames import capture_timing
from gosai_py.geometry import charuco, mirror_rig, placement
from gosai_py.geometry.camera_model import CameraModel, unflip
from gosai_py.geometry.placement import GENERIC_IRIS_MM
from gosai_py.mirror_profiles import LensProfile, RigProfile, Vector3
from gosai_py.payloads import CaptureMs, EpochMs

type Array = NDArray[np.float64]

Stage = Literal["idle", "lens", "align"]
Quality = Literal["good", "fair", "poor"]
Hold = Literal["corner_up", "corner_down"]

# About two seconds of board poses and eye positions, enough for the longest
# confirmation window plus the delay between the capture and the action call.
HISTORY_MS = 2000.0
HISTORY_FRAMES = 120

# Confirmation window, ending at the moment the operator confirms.
DEFAULT_WINDOW_MS = 600.0
MIN_BOARD_SAMPLES = 5
MIN_EYE_SAMPLES = 5
# Worst per-axis standard deviation inside the window. The board is measured
# far better than the head, so it is held to a tighter number.
MAX_BOARD_SPREAD_MM = 6.0
MAX_EYE_SPREAD_MM = 8.0
# Above this, the planar pose's second solution would move the corner enough to
# poison the fit, so the operator has to tilt the board or come closer.
MAX_AMBIGUITY_MM = 15.0

# Quality bands for the one-sigma projection error the fit predicts for a
# standing viewer. Roughly: a fifth of a finger width, a finger width, worse.
GOOD_ERROR_MM = 15.0
FAIR_ERROR_MM = 30.0

# Standing distances closer than this count as the same one.
DISTANCE_BUCKET_MM = 150.0

# Below this many alignments carrying an iris reading, the median is one or two
# glances rather than a measurement, so the generic diameter stands.
MIN_IRIS_ALIGNMENTS = 4

# Target suggestions: the board is assumed held this far in front of the eye,
# and all of it must stay this far inside the frame (fraction of each side).
DEFAULT_REACH_MM = 350.0
FRAME_MARGIN = 0.04
MIN_BOARD_TO_MIRROR_MM = 200.0

Ipd = Annotated[
    float, Meta(ge=45.0, le=80.0, description="Interpupillary distance of the operator, in mm.")
]
CameraHeight = Annotated[float, Meta(gt=0)]
Pair = Annotated[list[float], Meta(min_length=2, max_length=2)]
TargetPx = Annotated[Pair, Meta(description="[x, y] of the target on the canvas, in pixels.")]
CanvasPx = Annotated[Pair, Meta(description="[width, height] of the canvas, in pixels.")]


class CalibrationSettings(msgspec.Struct, kw_only=True):
    """Every setting of the driver. Distances are millimeters.

    `ipd_mm` and `eye` describe the calibration operator, who is not a member
    of the public: they are given per run and never reach `pose_to_mirror`.
    """

    lens: LensProfile | None = None
    hfov_deg: Annotated[
        float, Meta(gt=0.0, lt=180.0, description="Fallback field of view when `lens` is unusable.")
    ] = 60.0
    ipd_mm: Ipd = placement.GENERIC_IPD_MM
    eye: Annotated[
        Literal["left", "right"], Meta(description="The eye the operator keeps open.")
    ] = "right"


class CalibrationSettingsUpdate(msgspec.Struct, kw_only=True):
    """Settings to change; omitted fields keep their value. `lens: null` drops the lens."""

    lens: LensProfile | UnsetType | None = UNSET
    hfov_deg: float | UnsetType = UNSET
    ipd_mm: Ipd | UnsetType = UNSET
    eye: Literal["left", "right"] | UnsetType = UNSET


class BoardPayload(msgspec.Struct, kw_only=True):
    """The printed board in the latest processed frame, in unflipped camera pixels.

    The pose fields are null when the board was not detected or its pose could
    not be estimated. `distance_mm` is the range from the camera to the
    designated corner, and `sharpness` only compares with other frames of the
    same session.
    """

    detected: bool
    corners: int
    marker_count: int
    hull_px: list[list[float]]
    frame_width: float
    frame_height: float
    sharpness: float
    point_mm: Vector3 | None
    distance_mm: float | None
    rms_px: float | None
    ambiguity_mm: float | None
    tilt_deg: float | None
    capture_ts: CaptureMs
    ts: EpochMs


class LensProgressPayload(msgspec.Struct, kw_only=True):
    """How far the lens capture has got. `hint` is what is missing next."""

    views: int
    coverage: float
    tilted_views: int
    progress: float
    hint: str
    accepted: bool
    ts: EpochMs


class StageParams(msgspec.Struct, kw_only=True):
    stage: Stage


class StageResult(msgspec.Struct, kw_only=True):
    stage: Stage


class LensResult(msgspec.Struct, kw_only=True):
    lens: LensProfile
    rms_px: float
    views: int
    hfov_deg: float


class CaptureAlignmentParams(msgspec.Struct, kw_only=True):
    target_px: TargetPx
    canvas_px: CanvasPx
    holdout: Annotated[
        bool, Meta(description="Keep this alignment out of the fit, to check it afterwards.")
    ] = False
    window_ms: Annotated[
        float, Meta(gt=0.0, description="Length of the window ending at this call.")
    ] = DEFAULT_WINDOW_MS


IrisReading = Annotated[
    float | None,
    Meta(
        description="Iris diameter the landmarks show for the operator, whose eye depth is "
        "metric because their pupil spacing was measured. Null when no iris was large enough "
        "in the image to read."
    ),
]


class CaptureAlignmentResult(msgspec.Struct, kw_only=True):
    index: int
    samples: int
    holdouts: int
    point_mm: Vector3
    eye_mm: Vector3
    board_spread_mm: float
    eye_spread_mm: float
    board_distance_mm: float
    eye_distance_mm: float
    iris_mm: IrisReading


class AlignmentSample(msgspec.Struct, kw_only=True):
    index: int
    target_px: list[float]
    canvas_px: list[float]
    holdout: bool
    point_mm: Vector3
    eye_mm: Vector3
    board_spread_mm: float
    eye_spread_mm: float
    board_distance_mm: float
    eye_distance_mm: float
    iris_mm: IrisReading
    ambiguity_mm: float
    ts: EpochMs


class AlignmentsResult(msgspec.Struct, kw_only=True):
    samples: int
    holdouts: int


class AlignmentList(msgspec.Struct, kw_only=True):
    alignments: list[AlignmentSample]
    samples: int
    holdouts: int


class RemoveAlignmentParams(msgspec.Struct, kw_only=True):
    index: int


class SampleResidual(msgspec.Struct, kw_only=True):
    """Distance on the screen between where the rig draws the corner and its target."""

    index: int
    error_mm: float | None


class HoldoutReport(msgspec.Struct, kw_only=True):
    count: int
    mean_mm: float | None
    max_mm: float | None
    residuals_mm: list[SampleResidual]


class SolveRigParams(msgspec.Struct, kw_only=True):
    width_mm: Annotated[float, Meta(gt=0, description="Physical width the canvas pixels cover.")]
    height_mm: Annotated[float, Meta(gt=0, description="Physical height the canvas pixels cover.")]
    gap_mm: Annotated[float, Meta(ge=0, description="Mirror surface to pixel plane.")] = 0.0
    camera_in_screen_mm: Annotated[
        Vector3 | None, Meta(description="Rough camera position (u, v, w) to start the fit from.")
    ] = None
    camera_height_mm: Annotated[
        CameraHeight | None,
        Meta(
            description="Camera lens above the floor. Stored in the rig profile, where it lets "
            "a visitor's visible feet set their depth without knowing their size."
        ),
    ] = None


class IrisReport(msgspec.Struct, kw_only=True):
    """What the operator's irises read, and whether the reading depends on their range.

    `apparent_mm` is the median over every alignment that carried one, fitted
    and holdout alike; the rig's `iris_mm` is that median shrunk toward the
    population average. `near_mm` and `far_mm` split the same readings at their
    median eye distance. A gap between them would mean the landmark model reads
    an iris differently as it shrinks in the image, which only a rig trial can
    show; nothing here corrects for it.
    """

    apparent_mm: float | None
    near_mm: float | None
    far_mm: float | None
    samples: Annotated[int, Meta(description="Alignments that carried an iris reading.")]


class SolveRigResult(msgspec.Struct, kw_only=True):
    """The fitted rig and how much to trust it.

    `predicted_error_mm` and `condition` are null when the alignments leave the
    pose entirely undetermined, which also makes `quality` poor.
    """

    rig: RigProfile
    rms_mm: float
    residuals_mm: list[SampleResidual]
    predicted_error_mm: float | None
    condition: float | None
    quality: Quality
    tilt_deg: float
    camera_in_screen_mm: Vector3
    distances_mm: list[float]
    holdout: HoldoutReport | None
    iris: IrisReport


class SuggestTargetsParams(msgspec.Struct, kw_only=True):
    candidates_px: Annotated[
        list[Annotated[list[float], Meta(min_length=2, max_length=2)]],
        Meta(min_length=1, max_length=256, description="Canvas pixels to test."),
    ]
    canvas_px: Annotated[list[float], Meta(min_length=2, max_length=2)]
    width_mm: Annotated[float, Meta(gt=0, description="Physical width the canvas pixels cover.")]
    height_mm: Annotated[float, Meta(gt=0, description="Physical height the canvas pixels cover.")]
    gap_mm: Annotated[float, Meta(ge=0)] = 0.0
    camera_in_screen_mm: Annotated[
        Vector3 | None, Meta(description="Rough camera position (u, v, w); ignored with `rig`.")
    ] = None
    rig: Annotated[
        RigProfile | None, Meta(description="A fitted rig, once there is one; else a nominal one.")
    ] = None
    reach_mm: Annotated[
        float, Meta(gt=0, description="How far in front of the eye the board is held.")
    ] = DEFAULT_REACH_MM


class TargetSuggestion(msgspec.Struct, kw_only=True):
    """Whether the camera would still see the whole board with its corner on this target.

    `hold` says how to hold the sheet: `corner_up` is upright, the marked
    corner at the top left; `corner_down` is the sheet turned half a turn, which
    reaches targets low on the screen.
    """

    target_px: list[float]
    reachable: bool
    hold: Hold | None


class SuggestTargetsResult(msgspec.Struct, kw_only=True):
    """`reason` says why nothing could be tested: no face seen yet, or the
    operator stands too close for a board held in front of them."""

    targets: list[TargetSuggestion]
    eye_distance_mm: float | None
    reason: Literal["no_face", "too_close"] | None = None


class CheckRigParams(msgspec.Struct, kw_only=True):
    rig: RigProfile


class CheckRigResult(msgspec.Struct, kw_only=True):
    samples: int
    rms_mm: float | None
    mean_mm: float | None
    max_mm: float | None
    residuals_mm: list[SampleResidual]


@dataclass(frozen=True)
class _BoardSample:
    """One board pose in the history, in camera millimeters."""

    capture_ts: float
    point_mm: Array
    ambiguity_mm: float
    rms_px: float


@dataclass(frozen=True)
class _EyeSample:
    """Both pupils of one pose frame, in camera millimeters, and the iris read there."""

    capture_ts: float
    left: Array
    right: Array
    iris_mm: float | None


@dataclass(frozen=True)
class _Alignment:
    """One confirmed alignment: from `eye_mm`, `point_mm` covered `target_px`."""

    index: int
    target_px: tuple[float, float]
    canvas_px: tuple[float, float]
    holdout: bool
    point_mm: Array
    eye_mm: Array
    board_spread_mm: float
    eye_spread_mm: float
    iris_mm: float | None
    ambiguity_mm: float
    ts: float

    def target_mm(self, width_mm: float, height_mm: float) -> Array:
        """The target in canvas-centered millimeters, for a canvas of that physical size."""
        # `pixels_to_mm` reads only the rig's size, so the pose here is a placeholder.
        rig = mirror_rig.Rig((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), width_mm, height_mm)
        return mirror_rig.pixels_to_mm(rig, self.target_px, *self.canvas_px)

    def payload(self) -> AlignmentSample:
        return AlignmentSample(
            index=self.index,
            target_px=list(self.target_px),
            canvas_px=list(self.canvas_px),
            holdout=self.holdout,
            point_mm=_vector(self.point_mm),
            eye_mm=_vector(self.eye_mm),
            board_spread_mm=round(self.board_spread_mm, 3),
            eye_spread_mm=round(self.eye_spread_mm, 3),
            board_distance_mm=_distance(self.point_mm),
            eye_distance_mm=_distance(self.eye_mm),
            iris_mm=None if self.iris_mm is None else round(self.iris_mm, 3),
            ambiguity_mm=round(self.ambiguity_mm, 3),
            ts=self.ts,
        )


def _vector(values: Array) -> list[float]:
    return [round(float(v), 3) for v in values]


def _triple(values: Array) -> tuple[float, float, float]:
    x, y, z = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y, z


def _pair(values: Array) -> tuple[float, float]:
    x, y = (float(v) for v in np.asarray(values, dtype=np.float64).ravel())
    return x, y


def _distance(point: Array) -> float:
    return round(float(np.linalg.norm(point)), 3)


def _finite(value: float) -> float | None:
    """A number for the wire: JSON has no infinity, and an unbounded fit reaches it."""
    return round(value, 3) if math.isfinite(value) else None


def _spread_mm(rows: Array) -> float:
    """Worst per-axis standard deviation of a short run of positions."""
    return float(np.std(rows, axis=0).max())


def _in_frame(camera: CameraModel, first: Array, second: Array) -> NDArray[np.bool_]:
    """Per row: both opposite corners of the sheet project inside the frame, with a margin."""
    inside = np.ones(len(first), dtype=np.bool_)
    margin_x, margin_y = camera.width * FRAME_MARGIN, camera.height * FRAME_MARGIN
    for points in (first, second):
        pixels = camera.project(points)
        inside &= points[:, 2] > 0.0
        inside &= (pixels[:, 0] >= margin_x) & (pixels[:, 0] <= camera.width - margin_x)
        inside &= (pixels[:, 1] >= margin_y) & (pixels[:, 1] <= camera.height - margin_y)
    return inside


def _quality(predicted_error_mm: float) -> Quality:
    if predicted_error_mm <= GOOD_ERROR_MM:
        return "good"
    return "fair" if predicted_error_mm <= FAIR_ERROR_MM else "poor"


def _distinct_distances(values: Sequence[float]) -> list[float]:
    """Standing distances the samples cover, merging those within one bucket."""
    groups: list[list[float]] = []
    for value in sorted(float(v) for v in values):
        if groups and value - groups[-1][-1] <= DISTANCE_BUCKET_MM:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [round(float(np.mean(group)), 1) for group in groups]


def _iris_report(samples: Sequence[_Alignment]) -> tuple[IrisReport, float]:
    """What the alignments say the operator's iris reads, and the diameter to assume.

    Near and far are the two halves of the readings by how far the operator's
    eye was from the camera. They are diagnostics only: a difference between
    them means the landmark model's reading follows the iris's size in the
    image, and there is no way to tell which half to believe without a rig
    trial.
    """
    rows = [
        (float(np.linalg.norm(sample.eye_mm)), sample.iris_mm)
        for sample in samples
        if sample.iris_mm is not None
    ]
    if not rows:
        return IrisReport(apparent_mm=None, near_mm=None, far_mm=None, samples=0), GENERIC_IRIS_MM
    readings = [iris for _, iris in rows]
    apparent = float(np.median(readings))
    split = float(np.median([distance for distance, _ in rows]))
    near = [iris for distance, iris in rows if distance < split]
    far = [iris for distance, iris in rows if distance > split]
    report = IrisReport(
        apparent_mm=round(apparent, 3),
        near_mm=round(float(np.median(near)), 3) if near else None,
        far_mm=round(float(np.median(far)), 3) if far else None,
        samples=len(rows),
    )
    # One or two glances are not a measurement of the camera.
    assumed = (
        placement.calibrated_iris_mm(apparent)
        if len(rows) >= MIN_IRIS_ALIGNMENTS
        else GENERIC_IRIS_MM
    )
    return report, assumed


def _residuals(
    rig: mirror_rig.Rig, samples: Sequence[_Alignment]
) -> tuple[list[SampleResidual], list[float]]:
    """Per-sample screen error, and the finite ones on their own for the summaries."""
    rows: list[SampleResidual] = []
    finite: list[float] = []
    for sample in samples:
        hit = mirror_rig.project_mm(rig, sample.eye_mm, sample.point_mm)
        target = sample.target_mm(rig.width_mm, rig.height_mm)
        error = float(np.linalg.norm(hit - target))
        # A point or an eye behind the mirror has no image at all.
        defined = bool(np.isfinite(error))
        rows.append(
            SampleResidual(index=sample.index, error_mm=round(error, 3) if defined else None)
        )
        if defined:
            finite.append(error)
    return rows, finite


class MirrorCalibrationDriver(BaseDriver):
    name = "mirror_calibration"
    description = "Lens and mirror-rig calibration from the printed ChArUco board."
    events: ClassVar[Mapping[str, Event]] = {
        "board": Event(BoardPayload, "The printed board in the latest frame, outside idle."),
        "lens_progress": Event(LensProgressPayload, "Lens capture progress, in the lens stage."),
    }
    stream_events = ("board", "lens_progress")
    dependencies = ("camera", "pose")
    subscribed = (("camera", "frame"), ("pose", "raw_data"))
    loop_interval_s = None

    def __init__(self, context: DriverContext) -> None:
        super().__init__(context)
        self._lock = threading.Lock()
        self._settings = CalibrationSettings()
        self._stage: Stage = "idle"
        self._calibrator = charuco.LensCalibrator()
        # Set while `solve_lens` runs, so the camera thread leaves the
        # calibrator alone instead of waiting on the lock for a whole solve.
        self._lens_busy = False
        self._boards: deque[_BoardSample] = deque(maxlen=HISTORY_FRAMES)
        self._eyes: deque[_EyeSample] = deque(maxlen=HISTORY_FRAMES)
        self._samples: list[_Alignment] = []
        self._next_index = 0
        self._warned_sizes: set[tuple[float, float]] = set()
        self._frame_size: tuple[float, float] | None = None

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    @action("Change settings and return all of them. New optics drop the recent history.")
    def configure(self, params: CalibrationSettingsUpdate | None) -> CalibrationSettings:
        with self._lock:
            if params is not None:
                changes = {
                    field: value
                    for field in params.__struct_fields__
                    if (value := getattr(params, field)) is not UNSET
                }
                previous = self._settings
                self._settings = msgspec.structs.replace(previous, **changes)
                # The history was measured through the old camera model and the
                # old head scale, so it says nothing about the new ones. `eye`
                # is free: both pupils are kept and chosen from at capture time.
                if any(
                    getattr(previous, name) != getattr(self._settings, name)
                    for name in ("lens", "hfov_deg", "ipd_mm")
                ):
                    self._boards.clear()
                    self._eyes.clear()
            return self._settings

    @action("Detect the board only outside 'idle'. Changing stage drops the recent history.")
    def set_stage(self, params: StageParams) -> StageResult:
        with self._lock:
            if params.stage != self._stage:
                # Frames from the previous stage say nothing about this one.
                self._boards.clear()
                self._eyes.clear()
            self._stage = params.stage
            return StageResult(stage=self._stage)

    @action("Forget the collected lens views.")
    def reset_lens(self) -> None:
        with self._lock:
            calibrator = self._calibrator
        calibrator.reset()

    @action("Solve the lens from the collected views; it also becomes the current lens setting.")
    def solve_lens(self) -> LensResult:
        with self._lock:
            if self._lens_busy:
                raise RuntimeError("busy_lens: a lens solve is already running")
            calibrator = self._calibrator
            self._lens_busy = True
        try:
            solved = calibrator.solve()
        finally:
            with self._lock:
                self._lens_busy = False
        profile = LensProfile.of(solved.camera, round(solved.rms_px, 4))
        with self._lock:
            self._settings = msgspec.structs.replace(self._settings, lens=profile)
        self.log(
            "info",
            f"lens solved from {solved.views} views: {solved.hfov_deg:.1f} degrees, "
            f"{solved.rms_px:.2f} px",
        )
        return LensResult(
            lens=profile,
            rms_px=round(solved.rms_px, 4),
            views=solved.views,
            hfov_deg=round(solved.hfov_deg, 3),
        )

    @action("Record one alignment from the window ending now. Raises with a reason code.")
    def capture_alignment(self, params: CaptureAlignmentParams) -> CaptureAlignmentResult:
        width_px, height_px = params.canvas_px
        if width_px <= 0.0 or height_px <= 0.0:
            raise ValueError(f"canvas_px must be positive, got {params.canvas_px}")
        start = now_ms() - params.window_ms
        with self._lock:
            settings = self._settings
            boards = [sample for sample in self._boards if sample.capture_ts >= start]
            eyes = [sample for sample in self._eyes if sample.capture_ts >= start]

        window = f"the last {params.window_ms:.0f} ms"
        if len(boards) < MIN_BOARD_SAMPLES:
            raise RuntimeError(
                f"board_missing: only {len(boards)} board poses in {window}, need "
                f"{MIN_BOARD_SAMPLES}; keep the whole printed sheet in the camera's view"
            )
        if len(eyes) < MIN_EYE_SAMPLES:
            raise RuntimeError(
                f"face_missing: only {len(eyes)} face frames in {window}, need "
                f"{MIN_EYE_SAMPLES}; keep your face in the camera's view"
            )

        points = np.array([sample.point_mm for sample in boards], dtype=np.float64)
        pupils = np.array(
            [sample.left if settings.eye == "left" else sample.right for sample in eyes],
            dtype=np.float64,
        )
        board_spread = _spread_mm(points)
        eye_spread = _spread_mm(pupils)
        irises = [sample.iris_mm for sample in eyes if sample.iris_mm is not None]
        ambiguity = float(np.median([sample.ambiguity_mm for sample in boards]))
        if board_spread > MAX_BOARD_SPREAD_MM:
            raise RuntimeError(
                f"unstable_board: the board moved {board_spread:.1f} mm during {window}, "
                f"more than {MAX_BOARD_SPREAD_MM:.0f} mm; hold it still and confirm again"
            )
        if eye_spread > MAX_EYE_SPREAD_MM:
            raise RuntimeError(
                f"unstable_eye: your head moved {eye_spread:.1f} mm during {window}, "
                f"more than {MAX_EYE_SPREAD_MM:.0f} mm; stand still and confirm again"
            )
        if ambiguity > MAX_AMBIGUITY_MM:
            raise RuntimeError(
                f"ambiguous_board: the board pose is uncertain by {ambiguity:.0f} mm, "
                f"more than {MAX_AMBIGUITY_MM:.0f} mm; tilt the sheet or hold it closer"
            )

        with self._lock:
            alignment = _Alignment(
                index=self._next_index,
                target_px=(float(params.target_px[0]), float(params.target_px[1])),
                canvas_px=(float(width_px), float(height_px)),
                holdout=params.holdout,
                point_mm=np.median(points, axis=0),
                eye_mm=np.median(pupils, axis=0),
                board_spread_mm=board_spread,
                eye_spread_mm=eye_spread,
                iris_mm=float(np.median(irises)) if irises else None,
                ambiguity_mm=ambiguity,
                ts=now_ms(),
            )
            self._next_index += 1
            self._samples.append(alignment)
            # The next target must be aligned afresh, never averaged from these frames.
            self._boards.clear()
            self._eyes.clear()
            counts = self._counts()
        sample = alignment.payload()
        return CaptureAlignmentResult(
            index=sample.index,
            samples=counts.samples,
            holdouts=counts.holdouts,
            point_mm=sample.point_mm,
            eye_mm=sample.eye_mm,
            board_spread_mm=sample.board_spread_mm,
            eye_spread_mm=sample.eye_spread_mm,
            board_distance_mm=sample.board_distance_mm,
            eye_distance_mm=sample.eye_distance_mm,
            iris_mm=sample.iris_mm,
        )

    @action("Drop one alignment by its index.")
    def remove_alignment(self, params: RemoveAlignmentParams) -> AlignmentsResult:
        with self._lock:
            kept = [sample for sample in self._samples if sample.index != params.index]
            if len(kept) == len(self._samples):
                raise RuntimeError(f"unknown_alignment: no alignment with index {params.index}")
            self._samples = kept
            return self._counts()

    @action("Drop every alignment.")
    def clear_alignments(self) -> AlignmentsResult:
        with self._lock:
            self._samples = []
            return self._counts()

    @action("Every stored alignment, in capture order.")
    def list_alignments(self) -> AlignmentList:
        with self._lock:
            samples = list(self._samples)
            counts = self._counts()
        return AlignmentList(
            alignments=[sample.payload() for sample in samples],
            samples=counts.samples,
            holdouts=counts.holdouts,
        )

    @action("Fit the mirror rig from the stored alignments.")
    def solve_rig(self, params: SolveRigParams) -> SolveRigResult:
        with self._lock:
            samples = list(self._samples)
        fitted = [sample for sample in samples if not sample.holdout]
        holdouts = [sample for sample in samples if sample.holdout]
        correspondences = [
            mirror_rig.Correspondence(
                eye=_triple(sample.eye_mm),
                point=_triple(sample.point_mm),
                target_mm=_pair(sample.target_mm(params.width_mm, params.height_mm)),
            )
            for sample in fitted
        ]
        try:
            fit = mirror_rig.fit_rig(
                correspondences,
                params.width_mm,
                params.height_mm,
                params.gap_mm,
                params.camera_in_screen_mm,
            )
        except mirror_rig.RigFitError as exc:
            raise RuntimeError(f"no_valid_rig: {exc}") from exc

        rig = fit.rig
        residuals = [
            SampleResidual(index=sample.index, error_mm=round(float(error), 3))
            for sample, error in zip(fitted, fit.residuals_mm, strict=True)
        ]
        rows, finite = _residuals(rig, holdouts)
        holdout = (
            None
            if not holdouts
            else HoldoutReport(
                count=len(holdouts),
                mean_mm=round(float(np.mean(finite)), 3) if finite else None,
                max_mm=round(float(np.max(finite)), 3) if finite else None,
                residuals_mm=rows,
            )
        )
        eyes = np.array([sample.eye_mm for sample in fitted], dtype=np.float64)
        distances = mirror_rig.mirror_distance(rig, eyes)
        camera_in_screen = -rig.rotation_matrix.T @ np.asarray(rig.center_mm)
        # Every alignment saw the same operator through the same camera, so the
        # holdouts count here even though the pose fit never used them.
        iris, iris_mm = _iris_report(samples)
        return SolveRigResult(
            rig=RigProfile.of(rig, params.camera_height_mm, iris_mm),
            rms_mm=round(fit.rms_mm, 3),
            residuals_mm=residuals,
            predicted_error_mm=_finite(fit.predicted_error_mm),
            condition=_finite(fit.condition),
            quality=_quality(fit.predicted_error_mm),
            tilt_deg=round(rig.tilt_deg, 3),
            camera_in_screen_mm=_vector(camera_in_screen),
            distances_mm=_distinct_distances(distances.tolist()),
            holdout=holdout,
            iris=iris,
        )

    @action("Which targets the operator can reach from where they stand, board still in view.")
    def suggest_targets(self, params: SuggestTargetsParams) -> SuggestTargetsResult:
        """Test targets against the latest eye position.

        Covering a target low on the screen takes a board held about twice as
        far below the eye, which soon leaves the frame of a camera mounted on
        top. Before the fit this runs on a nominal rig, so it is a guide: the
        capture itself still checks that the board was seen.
        """
        with self._lock:
            settings, frame_size = self._settings, self._frame_size
            latest = self._eyes[-1] if self._eyes else None
        unknown = [
            TargetSuggestion(target_px=list(target), reachable=False, hold=None)
            for target in params.candidates_px
        ]
        if latest is None or frame_size is None:
            return SuggestTargetsResult(targets=unknown, eye_distance_mm=None, reason="no_face")
        rig = (
            params.rig.rig()
            if params.rig is not None
            else mirror_rig.Rig.nominal(
                params.width_mm, params.height_mm, params.gap_mm, params.camera_in_screen_mm
            )
        )
        eye = latest.left if settings.eye == "left" else latest.right
        eye_distance = float(mirror_rig.mirror_distance(rig, eye))
        board_distance = eye_distance - params.reach_mm
        if board_distance < MIN_BOARD_TO_MIRROR_MM:
            return SuggestTargetsResult(
                targets=unknown, eye_distance_mm=round(eye_distance, 1), reason="too_close"
            )

        width_px, height_px = params.canvas_px
        targets_mm = mirror_rig.pixels_to_mm(rig, params.candidates_px, width_px, height_px)
        corners = mirror_rig.point_for_target(rig, eye, targets_mm, board_distance)
        camera = self._camera(settings, *frame_size)
        # The sheet faces the camera, so its far corner lies along +x, +y of the
        # camera when upright and along -x, -y after half a turn.
        extent = np.array([charuco.BOARD_WIDTH_MM, charuco.BOARD_HEIGHT_MM, 0.0])
        upright = _in_frame(camera, corners, corners + extent)
        turned = _in_frame(camera, corners, corners - extent)
        suggestions = []
        for i, target in enumerate(params.candidates_px):
            hold: Hold | None = "corner_up" if upright[i] else "corner_down" if turned[i] else None
            suggestions.append(
                TargetSuggestion(target_px=list(target), reachable=hold is not None, hold=hold)
            )
        return SuggestTargetsResult(targets=suggestions, eye_distance_mm=round(eye_distance, 1))

    @action("Residuals of every stored alignment against a given rig.")
    def check_rig(self, params: CheckRigParams) -> CheckRigResult:
        with self._lock:
            samples = list(self._samples)
        rows, finite = _residuals(params.rig.rig(), samples)
        errors = np.asarray(finite, dtype=np.float64)
        return CheckRigResult(
            samples=len(samples),
            rms_mm=round(float(np.sqrt(np.mean(errors**2))), 3) if finite else None,
            mean_mm=round(float(errors.mean()), 3) if finite else None,
            max_mm=round(float(errors.max()), 3) if finite else None,
            residuals_mm=rows,
        )

    # ------------------------------------------------------------------
    # Subscriptions
    # ------------------------------------------------------------------

    def on_data(self, driver: str, event: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        if driver == "camera":
            self._on_frame(data)
        elif driver == "pose":
            self._on_pose(data)

    def _on_frame(self, data: Mapping[str, Any]) -> None:
        """Detect the board and report it. Runs on the camera subscription thread."""
        frame = data.get("_frame")
        if frame is None:
            return
        with self._lock:
            stage, settings = self._stage, self._settings
        if stage == "idle":
            return
        height, width = float(frame.shape[0]), float(frame.shape[1])
        with self._lock:
            # `suggest_targets` reads this from the action thread.
            self._frame_size = (width, height)
        camera = self._camera(settings, width, height)
        capture_ts, _ = capture_timing(data)

        start = time.perf_counter()
        observation = charuco.detect(frame)
        pose = None if observation is None else charuco.estimate_pose(observation, camera)
        self.record("detect_ms", (time.perf_counter() - start) * 1000.0)

        if pose is not None and stage == "align":
            sample = _BoardSample(
                capture_ts=capture_ts,
                point_mm=np.asarray(pose.point_mm, dtype=np.float64),
                ambiguity_mm=float(pose.ambiguity_mm),
                rms_px=float(pose.rms_px),
            )
            with self._lock:
                self._boards.append(sample)
                self._prune()
        self._emit_board(observation, pose, width, height, capture_ts)

        if stage == "lens":
            accepted = observation is not None and self._offer(observation)
            self._emit_lens_progress(accepted)

    def _offer(self, observation: charuco.BoardObservation) -> bool:
        """Give one view to the calibrator, restarting it when the frame size changed."""
        with self._lock:
            if self._lens_busy:
                return False  # a solve is running on this calibrator
            calibrator = self._calibrator
        size = calibrator.frame_size
        if size is not None and size != observation.frame_size:
            self.log(
                "warn",
                f"camera resolution changed from {size} to {observation.frame_size}; "
                "the collected lens views are dropped",
            )
            calibrator.reset()
        return calibrator.offer(observation)

    def _on_pose(self, data: Mapping[str, Any]) -> None:
        """Place both pupils in camera millimeters. Runs on the pose subscription thread."""
        with self._lock:
            stage, settings = self._stage, self._settings
        if stage != "align":
            return
        xyz = data.get("_face_xyz")
        if xyz is None:
            return
        mesh = np.asarray(xyz, dtype=np.float64)
        if mesh.ndim != 2 or len(mesh) == 0 or mesh.shape[1] < 3:
            return
        width = float(data.get("frame_width") or 0.0)
        height = float(data.get("frame_height") or 0.0)
        if width <= 0.0 or height <= 0.0:
            return
        camera = self._camera(settings, width, height)
        # The pose driver may have mirrored the frame; geometry needs the camera's own.
        uv = unflip(mesh[:, :2], width) if data.get("flipped") else mesh[:, :2]
        rays = camera.normalize(uv)
        eyes = placement.locate_eyes(rays, mesh[:, 2] / camera.fx, settings.ipd_mm)
        if eyes is None:
            return
        # The operator's pupil spacing is measured, so their eye depth is metric
        # and the irises at that depth show what this camera reads an iris as.
        iris_mm = placement.apparent_iris_mm(rays, camera.fx, float(eyes.midpoint[2]))
        capture_ts, _ = capture_timing(data)
        with self._lock:
            self._eyes.append(
                _EyeSample(capture_ts=capture_ts, left=eyes.left, right=eyes.right, iris_mm=iris_mm)
            )
            self._prune()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _camera(self, settings: CalibrationSettings, width: float, height: float) -> CameraModel:
        """The frame's camera model: the calibrated lens when it fits this frame size.

        A lens calibrated at another aspect ratio says nothing about this
        frame's crop, so the uncalibrated field of view takes over.
        """
        if settings.lens is not None:
            scaled = settings.lens.camera().scaled_to(width, height)
            if scaled is not None:
                return scaled
            with self._lock:
                warn = (width, height) not in self._warned_sizes
                self._warned_sizes.add((width, height))
            if warn:
                self.log(
                    "warn",
                    f"the lens profile is {settings.lens.width:.0f}x{settings.lens.height:.0f}, "
                    f"a different aspect ratio than this {width:.0f}x{height:.0f} frame; "
                    f"falling back to {settings.hfov_deg:.0f} degrees",
                )
        return CameraModel.from_hfov(width, height, settings.hfov_deg)

    def _prune(self) -> None:
        """Drop history older than `HISTORY_MS`. Called with the lock held."""
        cutoff = now_ms() - HISTORY_MS
        while self._boards and self._boards[0].capture_ts < cutoff:
            self._boards.popleft()
        while self._eyes and self._eyes[0].capture_ts < cutoff:
            self._eyes.popleft()

    def _counts(self) -> AlignmentsResult:
        """Fitted and holdout sample counts. Called with the lock held."""
        holdouts = sum(1 for sample in self._samples if sample.holdout)
        return AlignmentsResult(samples=len(self._samples) - holdouts, holdouts=holdouts)

    def _emit_board(
        self,
        observation: charuco.BoardObservation | None,
        pose: charuco.BoardPose | None,
        width: float,
        height: float,
        capture_ts: float,
    ) -> None:
        payload = msgspec.to_builtins(
            BoardPayload(
                detected=observation is not None,
                corners=0 if observation is None else len(observation.corner_ids),
                marker_count=0 if observation is None else observation.marker_count,
                hull_px=[] if observation is None else observation.hull_px.tolist(),
                frame_width=width,
                frame_height=height,
                sharpness=0.0 if observation is None else round(observation.sharpness, 3),
                point_mm=None if pose is None else _vector(pose.point_mm),
                distance_mm=None if pose is None else _distance(pose.point_mm),
                rms_px=None if pose is None else round(pose.rms_px, 4),
                ambiguity_mm=None if pose is None else round(pose.ambiguity_mm, 3),
                tilt_deg=None if pose is None else round(pose.tilt_deg, 3),
                capture_ts=capture_ts,
                ts=now_ms(),
            )
        )
        self.emit("board", payload)

    def _emit_lens_progress(self, accepted: bool) -> None:
        with self._lock:
            calibrator = self._calibrator
        payload = msgspec.to_builtins(
            LensProgressPayload(
                views=calibrator.views,
                coverage=round(calibrator.coverage, 4),
                tilted_views=calibrator.tilted_views,
                progress=round(calibrator.progress, 4),
                hint=calibrator.hint,
                accepted=accepted,
                ts=now_ms(),
            )
        )
        self.emit("lens_progress", payload)
