/**
 * What the two calibration windows say to each other.
 *
 * The mirror display has no keyboard and no mouse, so the wizard runs on the
 * mirror and every button, field and shortcut lives in the control window
 * GOSAI opens on another display. They talk over the runtime's app-scoped
 * pub/sub (`rt.events`), which already reaches both windows of the same app,
 * the way the pool calibration app drives its projector.
 *
 * Two directions, one shape each:
 *
 * - the mirror publishes a {@link WizardStatus} on {@link STATUS_TOPIC}
 *   whenever the snapshot changes: where the run is, what to read out, which
 *   commands are on offer and whether each one is usable right now;
 * - the control window publishes a {@link ControlCommand} on
 *   {@link COMMAND_TOPIC}. The commands are the run's own actions rather than
 *   key names, so the mirror decides what each one means in the phase it is
 *   in, and a command that makes no sense there is dropped.
 *
 * Either window may start, reload or come back first, so the control window
 * asks for the current snapshot with `hello` when it opens.
 *
 * Both directions are parsed strictly: anything that is not one of these
 * shapes is not from us.
 */

import type { MeasureValues } from './measurements.js';

/** Mirror to control window. */
export const STATUS_TOPIC = 'wizard:status';
/** Control window to mirror. */
export const COMMAND_TOPIC = 'wizard:command';

/** How long a timed capture counts down, for an operator working alone. */
export const TIMED_CAPTURE_SECONDS = 5;

// ---------------------------------------------------------------------------
// Commands

/** Commands that carry nothing, which is every command a button sends. */
export const PLAIN_COMMANDS = [
  'hello',
  'reuse-lens',
  'recalibrate-lens',
  'capture',
  'undo',
  'continue',
  'add-targets',
  'redo-worst',
  'restart',
  'save',
  'cancel',
] as const;

export type PlainCommandKind = (typeof PLAIN_COMMANDS)[number];

/** Everything a button may send: a plain command or the timed capture. */
export type ActionKind = Exclude<PlainCommandKind, 'hello'> | 'capture-in';

export type ControlCommand =
  | { readonly kind: PlainCommandKind }
  | { readonly kind: 'submit-measurements'; readonly values: MeasureValues }
  | { readonly kind: 'capture-in'; readonly seconds: number }
  | { readonly kind: 'trim'; readonly dx: number; readonly dy: number };

export type CommandKind = ControlCommand['kind'];

/** The longest countdown worth honouring, so a stray number cannot park the run. */
const MAX_COUNTDOWN_SECONDS = 60;
/** A single trim step never moves the drawing further than this. */
const MAX_TRIM_STEP_PX = 100;

/** A command from the control window, or `null` when it is not one of ours. */
export function parseCommand(data: unknown): ControlCommand | null {
  if (!isObject(data)) return null;
  const kind = data['kind'];
  if (typeof kind !== 'string') return null;
  const plain = PLAIN_COMMANDS.find((known) => known === kind);
  if (plain) return { kind: plain };
  if (kind === 'submit-measurements') {
    const values = stringRecord(data['values']);
    return values ? { kind, values } : null;
  }
  if (kind === 'capture-in') {
    const seconds = data['seconds'];
    if (!isFinite(seconds) || seconds < 1 || seconds > MAX_COUNTDOWN_SECONDS) return null;
    return { kind, seconds: Math.round(seconds) };
  }
  if (kind === 'trim') {
    const dx = data['dx'];
    const dy = data['dy'];
    if (!isStep(dx) || !isStep(dy)) return null;
    return { kind, dx: Math.round(dx), dy: Math.round(dy) };
  }
  return null;
}

function isStep(value: unknown): value is number {
  return isFinite(value) && Math.abs(value) <= MAX_TRIM_STEP_PX;
}

// ---------------------------------------------------------------------------
// Status

export type WizardPhase =
  | 'measure'
  | 'lens-choice'
  | 'lens-capture'
  | 'lens-result'
  | 'lens-failed'
  | 'align'
  | 'solving'
  | 'fit'
  | 'holdout'
  | 'no-fit'
  | 'verify'
  | 'saving'
  | 'leaving';

const PHASES: readonly WizardPhase[] = [
  'measure',
  'lens-choice',
  'lens-capture',
  'lens-result',
  'lens-failed',
  'align',
  'solving',
  'fit',
  'holdout',
  'no-fit',
  'verify',
  'saving',
  'leaving',
];

/** How a number reads: good, worth a look, or wrong. */
export type StatusTone = 'plain' | 'good' | 'warn' | 'bad';

const TONES: readonly StatusTone[] = ['plain', 'good', 'warn', 'bad'];

/** The one number a screen is about, drawn large in both windows. */
export interface StatusHeadline {
  readonly text: string;
  readonly tone: StatusTone;
}

/** A live reading the operator watches while they work. */
export interface StatusReading {
  readonly label: string;
  readonly value: string;
  /** False draws it as something to fix. */
  readonly ok: boolean;
}

