/**
 * The mirror calibration wizard: the setup flow of
 * `docs/second-self-mirror-redesign.md`, run on the mirror by the calibration
 * experience (src/calibrate.ts).
 *
 * The operator measures the screen, calibrates the camera lens with a printed
 * ChArUco sheet, then lines the reflection of the sheet's ORIGIN corner up
 * with targets on the mirror, one eye closed, and confirms each one by hand.
 * The `mirror_calibration` driver turns those correspondences into the pose of
 * the screen behind the mirror, which `pose_to_mirror` projects through.
 *
 * Phases:
 *
 *   measure -> lens -> align (two distances) -> solve -> holdout -> verify -> saving
 *
 * The run lives here, on the mirror, because the mirror owns the canvas: only
 * this window knows how much of the measured screen the reference canvas
 * covers, and only this window can draw a target. It binds no keys and no
 * pointer, because the mirror has neither. Commands arrive from the control
 * window (see channel.ts), and a snapshot of the run goes back the other way
 * whenever it changes.
 *
 * Three rules shape the flow. Nothing is ever confirmed by holding still,
 * because a hand that stops moving says nothing about whether the reflection
 * is on the target; a timed capture is still an explicit confirmation, taken
 * when the operator asked for it. Two standing distances are required, because
 * one distance fits its own targets just as well and still leaves the rig
 * loose. And the number shown last is the error on targets the fit never saw,
 * not the fit's own residual.
 *
 * Whatever ends the run, the driver goes back to `idle` and, unless the
 * profile was saved, the alignments are dropped and the saved projection comes
 * back (see the layer's `stop`).
 */

import type {
  AppEventsSubscription,
  CalibrationResult,
  DriverSubscription,
  DriverTypes,
  ExperienceRuntimeContext,
} from '@gosai/sdk';

import { CALIBRATION_CANCELLED } from '../shared/calibration.js';
import { DRIVER_IPD_MM, type RigMeasurements } from '../shared/config.js';
import type { MirrorFeed } from '../shared/feed.js';
import { drawBody } from '../shared/mirror.js';
import type { Projection } from '../shared/projection.js';
import type { Layer } from '../shared/types.js';
import {
  COMMAND_TOPIC,
  STATUS_TOPIC,
  parseCommand,
  type ControlCommand,
  type WizardStatus,
} from './channel.js';
import {
  DEFAULT_OPERATOR_IPD_MM,
  measureDefaults,
  parseMeasurements,
  type MeasureValues,
  type MeasurementInput,
} from './measurements.js';
import {
  CANVAS_PX,
  EXTRA_ROUND,
  FIT_ROUNDS,
  HOLDOUT_ROUND,
  buildRigProfile,
  candidateGrid,
  chooseSpreadTargets,
  fitReport,
  lensHint,
  physicalCanvasSize,
  rejectionMessage,
  stepTrim,
  withinBand,
  worstSample,
  type Candidate,
  type CanvasLayout,
  type PhysicalCanvas,
  type Round,
} from './wizard/plan.js';
import { GREEN, renderScreen, type CameraFrame } from './wizard/render.js';
import {
  buildStatus,
  type AlignPhase,
  type Live,
  type Phase,
  type PlannedTarget,
} from './wizard/status.js';
import { browserUi, type WizardUi } from './wizard/ui.js';

type BoardPayload = DriverTypes.mirror_calibration.BoardPayload;
type LensProgressPayload = DriverTypes.mirror_calibration.LensProgressPayload;
type ViewerPayload = DriverTypes.pose_to_mirror.ViewerPayload;
type SolveRigResult = DriverTypes.mirror_calibration.SolveRigResult;
type LensProfile = DriverTypes.mirror_calibration.LensProfile;
type Hold = DriverTypes.mirror_calibration.TargetSuggestion['hold'];

/** How old a board, viewer or pose payload may be and still count as live. */
const FRESH_MS = 600;
/** How often the reachable targets are asked for while the operator settles. */
const POLL_MS = 1000;
/** How often the live readings are published, between the changes that publish themselves. */
const STATUS_MS = 250;
/** One step of a timed capture. */
const COUNTDOWN_MS = 1000;
/** After this long at a workable spot, the wanted distance stops being enforced. */
const DISTANCE_GRACE_MS = 15_000;
/** How long the preview flashes after the lens calibrator kept a view. */
const FLASH_MS = 250;

