/**
 * The control window GOSAI opens next to the mirror when it runs the
 * calibration, e.g. from the dashboard. The user calibrates by gesture on the
 * mirror, so this window only says so and can cancel.
 */

/** Shows the panel. Returns what removes it. */
export function showControl(cancel: () => void, signal: AbortSignal): () => void {
  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;justify-content:center;gap:16px;padding:32px;background:#0a0a0a;color:#f5f5f5;font:14px ui-sans-serif,system-ui,sans-serif;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:20px;font-weight:600;';
  title.textContent = 'Mirror calibration';

  const help = document.createElement('div');
  help.style.cssText = 'color:#a3a3a3;line-height:1.5;max-width:560px;';
  help.textContent =
    'The calibration runs on the mirror. Stand in front of it with your whole body visible and follow the steps there: point at each dot, then check the skeleton on your reflection and hold your hand on Save. This window closes once it is saved.';

  const button = document.createElement('button');
  button.style.cssText =
    'align-self:flex-start;background:#7f1d1d;color:#fff;border:1px solid rgba(255,255,255,0.08);padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer;border-radius:4px;';
  button.textContent = 'Cancel (Esc)';

  const onCancel = (): void => {
    if (button.disabled) return;
    button.disabled = true;
    cancel();
  };
  button.addEventListener('click', onCancel, { signal });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'Escape') onCancel();
    },
    { signal },
  );

  root.append(title, help, button);
  document.body.appendChild(root);
  return () => root.remove();
}
