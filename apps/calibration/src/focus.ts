/**
 * Focus control of the calibration control window: autofocus or a fixed manual
 * focus, swept while watching the live feed. Pinning it stops autofocus from
 * hunting on a flat surface such as a pool table.
 *
 * The drag goes to the camera driver's `set_focus`, which applies without a
 * reopen. The released value is saved to the target app's camera settings, so
 * the app gets it back whenever it opens the camera. A camera without a
 * manual-focus control shows nothing.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';

const LABEL_CSS = 'font-size:11px;color:#a3a3a3;';
const SELECT_CSS =
  'background:#1f2937;color:#fff;border:1px solid rgba(255,255,255,0.08);padding:7px 8px;font:12px ui-monospace,monospace;border-radius:4px;';

export async function mountFocusControl(
  rt: ExperienceRuntimeContext,
  appSlug: string,
  parent: HTMLElement,
): Promise<void> {
  let status;
  try {
    status = await rt.drivers.execute('camera', 'get_focus');
  } catch (err) {
    rt.log.warn('could not read the camera focus', { err: String(err) });
    return;
  }
  const info = status.info;
  if (!status.supported || !info || rt.signal.aborted) return;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const label = document.createElement('span');
  label.style.cssText = LABEL_CSS;
  label.textContent = 'Focus';
  const select = document.createElement('select');
  select.style.cssText = SELECT_CSS;
  for (const [value, text] of [
    ['auto', info.autofocus ? 'Auto' : 'Camera default'],
    ['manual', 'Manual'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    select.appendChild(option);
  }
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(info.min);
  slider.max = String(info.max);
  slider.step = String(info.step);
  slider.style.cssText = 'width:160px;accent-color:#22c55e;';
  const readout = document.createElement('span');
  readout.style.cssText = `${LABEL_CSS}width:32px;text-align:right;`;
  wrap.append(label, select, slider, readout);
  parent.appendChild(wrap);
  rt.signal.addEventListener('abort', () => wrap.remove());

  // Start the slider where autofocus last settled, so going manual keeps the
  // picture sharp.
  slider.value = String(status.focus ?? info.value ?? info.default);
  const show = (manual: boolean): void => {
    select.value = manual ? 'manual' : 'auto';
    slider.style.display = readout.style.display = manual ? '' : 'none';
    readout.textContent = slider.value;
  };
  show(status.focus != null);

  // One request at a time, and only the newest value waits: a drag produces
  // values faster than the device takes them.
  let sending = false;
  let queued: { focus: number | null } | null = null;
  const apply = async (focus: number | null): Promise<void> => {
    queued = { focus };
    if (sending) return;
    sending = true;
    try {
      while (queued) {
        const next: { focus: number | null } = queued;
        queued = null;
        await rt.drivers.execute('camera', 'set_focus', next);
      }
    } catch (err) {
      rt.log.warn('could not set the camera focus', { err: String(err) });
    } finally {
      sending = false;
    }
  };
  const save = async (focus: number | null): Promise<void> => {
    await apply(focus);
    try {
      // `null` drops the app's own focus, so it follows the global camera again.
      await rt.app.server.request('app:config:set', { appSlug, settings: { camera: { focus } } });
    } catch (err) {
      rt.log.warn('could not save the camera focus', { err: String(err) });
    }
  };
  const current = (): number => Number.parseInt(slider.value, 10);

  const { signal } = rt;
  select.addEventListener(
    'change',
    () => {
      const manual = select.value === 'manual';
      show(manual);
      void save(manual ? current() : null);
    },
    { signal },
  );
  slider.addEventListener(
    'input',
    () => {
      readout.textContent = slider.value;
      void apply(current());
    },
    { signal },
  );
  slider.addEventListener('change', () => void save(current()), { signal });
  // The wizard's shortcuts (arrows, space, r) must not fire while these have focus.
  for (const el of [select, slider]) {
    el.addEventListener('keydown', (e) => e.stopPropagation(), { signal });
  }
}
