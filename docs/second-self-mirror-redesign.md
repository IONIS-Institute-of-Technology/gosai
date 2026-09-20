Second Self should replace its reflection calibration with a calibrated, viewer-dependent projection, keeping the existing single webcam and direct mode. The first version should improve visible alignment with one printed board, a few measurements, and a short guided setup. This design is implemented and the old tilt/scale/affine path has been deleted. Accuracy on a physical rig is still unmeasured, so nothing here is a measured accuracy claim.

The user accepts some movement delay and prioritizes limited budget, limited development time, and reasonable calibration steps. These constraints supersede the earlier proposal for a calibration pointer, personalized articulated reconstruction, detailed glass optics, and presentation-time prediction.

The existing reflection equation agrees with an independent plane-intersection calculation across 800 synthetic cases. Its main weaknesses are approximate camera intrinsics, using the nose as the eye position, shoulder-only distance estimation, flattened hand depth, incomplete rig geometry, and fixed smoothing. Correct these before adding an optical distortion model.

The first version should include:

- Calibrated webcam intrinsics and lens distortion. Geometry uses unflipped camera coordinates with explicit handling of rotation and crop.
- A flat mirror with full orientation and position relative to the camera. Assume the screen is parallel to the mirror. Store the active screen width and height and one manually measured screen-to-mirror spacing.
- Eye positions estimated from a scaled face model. Use a measured interpupillary distance for the calibration operator to establish head scale. Other users may use a generic head scale initially; keep personal scale separate from the rig profile and describe the resulting accuracy tradeoff.
- MediaPipe body landmarks with a modest improvement to absolute placement: fit camera-space translation from several reliable torso landmarks and their relative 3D estimates. Do not fit an articulated body as a rigid object or assume that a low reprojection error proves correct depth. Estimate a coarse body scale from the cues the camera already gives, without measuring every bone and without a setup step per visitor.
- Existing hand tracking, retaining available relative hand depth and anchoring it to the wrist when its scale and coordinate conventions can be established. Improve body and eye alignment before expanding hand reconstruction work.
- Capture timestamps preserved through the pipeline, newest-frame processing, and light time-aware smoothing. Do not make motion prediction a prerequisite.

The calibration kit is one ChArUco sheet printed at actual size and attached to a flat, rigid backing. Include a ruler on the print so the user can check printer scaling. The board needs no custom pointer, electronics, or specially calibrated fixture.

The proposed setup flow is:

1. Enter active screen width and height and the approximate mirror-to-pixel-plane spacing in millimeters. Enter the calibration operator's interpupillary distance. A rough camera mounting position provides an initial estimate if the solver needs one; do not ask the user to measure mounting angles precisely.
2. Calibrate the lens by moving the board through different positions and tilts. Automatically collect sharp, diverse observations and show progress. Save this independently of the mirror calibration. Reuse it unless relevant camera settings or the optical path change.
3. Align a designated printed corner's reflection with a displayed target while keeping the board and face visible to the webcam. Use the same selected eye throughout and close the other eye. Collect about eight correspondences spread over reachable target locations and two standing distances. Confirm alignment explicitly, then average a short stable interval. Stillness alone must not confirm that a target was reached.
4. Fit the mirror/display rigid pose with screen dimensions, camera intrinsics, board size, spacing, and head scale fixed. The observed board pose gives a metric 3D reference point; the tracked face gives the viewpoint. Use multiple starting estimates if needed, reject physically invalid results, and check that the observations constrain the fit. Do not jointly fit arbitrary affine warps, unknown body scale, and lens parameters.
5. Check a few additional targets and head positions that were not used in the fit. Show the skeleton, ask the user to move closer and farther, and permit a small final horizontal/vertical trim. Store that perceptual trim separately; it must not hide a poor geometric fit.

This still contains subjective visual alignment. Its advantage over the old wizard is that the printed board has known size and a directly estimated pose, while lens parameters and physical display dimensions are fixed. It does not depend on inferred fingertip depth to calibrate the rig. Pose estimates from a printed planar board can still be noisy or ambiguous, especially when the board is small in the image. The flow must request a better board orientation or another observation when necessary. The exact sample count and achievable accuracy need a rig trial before committing to them.

