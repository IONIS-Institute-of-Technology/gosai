import { describe, expect, test } from 'bun:test';
import type { CalibrationResult, DriverTypes } from '@gosai/sdk';
import {
  COMMAND_TOPIC,
  STATUS_TOPIC,
  parseStatus,
  type ControlCommand,
  type WizardStatus,
} from '../src/calibration/channel.js';
import { createMirrorWizard } from '../src/calibration/wizard.js';
import type { CameraFrame } from '../src/calibration/wizard/render.js';
import type { WizardUi } from '../src/calibration/wizard/ui.js';
import { LENS_PROFILE_KEY } from '../src/shared/calibration.js';
import {
  DEFAULT_CONFIG,
  DRIVER_IPD_MM,
  mergeConfig,
  type StoredLens,
} from '../src/shared/config.js';
import { createMirrorFeed } from '../src/shared/feed.js';
import { Projection } from '../src/shared/projection.js';
import type { Layer } from '../src/shared/types.js';
import { FakeRuntime, type DriverResponder } from './fakes.js';

const REFLECTION = mergeConfig(DEFAULT_CONFIG, { projection: { mode: 'reflection' } });

const LENS: StoredLens = {
  lens: { width: 1280, height: 720, fx: 900, fy: 900, cx: 640, cy: 360, dist: [], rms_px: 0.3 },
  updatedAt: 3,
};

/** What the operator types in the control window. */
const MEASURED: Readonly<Record<string, string>> = {
  screen_width_mm: '392.85',
  screen_height_mm: '698.4',
  gap_mm: '5',
  camera_height_mm: '1700',
  ipd_mm: '64',
  eye: 'right',
};

const MEASUREMENTS = {
  screen_width_mm: 392.85,
  screen_height_mm: 698.4,
  gap_mm: 5,
  camera_height_mm: 1700,
};

const RIG = {
  rotation: [0, 0.1, 0],
  center_mm: [0, -40, 1200],
  width_mm: 392.85,
  height_mm: 698.4,
  gap_mm: 5,
  camera_height_mm: 1700,
  iris_mm: 12.32,
};

const DRIVER_SETTINGS = { mode: 'reflection', rig: null, lens: null, trim_px: [0, 0], ipd_mm: 63 };

/** The two periods the wizard ticks on: the countdown and the status refresh. */
const COUNTDOWN_MS = 1000;
const STATUS_MS = 250;

/** The browser pieces of the wizard, recorded and stepped instead of run. */
class FakeUi implements WizardUi {
  decoded = 0;
  readonly tickers: { ms: number; tick: () => void }[] = [];

  decodeFrame(_jpegBase64: string, _ready: (frame: CameraFrame) => void): void {
    // Nothing to decode without a browser; the wizard only draws the result.
    this.decoded += 1;
  }

  every(ms: number, tick: () => void): () => void {
    const entry = { ms, tick };
    this.tickers.push(entry);
    return () => {
      const index = this.tickers.indexOf(entry);
      if (index >= 0) this.tickers.splice(index, 1);
    };
  }

  /** Fires every ticker of that period once, as the clock would. */
  step(ms: number): void {
    // Over a copy: a ticker may stop itself, as the countdown does.
    for (const entry of this.tickers.slice()) if (entry.ms === ms) entry.tick();
  }
}

interface Harness {
  readonly fake: FakeRuntime;
  readonly ui: FakeUi;
  readonly wizard: Layer;
  readonly projection: Projection;
  readonly finished: CalibrationResult[];
  /** What the driver answers `suggest_targets` with. */
  eyeDistance: number | null;
  /** Rejects the next capture with this message. */
  rejectNext: string | null;
  /** What `suggest_targets` answers; anything but null makes every target unreachable. */
  reason: Reason;
  solves: number;
}

type Reason = DriverTypes.mirror_calibration.SuggestTargetsResult['reason'];

interface HarnessState {
  eyeDistance: number | null;
  rejectNext: string | null;
  reason: Reason;
  solves: number;
}

