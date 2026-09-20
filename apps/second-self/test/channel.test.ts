import { describe, expect, test } from 'bun:test';
import {
  TIMED_CAPTURE_SECONDS,
  parseCommand,
  parseStatus,
  type WizardStatus,
} from '../src/calibration/channel.js';
import { TRIM_FAST_STEP_PX, TRIM_STEP_PX, commandForKey } from '../src/calibration/keys.js';
import { FIT_ROUNDS } from '../src/calibration/wizard/plan.js';
import { buildStatus, type Live } from '../src/calibration/wizard/status.js';

const LIVE: Live = {
  busy: false,
  message: '',
  formValues: { gap_mm: '5' },
  formErrors: ['Active screen width (mm): enter a number between 100 and 3000'],
  eye: 'right',
  storedLens: null,
  lensProgress: 0,
  lensViews: 0,
  lensHint: 'Move the sheet',
  boardSeen: false,
  boardDistanceMm: null,
  ambiguityMm: null,
  faceTracked: false,
  viewer: null,
  holdoutMeanMm: null,
  countdown: null,
};

const ALIGN = buildStatus(
  {
    kind: 'align',
    round: FIT_ROUNDS[0],
    targets: [
      { candidate: { x: 200, y: 400, col: 0, row: 1 }, hold: 'corner_up' },
      { candidate: { x: 540, y: 900, col: 1, row: 3 }, hold: 'corner_up' },
    ],
    index: 1,
    eyeDistanceMm: 940,
    reachable: 12,
    reason: null,
    startedAt: 0,
  },
  { ...LIVE, boardSeen: true, boardDistanceMm: 620, faceTracked: true },
);

const VERIFY = buildStatus({ kind: 'verify', trim: [2, -3] }, LIVE);