The camera faces the user and may not see markers attached flat to its own bezel. The user holds this board in the camera's field of view. The workflow does not assume the webcam can directly photograph its own screen.

For projection, reflect a body point P across the flat mirror plane with unit normal n and offset d:

    P_virtual = P - 2 * (n dot P - d) * n

Intersect the sight line from the chosen eye to P_virtual with the screen plane, then map physical screen coordinates to pixels. Tilt, eye movement, and different joint depths follow from this calculation. The first version assumes parallel mirror and screen planes and straight rays. The manually entered spacing is an approximate effective separation, not a complete refractive glass model.

For the user's less-than-10-mm spacing, keeping a scalar setting is inexpensive and worthwhile, but it is a secondary error source. In the experiment's example, with eye and body point both 1.5 m from the mirror and a mirror intersection about 381 mm from the eye's normal projection, ignoring 10 mm causes about 2.54 mm lateral error; 5 mm causes about 1.27 mm. These are examples, not universal bounds. Closer viewing and more oblique rays increase the effect. No special spacing-calibration stage is needed.

The optical limit remains: a normal display cannot precisely register its pixels with a reflected body for both eyes simultaneously. Calibrate and diagnose with one eye, which is a setting of the calibration driver alone. Draw for the eye midpoint the rest of the time: a visitor to a public mirror picks no eye, so the midpoint is everybody's compromise. The single webcam also cannot uniquely determine every body's metric shape and depth.

For delay, first remove avoidable frame accumulation and excessive smoothing. The current body smoother contributes about 50 ms of steady-motion lag at 30 updates per second, before other delays. Tune smoothing by checking both stationary jitter and movement. Preserve source timestamps to measure processing age, while acknowledging that software timestamps do not measure the full motion-to-photon delay. Add prediction only if the remaining lag visibly warrants it.

Defer glass refraction, curved-mirror reconstruction, dense correction maps, measured bone lengths, custom calibration hardware, and presentation-time prediction. Revisit any of them only when repeatable physical observations show a remaining problem large enough to justify the work. Floor contact was on that list and came off it: see the deviations below.

Implement in small, verifiable steps: printed-board tracking and lens calibration; rigid mirror projection with a basic alignment wizard; eye and body placement; then lighter smoothing. Validate independent board targets before judging pose-tracking accuracy. Compare near/far positions, head translations, upward/downward mirror tilt, and hand reach. Record error distributions and visible lag rather than promising millimeter accuracy before trying the rig.

The old tilt/scale/affine calibration path and its profiles are gone: the owner chose to remove them rather than ship two paths through the rig trials, so there is one thing to fix when a trial goes wrong. Direct mode and the unrelated experience layers are untouched. Reflection mode needs a fitted rig; the driver draws nothing without one, so the app falls back to direct mode and logs that the rig wants calibrating.

The reproducible calculation is in [the geometry experiment](experiments/second-self-mirror-geometry.py). Run it from the repository root:

```sh
PYTHONPATH=python/src python/.venv/bin/python docs/experiments/second-self-mirror-geometry.py
```