function harness(options: { readonly lens?: StoredLens | null } = {}): Harness {
  const state: HarnessState = { eyeDistance: 900, rejectNext: null, reason: null, solves: 0 };
  let nextIndex = 0;
  let samples = 0;
  let holdouts = 0;

  const suggest: DriverResponder = (params) => ({
    targets: candidates(params).map((target) => ({
      target_px: target,
      reachable: state.reason === null,
      hold: 'corner_up',
    })),
    eye_distance_mm: state.eyeDistance,
    reason: state.reason,
  });

  const capture: DriverResponder = (params) => {
    if (state.rejectNext !== null) {
      const message = state.rejectNext;
      state.rejectNext = null;
      throw new Error(message);
    }
    if (isRecord(params) && params['holdout'] === true) holdouts += 1;
    else samples += 1;
    return {
      index: nextIndex++,
      samples,
      holdouts,
      point_mm: [0, 0, 1000],
      eye_mm: [0, 0, 1000],
      board_spread_mm: 1,
      eye_spread_mm: 2,
      board_distance_mm: 1000,
      eye_distance_mm: state.eyeDistance ?? 1000,
    };
  };

  const solveRig: DriverResponder = () => {
    state.solves += 1;
    return {
      rig: RIG,
      rms_mm: 2.4,
      residuals_mm: Array.from({ length: samples }, (_, index) => ({ index, error_mm: 2 + index })),
      predicted_error_mm: 9.5,
      condition: 120,
      quality: 'good',
      tilt_deg: -12,
      camera_in_screen_mm: [-10, -410, -30],
      distances_mm: [900, 1500],
      holdout:
        holdouts === 0 ? null : { count: holdouts, mean_mm: 8.25, max_mm: 12.5, residuals_mm: [] },
      // What the operator's irises read through this camera, shrunk into RIG.
      iris: { apparent_mm: 12.6, near_mm: 12.55, far_mm: 12.65, samples: 10 },
    };
  };

  const fake = new FakeRuntime({
    driver: { ...DRIVER_SETTINGS },
    responses: {
      'mirror_calibration.configure': () => ({
        lens: null,
        hfov_deg: 60,
        ipd_mm: 64,
        eye: 'right',
      }),
      'mirror_calibration.set_stage': (params) => params,
      'mirror_calibration.reset_lens': () => null,
      'mirror_calibration.clear_alignments': () => ({ samples: 0, holdouts: 0 }),
      'mirror_calibration.remove_alignment': () => ({ samples: --samples, holdouts }),
      'mirror_calibration.suggest_targets': suggest,
      'mirror_calibration.capture_alignment': capture,
      'mirror_calibration.solve_rig': solveRig,
      'mirror_calibration.solve_lens': () => ({
        lens: LENS.lens,
        rms_px: 0.42,
        views: 14,
        hfov_deg: 71,
      }),
    },
  });

  const projection = new Projection(fake.rt, REFLECTION, null, options.lens ?? null);
  const ui = new FakeUi();
  const finished: CalibrationResult[] = [];
  const wizard = createMirrorWizard({
    rt: fake.rt,
    feed: createMirrorFeed(),
    projection,
    finish: (result) => void finished.push(result),
    ui,
  });
  return {
    fake,
    ui,
    wizard,
    projection,
    finished,
    get eyeDistance(): number | null {
      return state.eyeDistance;
    },
    set eyeDistance(value: number | null) {
      state.eyeDistance = value;
    },
    get rejectNext(): string | null {
      return state.rejectNext;
    },
    set rejectNext(value: string | null) {
      state.rejectNext = value;
    },
    get reason(): Reason {
      return state.reason;
    },
    set reason(value: Reason) {
      state.reason = value;
    },
    get solves(): number {
      return state.solves;
    },
  };
}