export interface StatusProgress {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}

/** A command on offer right now, as the control window draws it. */
export interface StatusAction {
  readonly command: ActionKind;
  readonly label: string;
  readonly enabled: boolean;
  /** What Space, Enter and Page Down send in this phase. Exactly one, at most. */
  readonly primary: boolean;
  /** The key that sends it, for the button's label. Empty when it has none. */
  readonly key: string;
}

/** The measurement form, while the run is waiting for it. */
export interface StatusForm {
  /** Prefilled values, by {@link MeasureField} key, plus `eye`. */
  readonly values: MeasureValues;
  /** What the last submission got wrong. Empty before the first one. */
  readonly errors: readonly string[];
}

/** Everything the control window draws, and everything the mirror says. */
export interface WizardStatus {
  readonly phase: WizardPhase;
  readonly title: string;
  readonly lines: readonly string[];
  readonly headline: StatusHeadline | null;
  readonly progress: StatusProgress | null;
  readonly readings: readonly StatusReading[];
  readonly actions: readonly StatusAction[];
  readonly form: StatusForm | null;
  /** Seconds left of a timed capture; null when none is running. */
  readonly countdown: number | null;
  /** The trim being dialled in, in reference pixels, while verify is up. */
  readonly trim: readonly [number, number] | null;
  /** A rejection or a hint, in the operator's words. */
  readonly message: string;
}

/** A status from the mirror, or `null` when it is not one of ours. */
export function parseStatus(data: unknown): WizardStatus | null {
  if (!isObject(data)) return null;
  const phase = PHASES.find((known) => known === data['phase']);
  const lines = stringList(data['lines']);
  const readings = readingList(data['readings']);
  const actions = actionList(data['actions']);
  if (!phase || !lines || !readings || !actions) return null;
  if (typeof data['title'] !== 'string' || typeof data['message'] !== 'string') return null;
  const headline = optional(data['headline'], parseHeadline);
  const progress = optional(data['progress'], parseProgress);
  const form = optional(data['form'], parseForm);
  const trim = optional(data['trim'], parseTrim);
  if (headline === null || progress === null || form === null || trim === null) return null;
  const countdown = data['countdown'];
  if (countdown !== null && !isFinite(countdown)) return null;
  return {
    phase,
    title: data['title'],
    lines,
    headline: headline.value,
    progress: progress.value,
    readings,
    actions,
    form: form.value,
    countdown: countdown === null ? null : Math.round(countdown),
    trim: trim.value,
    message: data['message'],
  };
}

/** `null` when the value is present and broken; a box around it otherwise. */
function optional<T>(
  value: unknown,
  parse: (value: unknown) => T | null,
): { value: T | null } | null {
  if (value === null || value === undefined) return { value: null };
  const parsed = parse(value);
  return parsed === null ? null : { value: parsed };
}

function parseHeadline(value: unknown): StatusHeadline | null {
  if (!isObject(value) || typeof value['text'] !== 'string') return null;
  const tone = TONES.find((known) => known === value['tone']);
  return tone ? { text: value['text'], tone } : null;
}

function parseProgress(value: unknown): StatusProgress | null {
  if (!isObject(value) || typeof value['label'] !== 'string') return null;
  const done = value['done'];
  const total = value['total'];
  if (!isFinite(done) || !isFinite(total)) return null;
  return { done, total, label: value['label'] };
}

function parseForm(value: unknown): StatusForm | null {
  if (!isObject(value)) return null;
  const values = stringRecord(value['values']);
  const errors = stringList(value['errors']);
  return values && errors ? { values, errors } : null;
}

function parseTrim(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [dx, dy] = value;
  return isFinite(dx) && isFinite(dy) ? [dx, dy] : null;
}

function readingList(value: unknown): readonly StatusReading[] | null {
  if (!Array.isArray(value)) return null;
  const readings: StatusReading[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const { label, value: text, ok } = entry;
    if (typeof label !== 'string' || typeof text !== 'string' || typeof ok !== 'boolean') {
      return null;
    }
    readings.push({ label, value: text, ok });
  }
  return readings;
}

function actionList(value: unknown): readonly StatusAction[] | null {
  if (!Array.isArray(value)) return null;
  const actions: StatusAction[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return null;
    const command = actionKind(entry['command']);
    const { label, enabled, primary, key } = entry;
    if (!command || typeof label !== 'string' || typeof key !== 'string') return null;
    if (typeof enabled !== 'boolean' || typeof primary !== 'boolean') return null;
    actions.push({ command, label, enabled, primary, key });
  }
  return actions;
}

function actionKind(value: unknown): ActionKind | null {
  if (value === 'capture-in') return value;
  const plain = PLAIN_COMMANDS.find((known) => known === value);
  return plain && plain !== 'hello' ? plain : null;
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? [...value] : null;
}

function stringRecord(value: unknown): MeasureValues | null {
  if (!isObject(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    record[key] = entry;
  }
  return record;
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
