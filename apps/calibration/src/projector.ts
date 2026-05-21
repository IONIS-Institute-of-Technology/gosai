/**
 * Projector-side renderer for the calibration wizard.
 *
 * Runs in the fullscreen app-host window. Listens for wizard events from the
 * control window via `rt.events` and renders the appropriate visuals:
 *   - `markers`     -> ArUco grid
 *   - `pool-corners`-> dim background with instructions
 *   - `compute`     -> "computing..." overlay (kept brief)
 *   - `background`  -> pure black so the camera sees the empty scene
 *   - `preview`     -> live camera feed (warped overlay reference)
 */

import type {
  AppEventsSubscription,
  DriverSubscription,
  ExperienceRuntimeContext,
} from '@gosai/sdk';
import {
  WIZARD_EVENTS,
  type MarkerImage,
  type MarkerSlot,
  type MarkerTransform,
  type MarkerTransformEvent,
  type StepEvent,
  type WizardStep,
  DEFAULT_MARKER_TRANSFORM,
  PAN_STEP,
  ZOOM_STEP,
  MIN_SCALE,
  MAX_SCALE,
  applyTransformToLayout,
  makeMarkerLayout,
  setBodyFullscreen,
} from './shared.js';

export interface ProjectorState {
  root: HTMLDivElement;
  status: HTMLDivElement;
  markerLayer: HTMLDivElement;
  blackLayer: HTMLDivElement;
  previewImg: HTMLImageElement;
  step: WizardStep;
  layout: MarkerSlot[];
  transform: MarkerTransform;
  eventSubs: AppEventsSubscription[];
  driverSubs: DriverSubscription[];
  keyHandler: ((e: KeyboardEvent) => void) | null;
  wheelHandler: ((e: WheelEvent) => void) | null;
}

export function initProjectorState(): ProjectorState {
  setBodyFullscreen();

  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;background:#000;color:#fff;';
  document.body.appendChild(root);

  const markerLayer = document.createElement('div');
  markerLayer.style.cssText = 'position:absolute;inset:0;background:#fff;display:none;';
  root.appendChild(markerLayer);

  const blackLayer = document.createElement('div');
  blackLayer.style.cssText = 'position:absolute;inset:0;background:#000;';
  root.appendChild(blackLayer);

  const previewImg = document.createElement('img');
  previewImg.style.cssText =
    'position:absolute;inset:0;width:100vw;height:100vh;object-fit:contain;display:none;opacity:0.6;';
  root.appendChild(previewImg);

  const status = document.createElement('div');
  status.style.cssText =
    'position:fixed;top:24px;left:24px;background:rgba(0,0,0,0.7);color:#fff;padding:10px 16px;font:13px ui-monospace,monospace;border-radius:6px;z-index:10;max-width:60vw;';
  status.textContent = 'calibration · waiting…';
  root.appendChild(status);

  return {
    root,
    status,
    markerLayer,
    blackLayer,
    previewImg,
    step: 'markers',
    layout: [],
    transform: { ...DEFAULT_MARKER_TRANSFORM },
    eventSubs: [],
    driverSubs: [],
    keyHandler: null,
    wheelHandler: null,
  };
}