References: [OpenCV camera calibration](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html), [OpenCV PnP](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html), [MediaPipe pose output conventions](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/python), [MediaPipe face geometry](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/face_mesh.md), [adaptive filtering](https://gery.casiez.net/1euro/), and [mirror-display depth mismatch](https://arxiv.org/abs/2310.13617).

## Deliberate deviations

A few things came out differently from the plan above, each on purpose.

Body size is estimated per visitor from three cues rather than measured once. The mirror stands in a busy public space, so nobody enters a pupil distance or a body scale, and a shared scale error does not cancel in the drawing: a depth off by a factor s moves the drawing by (s - 1) times its distance on the glass from the point nearest the camera, which is about 6 cm at a hand by the hip for a 10 % error. The cues are:

- The pupil spacing, through `placement.body_scale_from_eyes` at an assumed 63 mm. It is a prior about people rather than a measurement of this one, and it is about 20 % wrong for a small child. It is the least trusted cue and the only one always available, so it is also the one that gives way: its weight falls with the square of how far the measured cues disagree with it.
- The iris, through `placement.iris_depth`. Its diameter is close to 11.7 mm in nearly everybody from the age of two, so its apparent size gives the eye's range whoever it belongs to. It is the main person-independent cue, because it is there whenever the face is.
- Floor contact, through `placement.body_scale_from_floor`. A foot on the known floor also owes nothing to the person's size, but a camera mounted on a mirror only sometimes has the feet in view, so it is an occasional bonus rather than the answer.

`placement.SessionScale` fuses them in the log domain over a sliding window, each weighted by how far it can be off for a stranger. The head is then placed at the spacing the fused size implies, so head and body stay one person. The window restarts when the visitor leaves, on `reset_viewer`, or when the eye midpoint jumps more than 250 mm between two frames, which is the next person walking in while the tracker still holds the last. On a synthetic child of 0.65 scale with 52 mm pupils standing 2 m away with their feet out of the frame, the pupil prior alone reads 21 % too large and the fused answer 1 %, which takes the drawing error from 592 px to 32 px on the 1080x1920 canvas.

How large the landmark model reads an iris can differ from one camera to the next, so the rig calibration measures it. The operator's pupil distance is typed in, which makes their eye depth metric, and `placement.apparent_iris_mm` reads their irises at that known depth on every alignment. `solve_rig` takes the median and shrinks it back toward 11.7 mm by the share of the variance the camera is expected to own rather than the operator's own eyes (`placement.calibrated_iris_mm`), then stores it as `RigProfile.iris_mm`: the diameter to assume on this camera, not anybody's real iris. Fewer than four readings leave the generic value. The result also reports the median over the near and the far half of the alignments, because a gap between them would mean the reading follows the iris's size in the image, which no single assumed diameter can absorb.

The known limits, none of them measured on a rig yet: the iris needs about 5 px across, which is roughly 2.5 m on a 720p camera of this field of view and farther at 1080p, so capture resolution buys range directly; glasses and half-closed eyes move the landmarks; and a head yawed and pitched at once shortens both measured diameters, which reads about 3 % too far at 25 degrees of yaw with 15 of pitch.

Floor contact was deferred in the list above and was brought forward, because public use removes the personal calibration that would otherwise have pinned the size down. It costs one number, the camera's height above the floor, which the rig profile now carries. The owner reports that visitors' feet are in view only sometimes, which is what makes the iris rather than the floor the cue the sizing leans on.

The same arithmetic says where to put the camera. The error grows with the drawing's distance on the glass from the point nearest the camera, so a camera near the middle of the drawn area beats one on top of it, and a camera low enough to see a visitor's feet earns the floor cue as well.

The viewpoint is fixed at the eye midpoint, with no setting. A flat display cannot register with both eyes at once, and nobody walking up to a public mirror chooses which eye to favour.

Targets are chosen by reachability rather than from a fixed list. `suggest_targets` takes the latest eye position, works out where the board would have to be held to cover each candidate mark, and answers which ones leave the whole sheet inside the camera's view and how to hold it. It also says why it could test nothing at all: `no_face` or `too_close`. The wizard plans each round from that answer and spreads its picks over different rows and columns, so it never asks for a mark the operator cannot cover from where they stand.

The setup flow runs in two windows rather than on the mirror. The mirror display has no keyboard and no mouse, so the wizard's state machine stays there, where the canvas is, and every field, button and shortcut lives in a control window GOSAI opens on a display that has both. The mirror publishes a snapshot of the run whenever it changes and the control window sends back commands; a run started without a control window says where to start it from and leaves. The flow is therefore also usable alone: a timed capture counts down on the mirror and calls the same action at zero, which is still an explicit confirmation rather than stillness.

Alignment uses the window that ends at the explicit confirmation. `capture_alignment` averages the last few hundred milliseconds of board poses and eye positions at the moment the operator says the reflection is on the mark, and refuses the sample when either moved too much during it. Stillness on its own never confirms anything: a hand that stops moving says nothing about whether the reflection landed on the target.
