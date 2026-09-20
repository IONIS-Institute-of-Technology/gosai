/**
 * The control window's keyboard, as a function of the key and the snapshot on
 * screen. The mirror has no keyboard, so this is the only one in the flow.
 *
 * It is pure so the rules can be read and tested on their own: a held key is
 * one press, the keys do nothing while the operator is typing in the form, and
 * a shortcut only fires the command the phase actually offers.
 */

import {
  TIMED_CAPTURE_SECONDS,
  type ActionKind,
  type ControlCommand,
  type WizardStatus,
} from './channel.js';

/** The command a button sends. The countdown is the only one that carries a number. */
export function commandFor(kind: ActionKind): ControlCommand {
  return kind === 'capture-in' ? { kind, seconds: TIMED_CAPTURE_SECONDS } : { kind };
}

/** How far one arrow press moves the drawing, and with shift held. */
export const TRIM_STEP_PX = 1;
export const TRIM_FAST_STEP_PX = 5;

/** What confirms: the phase's primary action. Page Down is what remotes send. */
const PRIMARY_KEYS: readonly string[] = ['Space', 'Enter', 'NumpadEnter', 'PageDown'];

const TRIM_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface KeyPress {
  /** A `KeyboardEvent.code`. */
  readonly code: string;
  readonly shift: boolean;
  /** A held key repeats: one press is one capture, one undo, one nudge. */
  readonly repeat: boolean;
  /** While a field has the keyboard, the keys belong to the form. */
  readonly inFormField: boolean;
}

/** The command a key press sends, or `null` when it sends nothing. */
export function commandForKey(press: KeyPress, status: WizardStatus | null): ControlCommand | null {
  if (press.repeat || press.inFormField) return null;
  if (press.code === 'Escape') return { kind: 'cancel' };
  if (!status) return null;
  const trim = TRIM_KEYS[press.code];
  if (trim && status.trim) {
    const step = press.shift ? TRIM_FAST_STEP_PX : TRIM_STEP_PX;
    return { kind: 'trim', dx: trim[0] * step, dy: trim[1] * step };
  }
  if (PRIMARY_KEYS.includes(press.code)) {
    const primary = status.actions.find((action) => action.primary && action.enabled);
    return primary ? commandFor(primary.command) : null;
  }
  if (press.code === 'KeyT' && offers(status, 'capture-in')) {
    return { kind: 'capture-in', seconds: TIMED_CAPTURE_SECONDS };
  }
  if (press.code === 'Backspace' && offers(status, 'undo')) return { kind: 'undo' };
  return null;
}

function offers(status: WizardStatus, command: string): boolean {
  return status.actions.some((action) => action.command === command && action.enabled);
}
