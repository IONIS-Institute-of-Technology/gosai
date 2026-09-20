/**
 * The control window GOSAI opens beside the mirror when it runs the
 * calibration, on a display that has a keyboard and a mouse.
 *
 * The mirror has neither, so every setting, field, button and shortcut of the
 * flow is here. It holds no state of its own: it draws the {@link WizardStatus}
 * the mirror publishes and sends commands back (see channel.ts). Either window
 * may start or reload first, so it asks for the current snapshot when it
 * opens.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import {
  COMMAND_TOPIC,
  STATUS_TOPIC,
  parseStatus,
  type ControlCommand,
  type StatusAction,
  type StatusTone,
  type WizardStatus,
} from './channel.js';
import { commandFor, commandForKey } from './keys.js';
import { MEASURE_FIELDS, type MeasureValues } from './measurements.js';

export interface ControlOptions {
  readonly rt: ExperienceRuntimeContext;
  /** Ends the run from here, when no mirror window ever answered. */
  cancel(): void;
}

const TONE_COLORS: Readonly<Record<StatusTone, string>> = {
  plain: '#f5f5f5',
  good: '#a6d854',
  warn: '#ff8100',
  bad: '#ff6b6b',
};

const ROOT_CSS =
  'position:fixed;inset:0;overflow:auto;padding:28px 32px 40px;background:#0a0a0a;color:#f5f5f5;' +
  'font:15px ui-sans-serif,system-ui,sans-serif;line-height:1.5;';
const CARD_CSS = 'width:min(760px,100%);display:flex;flex-direction:column;gap:18px;';
const HELP_CSS = 'color:#a3a3a3;font-size:14px;';
const INPUT_CSS =
  'width:200px;background:#171717;color:#f5f5f5;border:1px solid rgba(255,255,255,0.18);' +
  'border-radius:4px;padding:10px 12px;font:18px ui-monospace,monospace;';
const BUTTON_CSS =
  'color:#fff;background:#262626;border:1px solid rgba(255,255,255,0.14);border-radius:6px;' +
  'padding:16px 22px;font:17px ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-align:left;';
const PRIMARY_CSS = 'background:#166534;font-weight:600;font-size:20px;padding:22px 28px;';
const CANCEL_CSS = 'background:#7f1d1d;';

interface View {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly headline: HTMLDivElement;
  readonly lines: HTMLDivElement;
  readonly progress: HTMLDivElement;
  readonly readings: HTMLDivElement;
  readonly countdown: HTMLDivElement;
  readonly form: HTMLDivElement;
  readonly trim: HTMLDivElement;
  readonly actions: HTMLDivElement;
  readonly message: HTMLDivElement;
}

/** Shows the panel. Returns what removes it. */
export function showControl(options: ControlOptions): () => void {
  const { rt } = options;
  const signal = rt.signal;
  const view = createView();
  let status: WizardStatus | null = null;
  let answered = false;
  /** The form is built once per visit, so typing is never wiped by a refresh. */
  let formBuilt = false;
  let actionsKey = '';

  const send = (command: ControlCommand): void => {
    rt.events.emit(COMMAND_TOPIC, command).catch((err: unknown) => {
      rt.log.warn('calibrate: the control window could not reach the mirror', {
        err: String(err),
      });
    });
  };

  const cancel = (): void => {
    send({ kind: 'cancel' });
    // Nothing has ever answered, so there is no run on the mirror to end and
    // this window ends the flow itself.
    if (!answered) options.cancel();
  };

  const show = (next: WizardStatus): void => {
    answered = true;
    status = next;
    view.title.textContent = next.title;
    setHeadline(view.headline, next);
    setLines(view.lines, next.lines);
    setProgress(view.progress, next);
    setReadings(view.readings, next);
    setCountdown(view.countdown, next);
    setTrim(view.trim, next);
    view.message.textContent = next.message;
    view.message.style.display = next.message ? 'block' : 'none';
    if (!next.form) {
      view.form.replaceChildren();
      formBuilt = false;
    } else if (!formBuilt) {
      view.form.replaceChildren(
        buildForm(rt, next.form.values, (values) => {
          send({ kind: 'submit-measurements', values });
        }),
      );
      formBuilt = true;
      focusFirstField(view.form);
    }
    setErrors(view.form, next.form?.errors ?? []);
    const key = JSON.stringify(next.actions);
    if (key !== actionsKey) {
      actionsKey = key;
      setActions(view.actions, next.actions, send, cancel);
    }
  };

  const statusSub = rt.events.on(STATUS_TOPIC, (data) => {
    const parsed = parseStatus(data);
    if (parsed) show(parsed);
  });

  document.addEventListener(
    'keydown',
    (event) => {
      const command = commandForKey(
        {
          code: event.code,
          shift: event.shiftKey,
          repeat: event.repeat,
          inFormField: inFormField(event.target),
        },
        status,
      );
      if (!command) return;
      // Space and the arrows scroll the page, Page Down moves it as well.
      event.preventDefault();
      if (command.kind === 'cancel') cancel();
      else send(command);
    },
    { signal },
  );

  document.body.appendChild(view.root);
  // Either window may have started first, so ask where the run is.
  send({ kind: 'hello' });
  return () => {
    statusSub.unsubscribe();
    view.root.remove();
  };
}

function inFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function createView(): View {
  const root = document.createElement('div');
  root.style.cssText = ROOT_CSS;
  const card = document.createElement('div');
  card.style.cssText = CARD_CSS;
  const heading = document.createElement('div');
  heading.style.cssText = `${HELP_CSS}text-transform:uppercase;letter-spacing:0.08em;`;
  heading.textContent = 'Mirror calibration';
  const title = block('font-size:26px;font-weight:600;line-height:1.25;');
  const headline = block('font-size:44px;font-weight:600;');
  const lines = block('');
  const progress = block(HELP_CSS);
  const readings = block('display:flex;flex-wrap:wrap;gap:10px;');
  const countdown = block('font-size:34px;font-weight:600;color:#ff8100;');
  const form = block('display:flex;flex-direction:column;gap:18px;');
  const trim = block(HELP_CSS);
  const actions = block('display:flex;flex-direction:column;gap:10px;align-items:stretch;');
  const message = block('color:#ff8100;');
  card.append(
    heading,
    title,
    headline,
    lines,
    progress,
    readings,
    countdown,
    form,
    trim,
    actions,
    message,
  );
  root.appendChild(card);
  return {
    root,
    title,
    headline,
    lines,
    progress,
    readings,
    countdown,
    form,
    trim,
    actions,
    message,
  };
}

function block(css: string): HTMLDivElement {
  const element = document.createElement('div');
  element.style.cssText = css;
  return element;
}

function setHeadline(target: HTMLDivElement, status: WizardStatus): void {
  const headline = status.headline;
  target.textContent = headline?.text ?? '';
  target.style.display = headline ? 'block' : 'none';
  target.style.color = TONE_COLORS[headline?.tone ?? 'plain'];
}

function setLines(target: HTMLDivElement, lines: readonly string[]): void {
  target.replaceChildren(
    ...lines.map((line) => {
      const row = document.createElement('div');
      row.textContent = line;
      // An empty line is a paragraph break, so it keeps its height.
      if (!line) row.style.height = '10px';
      return row;
    }),
  );
}

function setProgress(target: HTMLDivElement, status: WizardStatus): void {
  const progress = status.progress;
  target.style.display = progress ? 'block' : 'none';
  if (!progress) return;
  const ratio = progress.total > 0 ? Math.max(0, Math.min(1, progress.done / progress.total)) : 0;
  const bar = document.createElement('div');
  bar.style.cssText =
    'height:8px;border-radius:4px;background:#262626;overflow:hidden;margin:6px 0 8px;';
  const fill = document.createElement('div');
  fill.style.cssText = `height:100%;width:${(ratio * 100).toFixed(1)}%;background:#a6d854;`;
  bar.appendChild(fill);
  const label = document.createElement('div');
  label.textContent = progress.label;
  target.replaceChildren(bar, label);
}

function setReadings(target: HTMLDivElement, status: WizardStatus): void {
  target.replaceChildren(
    ...status.readings.map((reading) => {
      const chip = document.createElement('div');
      chip.style.cssText =
        `border:1px solid ${reading.ok ? '#a6d854' : '#ff8100'};border-radius:999px;` +
        `color:${reading.ok ? '#a6d854' : '#ff8100'};padding:6px 14px;font-size:14px;`;
      chip.textContent = `${reading.label}: ${reading.value}`;
      return chip;
    }),
  );
}

function setCountdown(target: HTMLDivElement, status: WizardStatus): void {
  const seconds = status.countdown;
  target.style.display = seconds === null ? 'none' : 'block';
  if (seconds !== null) target.textContent = `Capturing in ${seconds}…`;
}

function setTrim(target: HTMLDivElement, status: WizardStatus): void {
  const trim = status.trim;
  target.style.display = trim ? 'block' : 'none';
  if (!trim) return;
  target.textContent =
    `Trim ${signed(trim[0])}, ${signed(trim[1])} px. ` +
    'The arrow keys nudge the drawing by 1 px, 5 px with shift.';
}