function candidates(params: unknown): number[][] {
  if (!isRecord(params)) return [];
  const list = params['candidates_px'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => (Array.isArray(entry) ? [entry.map(Number)] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Lets every promise the wizard is waiting on settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Sends a command, as the control window would. */
async function send(h: Harness, command: ControlCommand): Promise<void> {
  h.fake.emitApp(COMMAND_TOPIC, JSON.parse(JSON.stringify(command)));
  await tick();
}

/** The latest snapshot the control window would be drawing. */
function status(h: Harness): WizardStatus {
  const last = h.fake.emitted.filter((entry) => entry.topic === STATUS_TOPIC).at(-1);
  const parsed = parseStatus(last?.data);
  if (!parsed) throw new Error('the mirror published no usable status');
  return parsed;
}

function mirrorConfigs(h: Harness): unknown[] {
  return h.fake.callsTo('pose_to_mirror', 'set_mirror_config');
}

/** Measures, reuses the stored lens and lands on the first alignment round. */
async function toAlignment(h: Harness): Promise<void> {
  h.wizard.start?.();
  await send(h, { kind: 'submit-measurements', values: MEASURED });
  await send(h, { kind: 'reuse-lens' });
}

describe('the mirror wizard', () => {
  test('binds nothing on the mirror: the whole run arrives over the events topic', async () => {
    // There is no document in this test, so a wizard that reached for one
    // would throw rather than quietly listen for keys nobody can press.
    expect(Reflect.get(globalThis, 'document')).toBeUndefined();
    const h = harness({ lens: LENS });
    await toAlignment(h);
    await send(h, { kind: 'capture' });
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(1);
    h.wizard.stop?.();
  });

  test('measures, reuses the lens and starts the alignment', async () => {
    const h = harness({ lens: LENS });
    h.wizard.start?.();
    expect(status(h).phase).toBe('measure');
    expect(status(h).form?.values).toMatchObject({ gap_mm: '5', ipd_mm: '63' });

    await send(h, { kind: 'submit-measurements', values: MEASURED });
    // The operator's pupil distance is the driver's for this run, not a setting.
    expect(h.fake.settings).toEqual([]);
    expect(h.fake.callsTo('mirror_calibration', 'configure')).toEqual([
      { ipd_mm: 64, eye: 'right', lens: LENS.lens },
    ]);
    // The lens is offered again rather than captured a second time.
    expect(status(h).phase).toBe('lens-choice');
    expect(h.fake.callsTo('mirror_calibration', 'set_stage')).toEqual([]);

    await send(h, { kind: 'reuse-lens' });
    expect(h.fake.callsTo('mirror_calibration', 'set_stage')).toEqual([{ stage: 'align' }]);
    expect(h.fake.callsTo('mirror_calibration', 'clear_alignments')).toHaveLength(1);
    const [suggest] = h.fake.callsTo('mirror_calibration', 'suggest_targets');
    expect(suggest).toMatchObject({
      canvas_px: [1080, 1920],
      width_mm: 392.85,
      height_mm: 698.4,
      gap_mm: 5,
      rig: null,
    });
    h.wizard.stop?.();
  });

  test('sends the form back with its errors, and stays on the measurements', async () => {
    const h = harness({ lens: LENS });
    h.wizard.start?.();
    await send(h, {
      kind: 'submit-measurements',
      values: { ...MEASURED, screen_width_mm: '20' },
    });
    const shown = status(h);
    expect(shown.phase).toBe('measure');
    expect(shown.form?.errors).toHaveLength(1);
    expect(shown.form?.values['screen_width_mm']).toBe('20');
    expect(h.fake.callsTo('mirror_calibration', 'configure')).toEqual([]);
    h.wizard.stop?.();
  });

  test('captures eight alignments over two distances, then fits', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);

    for (let i = 0; i < 4; i++) {
      if (i === 3) h.eyeDistance = 1500;
      await send(h, { kind: 'capture' });
    }
    const first = h.fake.callsTo('mirror_calibration', 'capture_alignment');
    expect(first).toHaveLength(4);
    expect(first.every((params) => isRecord(params) && params['holdout'] === false)).toBe(true);
    // Four different targets, spread over four rows of the canvas.
    const ys = first.map((params) => targetOf(params)[1]);
    expect(new Set(ys).size).toBe(4);
    expect(h.fake.callsTo('mirror_calibration', 'solve_rig')).toHaveLength(0);

    for (let i = 0; i < 4; i++) {
      if (i === 3) h.eyeDistance = 1200;
      await send(h, { kind: 'capture' });
    }
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(8);
    // The camera height goes to the fit, which carries it into the rig.
    expect(h.fake.callsTo('mirror_calibration', 'solve_rig')).toEqual([
      { width_mm: 392.85, height_mm: 698.4, gap_mm: 5, camera_height_mm: 1700 },
    ]);
    h.wizard.stop?.();
  });

  test('tells the operator why the driver could test no target', async () => {
    const blind = harness({ lens: LENS });
    blind.reason = 'no_face';
    await toAlignment(blind);
    expect(status(blind).lines).toContain('Face the camera so your face is tracked.');
    blind.wizard.stop?.();

    const close = harness({ lens: LENS });
    close.reason = 'too_close';
    await toAlignment(close);
    expect(status(close).lines.join(' ')).toContain(
      'Step back: there is no room to hold the board in front of you.',
    );
    close.wizard.stop?.();
  });

  test('stays on the target the driver refused, and says why', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    await send(h, { kind: 'capture' });
    const before = targetOf(h.fake.callsTo('mirror_calibration', 'capture_alignment').at(-1));

    h.rejectNext = 'unstable_board: the board moved 9.1 mm during the last 600 ms';
    await send(h, { kind: 'capture' });
    expect(status(h).message).toBe('The sheet moved. Hold it still, then confirm again.');
    await send(h, { kind: 'capture' });
    const calls = h.fake.callsTo('mirror_calibration', 'capture_alignment');
    expect(calls).toHaveLength(3);
    // The refused target is asked for again; the one before it is not repeated.
    expect(targetOf(calls[1])).toEqual(targetOf(calls[2]));
    expect(targetOf(calls[1])).not.toEqual(before);
    h.wizard.stop?.();
  });

  test('drops the last capture on undo and asks for that target again', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    await send(h, { kind: 'capture' });
    await send(h, { kind: 'capture' });
    const second = targetOf(h.fake.callsTo('mirror_calibration', 'capture_alignment').at(-1));

    await send(h, { kind: 'undo' });
    expect(h.fake.callsTo('mirror_calibration', 'remove_alignment')).toEqual([{ index: 1 }]);
    await send(h, { kind: 'capture' });
    expect(targetOf(h.fake.callsTo('mirror_calibration', 'capture_alignment').at(-1))).toEqual(
      second,
    );
    h.wizard.stop?.();
  });

  test('ignores a command the phase does not offer', async () => {
    const h = harness({ lens: LENS });
    h.wizard.start?.();
    // Nothing has been measured, so there is nothing to capture, save or trim.
    for (const command of [
      { kind: 'capture' },
      { kind: 'undo' },
      { kind: 'save' },
      { kind: 'trim', dx: 5, dy: 0 },
      { kind: 'redo-worst' },
      { kind: 'continue' },
      { kind: 'restart' },
    ] as const) {
      await send(h, command);
    }
    expect(h.fake.executed.filter((call) => call.driver === 'mirror_calibration')).toEqual([]);
    expect(status(h).phase).toBe('measure');

    await toAlignment(h);
    // Mid-alignment, a save or a reused lens is not what the operator meant.
    await send(h, { kind: 'save' });
    await send(h, { kind: 'reuse-lens' });
    expect(status(h).phase).toBe('align');
    expect(h.fake.profile).toBeNull();
    h.wizard.stop?.();
  });

  test('a timed capture fires once, and any other command calls it off', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    await send(h, { kind: 'capture-in', seconds: 3 });
    expect(status(h).countdown).toBe(3);
    h.ui.step(COUNTDOWN_MS);
    h.ui.step(COUNTDOWN_MS);
    expect(status(h).countdown).toBe(1);
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(0);
    h.ui.step(COUNTDOWN_MS);
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(1);
    expect(status(h).countdown).toBeNull();
    // The timer is gone, so it cannot fire a second capture behind the operator.
    h.ui.step(COUNTDOWN_MS);
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(1);

    await send(h, { kind: 'capture-in', seconds: 5 });
    await send(h, { kind: 'undo' });
    expect(status(h).countdown).toBeNull();
    h.ui.step(COUNTDOWN_MS);
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'capture_alignment')).toHaveLength(1);
    h.wizard.stop?.();
  });

  test('answers a control window that opens or reloads mid-run', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    const before = h.fake.emitted.filter((entry) => entry.topic === STATUS_TOPIC).length;
    await send(h, { kind: 'hello' });
    const after = h.fake.emitted.filter((entry) => entry.topic === STATUS_TOPIC).length;
    expect(after).toBe(before + 1);
    expect(status(h).phase).toBe('align');
    h.wizard.stop?.();
  });

  test('checks the fit on targets it never used, then trims and saves', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    for (let i = 0; i < 8; i++) {
      if (i === 3) h.eyeDistance = 1500;
      if (i === 7) h.eyeDistance = 1200;
      await send(h, { kind: 'capture' });
    }
    expect(h.solves).toBe(1);
    expect(status(h).phase).toBe('fit');

    // On from the fit: the rig is previewed and three holdout targets follow.
    await send(h, { kind: 'continue' });
    expect(mirrorConfigs(h).at(-1)).toEqual({
      mode: 'reflection',
      rig: RIG,
      lens: LENS.lens,
      trim_px: [0, 0],
    });
    for (let i = 0; i < 3; i++) await send(h, { kind: 'capture' });
    const captures = h.fake.callsTo('mirror_calibration', 'capture_alignment');
    expect(captures).toHaveLength(11);
    expect(captures.slice(8).every((p) => isRecord(p) && p['holdout'] === true)).toBe(true);
    expect(h.solves).toBe(2);
    expect(status(h).phase).toBe('holdout');

    // On to the verify screen, which draws for the operator's own eyes so that
    // what they judge is the rig rather than the prior every visitor gets.
    await send(h, { kind: 'continue' });
    expect(mirrorConfigs(h).at(-1)).toMatchObject({ ipd_mm: 64, rig: RIG });
    expect(status(h).phase).toBe('verify');

    await send(h, { kind: 'trim', dx: -1, dy: 0 });
    await send(h, { kind: 'trim', dx: 0, dy: 5 });
    expect(mirrorConfigs(h).at(-1)).toEqual({ trim_px: [-1, 5] });
    expect(status(h).trim).toEqual([-1, 5]);

    await send(h, { kind: 'save' });
    expect(h.finished).toEqual([{ ok: true }]);
    expect(h.fake.profile?.data).toMatchObject({
      version: 2,
      rig: RIG,
      trim_px: [-1, 5],
      measurements: MEASUREMENTS,
      fit: {
        rms_mm: 2.4,
        predicted_error_mm: 9.5,
        quality: 'good',
        samples: 8,
        holdout_mean_mm: 8.25,
        holdout_max_mm: 12.5,
      },
    });
    // Saving draws for the public again: the operator's pupils go no further.
    expect(mirrorConfigs(h).at(-1)).toMatchObject({ ipd_mm: DRIVER_IPD_MM, trim_px: [-1, 5] });

    // A saved run leaves the alignments alone and only idles the driver.
    h.wizard.stop?.();
    expect(h.fake.callsTo('mirror_calibration', 'set_stage').at(-1)).toEqual({ stage: 'idle' });
    expect(h.fake.callsTo('mirror_calibration', 'clear_alignments')).toHaveLength(1);
  });

  test('cancelling drops the run and puts the saved projection back', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    await send(h, { kind: 'capture' });
    await send(h, { kind: 'cancel' });
    expect(h.finished).toEqual([{ ok: false, cancelled: true, error: 'Calibration cancelled' }]);

    h.wizard.stop?.();
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'set_stage').at(-1)).toEqual({ stage: 'idle' });
    expect(h.fake.callsTo('mirror_calibration', 'clear_alignments')).toHaveLength(2);
    expect(mirrorConfigs(h).at(-1)).toMatchObject({
      mode: 'reflection',
      rig: null,
      ipd_mm: DRIVER_IPD_MM,
    });
    // Nothing is left ticking or listening once the experience is over.
    expect(h.ui.tickers).toEqual([]);
    expect(h.fake.subscribed('camera', 'color')).toBe(0);
    expect(h.fake.subscribed('mirror_calibration', 'board')).toBe(0);
    expect(h.fake.listening(COMMAND_TOPIC)).toBe(0);
  });

  test('leaving the verify screen takes the operator pupil distance back off', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    for (let i = 0; i < 8; i++) {
      if (i === 3) h.eyeDistance = 1500;
      if (i === 7) h.eyeDistance = 1200;
      await send(h, { kind: 'capture' });
    }
    await send(h, { kind: 'continue' });
    for (let i = 0; i < 3; i++) await send(h, { kind: 'capture' });
    await send(h, { kind: 'continue' });
    expect(mirrorConfigs(h).at(-1)).toMatchObject({ ipd_mm: 64 });

    // Back to the alignment: the preview goes with it.
    await send(h, { kind: 'restart' });
    expect(mirrorConfigs(h)).toContainEqual({ ipd_mm: DRIVER_IPD_MM });
    expect(status(h).phase).toBe('align');
    h.wizard.stop?.();
  });

  test('calibrates the lens when none was saved, and keeps it apart from the profile', async () => {
    const h = harness({ lens: null });
    h.wizard.start?.();
    await send(h, { kind: 'submit-measurements', values: MEASURED });
    expect(h.fake.callsTo('mirror_calibration', 'configure')).toEqual([
      { ipd_mm: 64, eye: 'right', lens: null },
    ]);
    expect(h.fake.callsTo('mirror_calibration', 'set_stage')).toEqual([{ stage: 'lens' }]);
    expect(h.fake.callsTo('mirror_calibration', 'reset_lens')).toHaveLength(1);

    // The frames only flow while this phase runs.
    h.fake.emitDriver('camera', 'color', { jpeg_base64: 'abc', width: 1280, height: 720 });
    expect(h.ui.decoded).toBe(1);

    h.fake.emitDriver('mirror_calibration', 'lens_progress', {
      views: 8,
      coverage: 0.5,
      tilted_views: 2,
      progress: 0.6,
      hint: 'cover_edges',
      accepted: true,
      ts: 1,
    });
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'solve_lens')).toHaveLength(0);
    // The live readings ride the status heartbeat rather than every payload.
    h.ui.step(STATUS_MS);
    expect(status(h).progress).toMatchObject({ done: 60, label: '8 views kept' });

    h.fake.emitDriver('mirror_calibration', 'lens_progress', {
      views: 14,
      coverage: 0.9,
      tilted_views: 5,
      progress: 1,
      hint: 'ready',
      accepted: false,
      ts: 2,
    });
    await tick();
    expect(h.fake.callsTo('mirror_calibration', 'solve_lens')).toHaveLength(1);
    expect(h.fake.storage.get(LENS_PROFILE_KEY)).toMatchObject({ lens: LENS.lens });
    expect(h.fake.profile).toBeNull();
    // No more JPEG frames once the lens is solved.
    h.fake.emitDriver('camera', 'color', { jpeg_base64: 'abc', width: 1280, height: 720 });
    expect(h.ui.decoded).toBe(1);
    expect(h.fake.subscribed('camera', 'color')).toBe(0);

    await send(h, { kind: 'continue' });
    expect(h.fake.callsTo('mirror_calibration', 'set_stage').at(-1)).toEqual({ stage: 'align' });
    h.wizard.stop?.();
  });
});