/** What `rt.events` does to a payload on the way to the other window. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('commands from the control window', () => {
  test('takes the plain ones and refuses anything else', () => {
    expect(parseCommand({ kind: 'capture' })).toEqual({ kind: 'capture' });
    expect(parseCommand({ kind: 'hello' })).toEqual({ kind: 'hello' });
    expect(parseCommand({ kind: 'launch-the-missiles' })).toBeNull();
    expect(parseCommand({ action: 'confirm' })).toBeNull();
    expect(parseCommand(null)).toBeNull();
    expect(parseCommand('capture')).toBeNull();
    expect(parseCommand(['capture'])).toBeNull();
  });

  test('takes the measurements as strings, and only as strings', () => {
    const values = { screen_width_mm: '392.85', eye: 'left' };
    expect(parseCommand({ kind: 'submit-measurements', values })).toEqual({
      kind: 'submit-measurements',
      values,
    });
    expect(parseCommand({ kind: 'submit-measurements' })).toBeNull();
    expect(parseCommand({ kind: 'submit-measurements', values: { gap_mm: 5 } })).toBeNull();
  });

  test('bounds the countdown and the trim step', () => {
    expect(parseCommand({ kind: 'capture-in', seconds: 5 })).toEqual({
      kind: 'capture-in',
      seconds: 5,
    });
    expect(parseCommand({ kind: 'capture-in', seconds: 0 })).toBeNull();
    expect(parseCommand({ kind: 'capture-in', seconds: 600 })).toBeNull();
    expect(parseCommand({ kind: 'capture-in' })).toBeNull();
    expect(parseCommand({ kind: 'trim', dx: -5, dy: 1 })).toEqual({ kind: 'trim', dx: -5, dy: 1 });
    expect(parseCommand({ kind: 'trim', dx: 1 })).toBeNull();
    expect(parseCommand({ kind: 'trim', dx: 1e6, dy: 0 })).toBeNull();
    expect(parseCommand({ kind: 'trim', dx: Number.NaN, dy: 0 })).toBeNull();
  });
});

describe('the status the mirror publishes', () => {
  test('survives the trip to the other window', () => {
    for (const status of [ALIGN, VERIFY, buildStatus({ kind: 'measure' }, LIVE)]) {
      expect(parseStatus(overTheWire(status))).toEqual(status);
    }
  });

  test('refuses a snapshot that is not one of ours', () => {
    const broken: unknown[] = [
      null,
      { ...ALIGN, phase: 'daydreaming' },
      { ...ALIGN, title: 42 },
      { ...ALIGN, lines: 'one line' },
      { ...ALIGN, lines: [1, 2] },
      { ...ALIGN, readings: [{ label: 'sheet', value: 'seen' }] },
      {
        ...ALIGN,
        actions: [{ command: 'hello', label: 'x', enabled: true, primary: false, key: '' }],
      },
      {
        ...ALIGN,
        actions: [{ command: 'capture', label: 'x', enabled: 'yes', primary: false, key: '' }],
      },
      { ...ALIGN, headline: { text: 'x', tone: 'lovely' } },
      { ...ALIGN, progress: { done: 1, total: 'four', label: 'x' } },
      { ...ALIGN, countdown: 'soon' },
      { ...VERIFY, trim: [1] },
      { ...ALIGN, form: { values: { gap_mm: 5 }, errors: [] } },
    ];
    for (const value of broken) expect(parseStatus(overTheWire(value))).toBeNull();
  });
});

describe('the control window keyboard', () => {
  const press = (code: string, over: Partial<Parameters<typeof commandForKey>[0]> = {}) =>
    commandForKey({ code, shift: false, repeat: false, inFormField: false, ...over }, ALIGN);

  test('sends the primary action of the phase', () => {
    for (const code of ['Space', 'Enter', 'NumpadEnter', 'PageDown']) {
      expect(press(code)).toEqual({ kind: 'capture' });
    }
    expect(press('KeyZ')).toBeNull();
  });

  test('T starts the countdown and Backspace drops the last capture', () => {
    expect(press('KeyT')).toEqual({ kind: 'capture-in', seconds: TIMED_CAPTURE_SECONDS });
    expect(press('Backspace')).toEqual({ kind: 'undo' });
  });

  test('offers nothing the phase does not, and nothing before the first snapshot', () => {
    const nothingPlanned = buildStatus(
      {
        kind: 'align',
        round: FIT_ROUNDS[0],
        targets: [],
        index: 0,
        eyeDistanceMm: null,
        reachable: 0,
        reason: 'no_face',
        startedAt: 0,
      },
      LIVE,
    );
    const key = { code: 'Space', shift: false, repeat: false, inFormField: false };
    expect(commandForKey(key, nothingPlanned)).toBeNull();
    expect(commandForKey({ ...key, code: 'KeyT' }, nothingPlanned)).toBeNull();
    expect(commandForKey({ ...key, code: 'Backspace' }, VERIFY)).toBeNull();
    expect(commandForKey(key, null)).toBeNull();
    // Escape always ends the run, even before the mirror has said anything.
    expect(commandForKey({ ...key, code: 'Escape' }, null)).toEqual({ kind: 'cancel' });
  });

  test('the arrows trim on the verify screen and nowhere else', () => {
    const arrow = (code: string, shift: boolean, status: WizardStatus | null) =>
      commandForKey({ code, shift, repeat: false, inFormField: false }, status);
    expect(arrow('ArrowLeft', false, VERIFY)).toEqual({
      kind: 'trim',
      dx: -TRIM_STEP_PX,
      dy: 0,
    });
    expect(arrow('ArrowDown', true, VERIFY)).toEqual({
      kind: 'trim',
      dx: 0,
      dy: TRIM_FAST_STEP_PX,
    });
    expect(arrow('ArrowUp', false, ALIGN)).toBeNull();
  });

  test('a held key is one press, and the form keeps its own keyboard', () => {
    expect(press('Space', { repeat: true })).toBeNull();
    expect(press('Space', { inFormField: true })).toBeNull();
    expect(press('Escape', { inFormField: true })).toBeNull();
  });
});