function setActions(
  target: HTMLDivElement,
  actions: readonly StatusAction[],
  send: (command: ControlCommand) => void,
  cancel: () => void,
): void {
  target.replaceChildren(
    ...actions.map((action) => {
      const button = document.createElement('button');
      const primary = action.primary ? PRIMARY_CSS : '';
      const stop = action.command === 'cancel' ? CANCEL_CSS : '';
      button.style.cssText = `${BUTTON_CSS}${primary}${stop}`;
      button.textContent = action.key ? `${action.label}  (${action.key})` : action.label;
      button.disabled = !action.enabled;
      button.style.opacity = action.enabled ? '1' : '0.45';
      button.addEventListener('click', () => {
        if (action.command === 'cancel') cancel();
        else send(commandFor(action.command));
      });
      return button;
    }),
  );
}

/**
 * The measurements. They are typed here because this is the window with a
 * keyboard; the mirror checks them, so the rules live in one place
 * (measurements.ts) and this only collects what was typed.
 */
function buildForm(
  rt: ExperienceRuntimeContext,
  values: MeasureValues,
  submit: (values: MeasureValues) => void,
): HTMLElement {
  const form = document.createElement('div');
  form.style.cssText = 'display:flex;flex-direction:column;gap:18px;';

  const intro = document.createElement('div');
  intro.style.cssText = HELP_CSS;
  intro.append(
    text('The board to print, at 100% (actual size): '),
    link('A4 sheet', rt.assets.url('assets/calibration/charuco-a4.pdf')),
    text(' · '),
    link('US Letter sheet', rt.assets.url('assets/calibration/charuco-letter.pdf')),
  );
  form.appendChild(intro);

  const inputs = new Map<string, HTMLInputElement>();
  for (const field of MEASURE_FIELDS) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:14px;';
    const name = document.createElement('span');
    name.style.cssText = 'font-weight:600;min-width:280px;';
    name.textContent = field.optional ? `${field.label}, optional` : field.label;
    const input = document.createElement('input');
    // Text rather than a number field: a number field rejects what it thinks
    // is an invalid step or decimal separator and then reads back as empty,
    // which would silently drop a measured 392.85 mm. The parser takes both
    // separators and checks the range itself.
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${field.label}, between ${field.min} and ${field.max}`);
    input.style.cssText = INPUT_CSS;
    input.value = values[field.key] ?? '';
    inputs.set(field.key, input);
    head.append(name, input);
    const help = document.createElement('div');
    help.style.cssText = HELP_CSS;
    help.textContent = field.help;
    row.append(head, help);
    form.appendChild(row);
  }

  const eyeRow = document.createElement('div');
  eyeRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  const eyeHead = document.createElement('div');
  eyeHead.style.cssText = 'display:flex;align-items:center;gap:14px;';
  const eyeName = document.createElement('span');
  eyeName.style.cssText = 'font-weight:600;min-width:280px;';
  eyeName.textContent = 'Which eye stays open';
  const eyeSelect = document.createElement('select');
  eyeSelect.style.cssText = INPUT_CSS;
  for (const value of ['right', 'left'] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'right' ? 'Right eye' : 'Left eye';
    eyeSelect.appendChild(option);
  }
  eyeSelect.value = values['eye'] === 'left' ? 'left' : 'right';
  eyeHead.append(eyeName, eyeSelect);
  const eyeHelp = document.createElement('div');
  eyeHelp.style.cssText = HELP_CSS;
  eyeHelp.textContent =
    'Keep the other one closed for the whole run. A flat display can only line up with one eye at a time.';
  eyeRow.append(eyeHead, eyeHelp);
  form.appendChild(eyeRow);

  const errors = document.createElement('div');
  errors.dataset['role'] = 'errors';
  errors.style.cssText = 'color:#ff8100;white-space:pre-line;';
  const submitButton = document.createElement('button');
  submitButton.style.cssText = `${BUTTON_CSS}${PRIMARY_CSS}align-self:flex-start;`;
  submitButton.textContent = 'Continue';
  const read = (): MeasureValues => {
    const collected: Record<string, string> = { eye: eyeSelect.value };
    for (const [key, input] of inputs) collected[key] = input.value;
    return collected;
  };
  submitButton.addEventListener('click', () => submit(read()));
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit(read());
    }
  });
  form.append(errors, submitButton);
  return form;
}

function setErrors(form: HTMLDivElement, errors: readonly string[]): void {
  const target = form.querySelector('[data-role="errors"]');
  if (target instanceof HTMLElement) target.textContent = errors.join('\n');
}

function focusFirstField(form: HTMLDivElement): void {
  const first = form.querySelector('input');
  if (first instanceof HTMLInputElement) first.focus();
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function link(label: string, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  anchor.textContent = label;
  anchor.style.cssText = 'color:#a6d854;';
  return anchor;
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}