describe('what the mirror draws', () => {
  test('writes the instructions of the phase it is in, and nothing to press', async () => {
    const h = harness({ lens: LENS });
    await toAlignment(h);
    const lines = drawnLines(h.wizard);
    expect(lines).toContain('Close your LEFT eye.');
    expect(lines).toContain('Put the reflection of the ORIGIN corner on the mark.');
    expect(lines).toContain('Every button and key is in the control window');
    h.wizard.stop?.();
  });
});

/**
 * Draws one frame of the wizard and returns every line it wrote. The context
 * only has to remember text; a window is faked because the wizard measures the
 * canvas against it to work out the physical size the reference pixels cover.
 */
function drawnLines(wizard: Layer): string[] {
  const lines: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === 'measureText'
          ? () => ({ width: 10 })
          : (value: unknown) => void (prop === 'fillText' && lines.push(String(value))),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  const previous = Reflect.get(globalThis, 'window');
  Reflect.set(globalThis, 'window', { innerWidth: 1080, innerHeight: 1920 });
  try {
    wizard.render?.({
      ctx,
      timestamp: 0,
      deltaMs: 16,
      viewport: { x: 0, y: 0, width: 1080, height: 1920 },
    });
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Reflect.set(globalThis, 'window', previous);
  }
  return lines;
}

function targetOf(params: unknown): number[] {
  if (!isRecord(params)) return [];
  const target = params['target_px'];
  return Array.isArray(target) ? target.map(Number) : [];
}