export async function startProjector(
  rt: ExperienceRuntimeContext,
  state: ProjectorState,
): Promise<void> {
  rt.log.info('projector role starting');

  const width = window.innerWidth;
  const height = window.innerHeight;
  state.layout = makeMarkerLayout(width, height, 9);

  for (const slot of state.layout) {
    const result = (await rt.drivers.execute('calibration', 'render_marker', {
      id: slot.id,
      size: 200,
    })) as MarkerImage;
    if (!result?.ok || !result.png_base64) {
      rt.log.warn('marker render failed', { id: slot.id, err: result?.error });
      continue;
    }
    const img = document.createElement('img');
    img.src = `data:image/png;base64,${result.png_base64}`;
    img.style.cssText = `
      position:absolute;
      left:${slot.x - slot.size / 2}px;
      top:${slot.y - slot.size / 2}px;
      width:${slot.size}px;
      height:${slot.size}px;
      image-rendering:pixelated;
    `;
    state.markerLayer.appendChild(img);
  }

  await rt.drivers.execute('calibration', 'set_marker_layout', state.layout);

  // --- Pan / Zoom controls (active during 'markers' step) ---

  const applyMarkerTransform = (): void => {
    const { offsetX, offsetY, scale } = state.transform;
    const cx = width / 2;
    const cy = height / 2;
    state.markerLayer.style.transformOrigin = `${cx}px ${cy}px`;
    state.markerLayer.style.transform =
      `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    updateTransformStatus(state);
  };

  const syncLayoutToDriver = (): void => {
    const transformed = applyTransformToLayout(state.layout, state.transform, width, height);
    void rt.drivers.execute('calibration', 'set_marker_layout', transformed);
  };

  const onTransformChange = (): void => {
    applyMarkerTransform();
    syncLayoutToDriver();
    void rt.events.emit(WIZARD_EVENTS.MarkerTransform, {
      transform: state.transform,
    } satisfies MarkerTransformEvent);
  };

  state.keyHandler = (e: KeyboardEvent): void => {
    if (state.step !== 'markers') return;
    let handled = true;
    switch (e.code) {
      case 'ArrowLeft':
        state.transform.offsetX -= PAN_STEP;
        break;
      case 'ArrowRight':
        state.transform.offsetX += PAN_STEP;
        break;
      case 'ArrowUp':
        state.transform.offsetY -= PAN_STEP;
        break;
      case 'ArrowDown':
        state.transform.offsetY += PAN_STEP;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      onTransformChange();
    }
  };

  state.wheelHandler = (e: WheelEvent): void => {
    if (state.step !== 'markers') return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.transform.scale + direction * ZOOM_STEP));
    state.transform.scale = newScale;
    onTransformChange();
  };

  document.addEventListener('keydown', state.keyHandler);
  document.addEventListener('wheel', state.wheelHandler, { passive: false });

  // Accept transform updates from the control window.
  state.eventSubs.push(
    rt.events.on(WIZARD_EVENTS.MarkerTransform, (payload) => {
      const data = payload as MarkerTransformEvent;
      state.transform = { ...data.transform };
      applyMarkerTransform();
      syncLayoutToDriver();
    }),
  );

  // Camera feed for the live preview step.
  state.driverSubs.push(
    rt.drivers.on('camera', 'color', (payload) => {
      if (state.step !== 'preview') return;
      const data = payload as { jpeg_base64?: string };
      if (typeof data?.jpeg_base64 === 'string') {
        state.previewImg.src = `data:image/jpeg;base64,${data.jpeg_base64}`;
      }
    }),
  );

  state.eventSubs.push(
    rt.events.on(WIZARD_EVENTS.Step, (payload) => {
      const data = payload as StepEvent;
      applyStep(state, data.step, data.message);
    }),
  );

  applyStep(state, 'markers');
}

export async function stopProjector(state: ProjectorState): Promise<void> {
  for (const s of state.eventSubs) s.unsubscribe();
  for (const s of state.driverSubs) s.unsubscribe();
  if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler);
  if (state.wheelHandler) document.removeEventListener('wheel', state.wheelHandler);
  state.root.remove();
}

function updateTransformStatus(state: ProjectorState): void {
  if (state.step !== 'markers') return;
  const { offsetX, offsetY, scale } = state.transform;
  const zoomPct = Math.round(scale * 100);
  state.status.textContent =
    `markers projected · ↔ ${offsetX} ↕ ${offsetY} · zoom ${zoomPct}%  [arrows: pan · scroll: zoom]`;
}

function applyStep(state: ProjectorState, step: WizardStep, message?: string): void {
  state.step = step;

  state.markerLayer.style.display = step === 'markers' ? 'block' : 'none';
  state.previewImg.style.display = step === 'preview' ? 'block' : 'none';
  state.blackLayer.style.display = 'block';
  state.blackLayer.style.background = step === 'background' ? '#000' : 'rgba(0,0,0,0)';

  state.status.style.display = step === 'background' || step === 'preview' ? 'none' : 'block';

  switch (step) {
    case 'markers':
      updateTransformStatus(state);
      break;
    case 'pool-corners':
      state.status.textContent = message ?? 'pick pool corners on the control window';
      break;
    case 'compute':
      state.status.textContent = message ?? 'computing homography…';
      break;
    case 'background':
      break;
    case 'preview':
      break;
    case 'done':
      state.status.textContent = message ?? 'calibration complete';
      break;
    case 'abort':
      state.status.textContent = message ?? 'calibration aborted';
      break;
  }
}