export interface MirrorWizardDeps {
  readonly rt: ExperienceRuntimeContext;
  readonly feed: MirrorFeed;
  readonly projection: Projection;
  /** Called once per run: with `ok` once the profile is saved, cancelled otherwise. */
  finish(result: CalibrationResult): void;
  /** Everything that needs a browser. Tests pass their own. */
  readonly ui?: WizardUi;
}

export function createMirrorWizard(deps: MirrorWizardDeps): Layer {
  const ui = deps.ui ?? browserUi;
  const { rt, projection } = deps;

  let phase: Phase = { kind: 'measure' };
  let message = '';
  /**
   * Bumped whenever the run is abandoned, so an action that settles afterwards
   * can tell it belongs to a run nobody is waiting for.
   */
  let run = 0;
  let busy = false;
  let saved = false;
  let finished = false;
  let saving: AbortController | null = null;

  let measured: MeasurementInput | null = null;
  let formValues: MeasureValues = {};
  let formErrors: readonly string[] = [];
  let lens: LensProfile | null = projection.lens?.lens ?? null;
  let solved: SolveRigResult | null = null;
  /** Which target each stored alignment came from, for a redo. */
  const captured = new Map<number, { readonly target: PlannedTarget; readonly round: Round }>();
  let lensSolving = false;

  /** Where the reference canvas sat in the window at the last frame. */
  let layout: CanvasLayout | null = null;

  let board: BoardPayload | null = null;
  let boardAt = 0;
  let viewer: ViewerPayload | null = null;
  let viewerAt = 0;
  let lensProgress: LensProgressPayload | null = null;
  let acceptedAt = 0;
  let frame: CameraFrame | null = null;
  let countdown: number | null = null;

  const subscriptions: DriverSubscription[] = [];
  let colorSub: DriverSubscription | null = null;
  let commandSub: AppEventsSubscription | null = null;
  let stopPoll: (() => void) | null = null;
  let stopCountdown: (() => void) | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let published = '';

  // -- small helpers ----------------------------------------------------------

  function setPhase(next: Phase): void {
    cancelCountdown();
    phase = next;
    message = '';
    publish();
  }

  function warn(what: string, err: unknown): void {
    rt.log.warn(`calibrate: ${what} failed`, { err: String(err) });
  }

  /** Ends the run once. A second cancel must not undo a result already sent. */
  function finish(result: CalibrationResult): void {
    if (finished) return;
    finished = true;
    deps.finish(result);
  }

  function physical(): PhysicalCanvas {
    const screen: RigMeasurements = measured?.measurements ?? {
      screen_width_mm: 400,
      screen_height_mm: 700,
      gap_mm: 0,
    };
    return physicalCanvasSize(screen, layout);
  }

  function gapMm(): number {
    return measured?.measurements.gap_mm ?? 0;
  }

  function fresh(at: number, now: number): boolean {
    return at > 0 && now - at < FRESH_MS;
  }

  function faceTracked(now: number): boolean {
    if (viewer && fresh(viewerAt, now) && viewer.eye_source !== 'none') return true;
    const nose = deps.feed.raw.data.body_pose[0];
    return fresh(deps.feed.raw.lastUpdate, now) && (nose?.[2] ?? 0) > 0.5;
  }

  function stopPolling(): void {
    stopPoll?.();
    stopPoll = null;
  }

  function stopCameraPreview(): void {
    colorSub?.unsubscribe();
    colorSub = null;
    frame = null;
  }

  // -- the snapshot the control window draws ----------------------------------

  function live(): Live {
    const now = performance.now();
    return {
      busy,
      message,
      formValues,
      formErrors,
      eye: measured?.eye ?? 'right',
      storedLens: projection.lens,
      lensProgress: lensProgress?.progress ?? 0,
      lensViews: lensProgress?.views ?? 0,
      lensHint: lensHint(lensProgress?.hint ?? 'more_views'),
      boardSeen: board !== null && board.detected && fresh(boardAt, now),
      boardDistanceMm: board?.distance_mm ?? null,
      ambiguityMm: board?.ambiguity_mm ?? null,
      faceTracked: faceTracked(now),
      viewer: viewer && fresh(viewerAt, now) ? viewer : null,
      holdoutMeanMm: solved?.holdout?.mean_mm ?? null,
      countdown,
    };
  }

  function status(): WizardStatus {
    return buildStatus(phase, live());
  }

  /**
   * Sends the snapshot when it says something new. The readings move with
   * every camera frame, so this compares before it publishes rather than
   * filling the channel at the frame rate.
   */
  function publish(): void {
    const snapshot = JSON.stringify(status());
    if (snapshot === published) return;
    published = snapshot;
    rt.events.emit(STATUS_TOPIC, JSON.parse(snapshot)).catch((err: unknown) => {
      warn('telling the control window where the run is', err);
    });
  }

  // -- the measurement form ---------------------------------------------------

  function openForm(): void {
    const previous = projection.profile;
    formValues = measureDefaults(
      previous?.measurements ?? null,
      measured?.ipdMm ?? DEFAULT_OPERATOR_IPD_MM,
      measured?.eye ?? 'right',
    );
    formErrors = [];
  }

  async function submitMeasurements(values: MeasureValues): Promise<void> {
    if (phase.kind !== 'measure') return;
    const token = run;
    formValues = values;
    const parsed = parseMeasurements(values);
    if (!parsed.ok) {
      formErrors = parsed.errors;
      publish();
      return;
    }
    formErrors = [];
    measured = parsed.value;
    try {
      await rt.drivers.execute('mirror_calibration', 'configure', {
        ipd_mm: parsed.value.ipdMm,
        eye: parsed.value.eye,
        lens,
      });
    } catch (err) {
      warn('configuring the calibration driver', err);
    }
    if (token !== run) return;
    if (projection.lens) setPhase({ kind: 'lens-choice' });
    else void startLensCapture();
  }

  // -- the lens ---------------------------------------------------------------

  async function startLensCapture(): Promise<void> {
    const token = run;
    // A retry after a failed solve must not leave a second frame listener.
    stopCameraPreview();
    setPhase({ kind: 'lens-capture' });
    lensProgress = null;
    lensSolving = false;
    try {
      await rt.drivers.execute('mirror_calibration', 'set_stage', { stage: 'lens' });
      if (token !== run) return;
      await rt.drivers.execute('mirror_calibration', 'reset_lens');
    } catch (err) {
      warn('starting the lens capture', err);
      say(rejectionMessage(err));
      return;
    }
    if (token !== run || phase.kind !== 'lens-capture') return;
    // The JPEG stream is only encoded while somebody listens, so it is taken
    // for this phase alone.
    colorSub = rt.drivers.on('camera', 'color', (payload) => {
      if (phase.kind !== 'lens-capture') return;
      ui.decodeFrame(payload.jpeg_base64, (decoded) => {
        if (phase.kind === 'lens-capture') frame = decoded;
      });
    });
  }

  async function solveLens(): Promise<void> {
    const token = run;
    lensSolving = true;
    try {
      const result = await rt.drivers.execute('mirror_calibration', 'solve_lens');
      if (token !== run) return;
      lens = result.lens;
      stopCameraPreview();
      setPhase({
        kind: 'lens-result',
        rmsPx: result.rms_px,
        hfovDeg: result.hfov_deg,
        views: result.views,
      });
      const stored = await projection.saveLens({ lens: result.lens, updatedAt: Date.now() });
      if (!stored) return;
      rt.log.info('calibrate: lens saved', { rms_px: result.rms_px, views: result.views });
    } catch (err) {
      if (token !== run) return;
      warn('solving the lens', err);
      setPhase({ kind: 'lens-failed' });
      say(rejectionMessage(err));
    } finally {
      lensSolving = false;
    }
  }

  function reuseLens(): void {
    const stored = projection.lens;
    if (!stored) {
      void startLensCapture();
      return;
    }
    lens = stored.lens;
    void beginAlign();
  }

  // -- alignment --------------------------------------------------------------

  async function beginAlign(): Promise<void> {
    const token = run;
    stopCameraPreview();
    captured.clear();
    solved = null;
    try {
      await rt.drivers.execute('mirror_calibration', 'set_stage', { stage: 'align' });
      if (token !== run) return;
      await rt.drivers.execute('mirror_calibration', 'clear_alignments');
    } catch (err) {
      warn('starting the alignment', err);
      say(rejectionMessage(err));
      return;
    }
    if (token !== run) return;
    startRound(FIT_ROUNDS[0]);
  }

  function startRound(round: Round): void {
    stopPolling();
    setPhase({
      kind: 'align',
      round,
      targets: [],
      index: 0,
      eyeDistanceMm: null,
      reachable: 0,
      reason: null,
      startedAt: performance.now(),
    });
    void pollTargets();
    stopPoll = ui.every(POLL_MS, () => void pollTargets());
  }

  /**
   * Asks the driver which targets the operator could cover from where they
   * stand, and plans the round's targets from the answer. Before a face has
   * been seen the driver answers that none are reachable, so this keeps
   * asking.
   */
  async function pollTargets(): Promise<void> {
    if (phase.kind !== 'align') return;
    const token = run;
    const grid = candidateGrid();
    const canvas = physical();
    let result;
    try {
      result = await rt.drivers.execute('mirror_calibration', 'suggest_targets', {
        candidates_px: grid.map((candidate) => [candidate.x, candidate.y]),
        canvas_px: [...CANVAS_PX],
        width_mm: canvas.width_mm,
        height_mm: canvas.height_mm,
        gap_mm: gapMm(),
        rig: solved?.rig ?? null,
      });
    } catch (err) {
      warn('asking for reachable targets', err);
      return;
    }
    const current = phase;
    if (token !== run || current.kind !== 'align') return;

    current.eyeDistanceMm = result.eye_distance_mm;
    current.reason = result.reason ?? null;
    const holds = new Map<string, Hold>();
    const reachable: Candidate[] = [];
    for (const [index, suggestion] of result.targets.entries()) {
      const candidate = grid[index];
      if (!candidate || !suggestion.reachable) continue;
      reachable.push(candidate);
      holds.set(key(candidate), suggestion.hold);
    }
    current.reachable = reachable.length;

    if (current.targets.length > 0) {
      // Keep the instructions honest as the operator moves.
      for (const target of current.targets) {
        const hold = holds.get(key(target.candidate));
        if (hold !== undefined) target.hold = hold;
      }
      publish();
      return;
    }
    if (reachable.length >= current.round.count) {
      const waited = performance.now() - current.startedAt > DISTANCE_GRACE_MS;
      if (withinBand(current.round, result.eye_distance_mm) || waited) {
        const taken = [...captured.values()].map((entry) => entry.target.candidate);
        current.targets = chooseSpreadTargets(reachable, current.round.count, taken).map(
          (candidate) => ({ candidate, hold: holds.get(key(candidate)) ?? null }),
        );
        current.index = 0;
      }
    }
    publish();
  }

  function key(candidate: Candidate): string {
    return `${candidate.col},${candidate.row}`;
  }

  async function capture(): Promise<void> {
    if (phase.kind !== 'align' || busy) return;
    const current = phase;
    const target = current.targets[current.index];
    if (!target) return;
    const token = run;
    busy = true;
    publish();
    try {
      const result = await rt.drivers.execute('mirror_calibration', 'capture_alignment', {
        target_px: [target.candidate.x, target.candidate.y],
        canvas_px: [...CANVAS_PX],
        holdout: current.round.holdout,
      });
      if (token !== run) return;
      captured.set(result.index, { target, round: current.round });
      // `eyeDistanceMm` is the distance in front of the mirror, as
      // `suggest_targets` reports it. The capture's own `eye_distance_mm` is
      // the range from the camera, a different number; the poll owns this one.
      message = '';
      advance(current);
    } catch (err) {
      if (token !== run) return;
      message = rejectionMessage(err);
      rt.log.warn('calibrate: alignment rejected', { err: String(err) });
    } finally {
      busy = false;
      publish();
    }
  }

  function advance(current: AlignPhase): void {
    current.index += 1;
    if (current.index < current.targets.length) return;
    stopPolling();
    if (current.round.key === 'near') startRound(FIT_ROUNDS[1]);
    else if (current.round.holdout) void solveRig('holdout');
    else void solveRig('fit');
  }

  /** Drops the last alignment of this round and goes back to its target. */
  async function back(): Promise<void> {
    if (phase.kind !== 'align' || busy) return;
    const current = phase;
    if (current.index === 0) return;
    const index = [...captured.entries()]
      .filter(([, entry]) => entry.round.key === current.round.key)
      .map(([id]) => id)
      .sort((a, b) => a - b)
      .at(-1);
    if (index === undefined) return;
    const token = run;
    busy = true;
    publish();
    try {
      await rt.drivers.execute('mirror_calibration', 'remove_alignment', { index });
      if (token !== run) return;
      captured.delete(index);
      current.index -= 1;
      message = 'That capture was dropped. Line the corner up again.';
    } catch (err) {
      if (token !== run) return;
      message = rejectionMessage(err);
    } finally {
      busy = false;
      publish();
    }
  }

  // -- the fit ----------------------------------------------------------------

  async function solveRig(stage: 'fit' | 'holdout'): Promise<void> {
    const token = run;
    stopPolling();
    setPhase({ kind: 'solving' });
    const canvas = physical();
    try {
      const result = await rt.drivers.execute('mirror_calibration', 'solve_rig', {
        width_mm: canvas.width_mm,
        height_mm: canvas.height_mm,
        gap_mm: gapMm(),
        camera_height_mm: measured?.measurements.camera_height_mm ?? null,
      });
      if (token !== run) return;
      solved = result;
      setPhase({ kind: 'result', stage, solve: result, report: fitReport(result) });
      rt.log.info('calibrate: rig fitted', {
        stage,
        quality: result.quality,
        rms_mm: result.rms_mm,
        predicted_error_mm: result.predicted_error_mm ?? -1,
      });
    } catch (err) {
      if (token !== run) return;
      warn('fitting the rig', err);
      setPhase({ kind: 'no-fit' });
      say(rejectionMessage(err));
    }
  }

  /** On from a result screen: to the holdout check, then to the verify screen. */
  async function continueFromResult(): Promise<void> {
    if (phase.kind !== 'result') return;
    const current = phase;
    if (!current.report || current.solve.quality === 'poor') return;
    const token = run;
    if (current.stage === 'holdout') {
      // The operator judges the rig, not the population prior the mirror draws
      // strangers with, so the check runs on their own pupil distance.
      try {
        await projection.preview({
          mode: 'reflection',
          rig: current.solve.rig,
          lens,
          trim_px: [0, 0],
          ipd_mm: measured?.ipdMm ?? DRIVER_IPD_MM,
        });
      } catch (err) {
        warn('previewing the fit', err);
      }
      if (token !== run) return;
      setPhase({ kind: 'verify', trim: [0, 0] });
      return;
    }
    try {
      await projection.preview({
        mode: 'reflection',
        rig: current.solve.rig,
        lens,
        trim_px: [0, 0],
      });
    } catch (err) {
      warn('applying the fitted rig', err);
    }
    if (token !== run) return;
    startRound(HOLDOUT_ROUND);
  }

  /** Four more targets at a third distance, when the fit came out poor. */
  function addRound(): void {
    if (phase.kind !== 'result' && phase.kind !== 'no-fit') return;
    startRound(EXTRA_ROUND);
  }

  /** Drops the sample the fit likes least and takes that target again. */
  async function redoWorst(): Promise<void> {
    if (phase.kind !== 'result' || busy) return;
    const index = worstSample(phase.solve);
    const entry = index === null ? undefined : captured.get(index);
    if (index === null || !entry) {
      say('No sample to redo. Add four more targets, or start over.');
      return;
    }
    const token = run;
    busy = true;
    stopPolling();
    try {
      await rt.drivers.execute('mirror_calibration', 'remove_alignment', { index });
      if (token !== run) return;
      captured.delete(index);
      setPhase({
        kind: 'align',
        round: { ...entry.round, key: 'redo', count: 1, title: 'One target again' },
        targets: [entry.target],
        index: 0,
        eyeDistanceMm: null,
        reachable: 1,
        reason: null,
        startedAt: performance.now(),
      });
      stopPoll = ui.every(POLL_MS, () => void pollTargets());
    } catch (err) {
      if (token !== run) return;
      say(rejectionMessage(err));
    } finally {
      busy = false;
    }
  }

  /** Starts the alignment again, keeping the measurements and the lens. */
  function startOver(): void {
    if (phase.kind !== 'result' && phase.kind !== 'no-fit' && phase.kind !== 'verify') return;
    if (phase.kind === 'verify') dropPreviewIpd();
    void beginAlign();
  }

  // -- verify and save --------------------------------------------------------

  function nudge(dx: number, dy: number): void {
    if (phase.kind !== 'verify') return;
    phase.trim = stepTrim(phase.trim, dx, dy);
    projection.preview({ trim_px: [...phase.trim] }).catch((err: unknown) => {
      warn('applying the trim', err);
    });
    publish();
  }

  /** Takes the operator's own pupil distance back off, whatever happens next. */
  function dropPreviewIpd(): void {
    projection.preview({ ipd_mm: DRIVER_IPD_MM }).catch((err: unknown) => {
      warn('putting the assumed pupil distance back', err);
    });
  }

  function save(): void {
    if (phase.kind !== 'verify' || !solved || !measured) return;
    const report = fitReport(solved);
    if (!report) return;
    const trim = phase.trim;
    const profile = buildRigProfile({
      rig: solved.rig,
      fit: report,
      measurements: measured.measurements,
      trim,
      updatedAt: Date.now(),
    });
    const token = run;
    const controller = new AbortController();
    saving = controller;
    setPhase({ kind: 'saving' });
    projection.saveCalibration(profile, controller.signal).then(
      (completed) => {
        if (!completed || token !== run) return;
        saving = null;
        saved = true;
        rt.log.info('calibrate: rig profile saved', {
          quality: report.quality,
          predicted_error_mm: report.predicted_error_mm,
        });
        finish({ ok: true });
      },
      (err: unknown) => {
        if (token !== run) return;
        warn('saving the profile', err);
        // Back to verify with the trim the operator had dialled in.
        setPhase({ kind: 'verify', trim: [trim[0], trim[1]] });
        say('Saving failed. Try again.');
      },
    );
  }

  function leave(): void {
    // Drop whatever is still in flight; the layer's stop puts the driver back.
    run += 1;
    saving?.abort();
    saving = null;
    stopPolling();
    stopCameraPreview();
    setPhase({ kind: 'leaving' });
    finish(CALIBRATION_CANCELLED);
  }

  function say(what: string): void {
    message = what;
    publish();
  }

  // -- the countdown ----------------------------------------------------------

  /**
   * A capture the operator asked for, a few seconds from now, for one working
   * alone with the keyboard on another display. The capture itself is the same
   * call as an immediate one: the driver averages the window that ends when it
   * arrives, so the sheet only has to be still at the end of the count.
   */
  function startCountdown(seconds: number): void {
    if (phase.kind !== 'align' || busy || !phase.targets[phase.index]) return;
    cancelCountdown();
    countdown = seconds;
    stopCountdown = ui.every(COUNTDOWN_MS, () => {
      if (countdown === null) return;
      countdown -= 1;
      if (countdown > 0) {
        publish();
        return;
      }
      cancelCountdown();
      void capture();
    });
    publish();
  }

  function cancelCountdown(): void {
    stopCountdown?.();
    stopCountdown = null;
    countdown = null;
  }

  // -- commands from the control window ---------------------------------------

  function onCommand(command: ControlCommand): void {
    // A countdown belongs to the moment it was started in. Anything the
    // operator does afterwards replaces it, rather than firing behind them.
    if (command.kind !== 'hello') cancelCountdown();
    switch (command.kind) {
      case 'hello':
        // A control window that just opened or reloaded knows nothing yet.
        published = '';
        publish();
        return;
      case 'submit-measurements':
        void submitMeasurements(command.values);
        return;
      case 'reuse-lens':
        if (phase.kind === 'lens-choice') reuseLens();
        return;
      case 'recalibrate-lens':
        if (phase.kind === 'lens-choice' || phase.kind === 'lens-failed') void startLensCapture();
        return;
      case 'capture':
        void capture();
        return;
      case 'capture-in':
        startCountdown(command.seconds);
        return;
      case 'undo':
        void back();
        return;
      case 'continue':
        if (phase.kind === 'lens-result') void beginAlign();
        else if (phase.kind === 'result') void continueFromResult();
        return;
      case 'add-targets':
        addRound();
        return;
      case 'redo-worst':
        void redoWorst();
        return;
      case 'restart':
        startOver();
        return;
      case 'trim':
        nudge(command.dx, command.dy);
        return;
      case 'save':
        save();
        return;
      case 'cancel':
        leave();
        return;
      default: {
        const exhaustive: never = command;
        throw new Error(`unhandled command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // -- the layer --------------------------------------------------------------

  return {
    start(): void {
      run += 1;
      saved = false;
      finished = false;
      published = '';
      openForm();
      phase = { kind: 'measure' };
      message = '';
      subscriptions.push(
        rt.drivers.on('mirror_calibration', 'board', (payload) => {
          board = payload;
          boardAt = performance.now();
        }),
        rt.drivers.on('mirror_calibration', 'lens_progress', (payload) => {
          lensProgress = payload;
          if (payload.accepted) acceptedAt = performance.now();
          if (payload.progress >= 1 && phase.kind === 'lens-capture' && !lensSolving) {
            void solveLens();
          }
        }),
        rt.drivers.on('pose_to_mirror', 'viewer', (payload) => {
          viewer = payload;
          viewerAt = performance.now();
        }),
      );
      commandSub = rt.events.on(COMMAND_TOPIC, (data) => {
        const command = parseCommand(data);
        if (command) onCommand(command);
      });
      projection.snapshot().catch((err: unknown) => {
        warn('reading the mirror settings', err);
      });
      stopHeartbeat = ui.every(STATUS_MS, publish);
      publish();
    },

    render({ ctx, viewport }): void {
      layout = {
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      };
      draw(ctx);
    },

    stop(): void {
      const abandoned = !saved;
      run += 1;
      saving?.abort();
      saving = null;
      cancelCountdown();
      stopPolling();
      stopCameraPreview();
      stopHeartbeat?.();
      stopHeartbeat = null;
      for (const subscription of subscriptions) subscription.unsubscribe();
      subscriptions.length = 0;
      commandSub?.unsubscribe();
      commandSub = null;
      // The driver detects nothing in `idle`, so it costs nothing once the
      // experience it belongs to is over. This happens on every path out.
      rt.drivers
        .execute('mirror_calibration', 'set_stage', { stage: 'idle' })
        .catch((err: unknown) => {
          warn('leaving the calibration stage', err);
        });
      if (!abandoned) return;
      rt.drivers
        .execute('mirror_calibration', 'clear_alignments')
        .catch((err: unknown) => warn('dropping the alignments', err));
      // This also puts the assumed pupil distance back, so a preview taken for
      // the operator can never outlive the run.
      projection.restore().catch((err: unknown) => {
        warn('restoring the projection', err);
      });
    },
  };

  // -- drawing ----------------------------------------------------------------

  function draw(ctx: CanvasRenderingContext2D): void {
    const snapshot = status();
    if (snapshot.phase === 'verify') {
      drawBody(ctx, deps.feed.mirror.data.body_pose, {
        color: GREEN,
        weight: 5,
        minVisibility: 0.5,
        showHead: true,
      });
    }
    const current = phase;
    const target =
      current.kind === 'align' ? (current.targets[current.index]?.candidate ?? null) : null;
    renderScreen(ctx, {
      status: snapshot,
      target,
      camera:
        current.kind === 'lens-capture'
          ? {
              frame,
              hull: board?.hull_px ?? [],
              detected: board?.detected ?? false,
              flash: Math.max(0, 1 - (performance.now() - acceptedAt) / FLASH_MS),
            }
          : null,
    });
  }
}
