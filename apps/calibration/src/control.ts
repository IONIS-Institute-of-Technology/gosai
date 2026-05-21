/**
 * Control-side renderer + orchestrator for the calibration wizard.
 *
 * Runs in the (non-fullscreen) control window. Owns the step machine and is
 * responsible for:
 *   - showing the live camera feed and detection overlay
 *   - collecting the four pool-corner clicks
 *   - calling `calibration.compute` to compute the homography
 *   - calling `calibration.capture_background` (while the dashboard hides
 *     this window so it doesn't pollute the camera image)
 *   - persisting `homography`, `focus_quad`, and `background_jpeg` to app
 *     storage
 *
 * Keyboard shortcuts:
 *   - Space / Enter : advance to next step
 *   - Backspace     : revert to previous step
 *   - Escape        : abort
 *   - r             : (pool-corners) reset corner picks
 */

import type {
  AppEventsSubscription,
  DriverSubscription,
  ExperienceRuntimeContext,
} from '@gosai/sdk';
import {
  WIZARD_EVENTS,
  STORAGE_KEYS,
  DEFAULT_SURFACE_SIZE,
  type CornersEvent,
  type FocusQuad,
  type MarkerTransform,
  type MarkerTransformEvent,
  type Point2D,
  type SizeXY,
  type SurfaceQuadDisplay,
  type WizardStep,
  DEFAULT_MARKER_TRANSFORM,
  PAN_STEP,
  ZOOM_STEP,
  MIN_SCALE,
  MAX_SCALE,
  setBodyFullscreen,
} from './shared.js';

interface DOM {
  root: HTMLDivElement;
  header: HTMLDivElement;
  body: HTMLDivElement;
  footer: HTMLDivElement;
  stepTitle: HTMLDivElement;
  stepHelp: HTMLDivElement;
  cameraCanvas: HTMLCanvasElement;
  cameraImg: HTMLImageElement;
  overlay: HTMLCanvasElement;
  backBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  abortBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  status: HTMLDivElement;
}

export interface ControlState {
  dom: DOM;
  step: WizardStep;
  camFrame: HTMLImageElement | null;
  camFrameSize: { w: number; h: number } | null;
  /** Pool corners in normalised camera coords (0..1). */
  corners: Point2D[];
  /** Index of corner currently being dragged, or -1. */
  draggingIdx: number;
  detectedMarkers: number;
  totalMarkers: number;
  /** Mirror of the projector's marker transform for forwarding inputs. */
  markerTransform: MarkerTransform;
  eventSubs: AppEventsSubscription[];
  driverSubs: DriverSubscription[];
  keyHandler: ((e: KeyboardEvent) => void) | null;
  wheelHandler: ((e: WheelEvent) => void) | null;
  downHandler: ((e: MouseEvent) => void) | null;
  moveHandler: ((e: MouseEvent) => void) | null;
  upHandler: ((e: MouseEvent) => void) | null;
  resizeHandler: (() => void) | null;
  resizeObserver: ResizeObserver | null;
  busy: boolean;
}

const STEP_TITLES: Record<WizardStep, string> = {
  markers: 'Step 1 · ArUco Markers',
  'pool-corners': 'Step 2 · Pool Corners',
  compute: 'Step 3 · Compute Homography',
  background: 'Step 4 · Background Capture',
  preview: 'Step 5 · Preview',
  done: 'Calibration Complete',
  abort: 'Aborted',
};

const STEP_HELP: Record<WizardStep, string> = {
  markers:
    'Aim the camera so all 9 markers are visible. Use [Arrow keys] to pan and [Scroll wheel] to zoom the pattern to fit the surface. Press [Space] / Next when ready.',
  'pool-corners':
    'Click to place corners (top-left → clockwise). Drag an existing corner to adjust it. Press [r] to reset all, [Space] / Next when 4 corners are placed.',
  compute: 'Computing the camera→display homography. This should only take a moment.',
  background:
    'Make sure the pool is clear of objects. The control window will hide briefly so it does not pollute the capture.',
  preview:
    'Check that the calibration looks right. Press [Space] / Done to finish or [Backspace] to go back.',
  done: 'Calibration data saved. Closing windows…',
  abort: 'Calibration aborted. No data was saved.',
};

const ORDERED_STEPS: WizardStep[] = [
  'markers',
  'pool-corners',
  'compute',
  'background',
  'preview',
  'done',
];

export function initControlState(): ControlState {
  setBodyFullscreen();
  document.body.style.background = '#0a0a0a';

  const root = document.createElement('div');
  root.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;background:#0a0a0a;color:#fff;font:13px ui-monospace,monospace;';
  document.body.appendChild(root);

  const header = document.createElement('div');
  header.style.cssText =
    'padding:12px 16px;border-bottom:1px solid #222;background:#111;display:flex;flex-direction:column;gap:4px;';
  root.appendChild(header);

  const stepTitle = document.createElement('div');
  stepTitle.style.cssText = 'font-size:14px;font-weight:600;color:#f5f5f5;';
  header.appendChild(stepTitle);

  const stepHelp = document.createElement('div');
  stepHelp.style.cssText = 'font-size:12px;color:#a3a3a3;line-height:1.4;';
  header.appendChild(stepHelp);

  const body = document.createElement('div');
  body.style.cssText =
    'flex:1;position:relative;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;';
  root.appendChild(body);

  const cameraCanvas = document.createElement('canvas');
  cameraCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  body.appendChild(cameraCanvas);

  const overlay = document.createElement('canvas');
  overlay.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair;';
  body.appendChild(overlay);

  const cameraImg = document.createElement('img');
  cameraImg.style.display = 'none';

  const status = document.createElement('div');
  status.style.cssText =
    'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);padding:6px 10px;border-radius:4px;font-size:11px;color:#d4d4d4;';
  status.textContent = '';
  body.appendChild(status);

  const footer = document.createElement('div');
  footer.style.cssText =
    'padding:10px 16px;border-top:1px solid #222;background:#111;display:flex;gap:8px;align-items:center;';
  root.appendChild(footer);

  const abortBtn = button('Abort (Esc)', '#7f1d1d');
  const resetBtn = button('Reset corners (r)');
  const backBtn = button('Back (⌫)');
  const nextBtn = button('Next (Space)', '#166534');

  footer.appendChild(abortBtn);
  footer.appendChild(resetBtn);
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  footer.appendChild(spacer);
  footer.appendChild(backBtn);
  footer.appendChild(nextBtn);

  return {
    dom: {
      root,
      header,
      body,
      footer,
      stepTitle,
      stepHelp,
      cameraCanvas,
      cameraImg,
      overlay,
      backBtn,
      nextBtn,
      abortBtn,
      resetBtn,
      status,
    },
    step: 'markers',
    camFrame: null,
    camFrameSize: null,
    corners: [],
    draggingIdx: -1,
    detectedMarkers: 0,
    totalMarkers: 9,
    markerTransform: { ...DEFAULT_MARKER_TRANSFORM },
    eventSubs: [],
    driverSubs: [],
    keyHandler: null,
    wheelHandler: null,
    downHandler: null,
    moveHandler: null,
    upHandler: null,
    resizeHandler: null,
    resizeObserver: null,
    busy: false,
  };
}

export async function startControl(
  rt: ExperienceRuntimeContext,
  state: ControlState,
): Promise<void> {
  rt.log.info('control role starting');

  // Restore previous corner picks so the user does not lose work if the
  // wizard is re-opened.
  const previous = await rt.storage.get<FocusQuad>(STORAGE_KEYS.FocusQuad);
  if (previous?.points && previous.points.length === 4) {
    state.corners = previous.points.slice();
  }

  state.resizeHandler = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const r = state.dom.body.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (state.dom.cameraCanvas.width !== w || state.dom.cameraCanvas.height !== h) {
      state.dom.cameraCanvas.width = w;
      state.dom.cameraCanvas.height = h;
      state.dom.overlay.width = w;
      state.dom.overlay.height = h;
    }
    drawCamera(state);
    drawOverlay(state);
  };
  window.addEventListener('resize', state.resizeHandler);
  // The header's help text wraps differently between steps, which reflows the
  // body without firing `window.resize`. ResizeObserver catches those changes
  // so the canvas dimensions stay in sync with the visible rect.
  state.resizeObserver = new ResizeObserver(() => state.resizeHandler?.());
  state.resizeObserver.observe(state.dom.body);
  state.resizeHandler();

  state.driverSubs.push(
    rt.drivers.on('camera', 'color', (payload) => {
      const data = payload as { jpeg_base64?: string; width?: number; height?: number };
      if (typeof data?.jpeg_base64 !== 'string') return;
      const img = new Image();
      img.onload = () => {
        state.camFrame = img;
        state.camFrameSize = { w: img.naturalWidth, h: img.naturalHeight };
        drawCamera(state);
        drawOverlay(state);
      };
      img.src = `data:image/jpeg;base64,${data.jpeg_base64}`;
    }),
    rt.drivers.on('calibration', 'detection', (payload) => {
      const data = payload as { detected: number; total?: number };
      state.detectedMarkers = data.detected;
      if (typeof data.total === 'number') state.totalMarkers = data.total;
      updateStatus(state);
    }),
  );

  state.downHandler = (e: MouseEvent) => onPointerDown(rt, state, e);
  state.moveHandler = (e: MouseEvent) => onPointerMove(rt, state, e);
  state.upHandler = (e: MouseEvent) => onPointerUp(rt, state, e);
  state.dom.overlay.addEventListener('mousedown', state.downHandler);
  state.dom.overlay.addEventListener('mousemove', state.moveHandler);
  state.dom.overlay.addEventListener('mouseup', state.upHandler);

  state.keyHandler = (e: KeyboardEvent) => void onKey(rt, state, e);
  document.addEventListener('keydown', state.keyHandler);

  state.wheelHandler = (e: WheelEvent): void => {
    if (state.step !== 'markers') return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    state.markerTransform.scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, state.markerTransform.scale + direction * ZOOM_STEP),
    );
    void rt.events.emit(WIZARD_EVENTS.MarkerTransform, {
      transform: state.markerTransform,
    } satisfies MarkerTransformEvent);
  };
  document.addEventListener('wheel', state.wheelHandler, { passive: false });

  state.dom.nextBtn.addEventListener('click', () => void advance(rt, state));
  state.dom.backBtn.addEventListener('click', () => void revert(rt, state));
  state.dom.abortBtn.addEventListener('click', () => void abort(rt, state));
  state.dom.resetBtn.addEventListener('click', () => resetCorners(rt, state));

  state.eventSubs.push(
    rt.events.on(WIZARD_EVENTS.MarkerTransform, (payload) => {
      const data = payload as MarkerTransformEvent;
      state.markerTransform = { ...data.transform };
    }),
    rt.events.on(WIZARD_EVENTS.BackgroundCaptured, () => {
      // Defensive: the control window also reacts to this event in case
      // someone runs `capture_background` from elsewhere.
    }),
  );

  setStep(rt, state, 'markers');
}

export async function stopControl(state: ControlState): Promise<void> {
  for (const s of state.eventSubs) s.unsubscribe();
  for (const s of state.driverSubs) s.unsubscribe();
  if (state.downHandler) state.dom.overlay.removeEventListener('mousedown', state.downHandler);
  if (state.moveHandler) state.dom.overlay.removeEventListener('mousemove', state.moveHandler);
  if (state.upHandler) state.dom.overlay.removeEventListener('mouseup', state.upHandler);
  if (state.keyHandler) document.removeEventListener('keydown', state.keyHandler);
  if (state.wheelHandler) document.removeEventListener('wheel', state.wheelHandler);
  if (state.resizeHandler) window.removeEventListener('resize', state.resizeHandler);
  if (state.resizeObserver) state.resizeObserver.disconnect();
  state.dom.root.remove();
}

function button(text: string, color?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `
    background:${color ?? '#1f2937'};
    color:#fff;
    border:1px solid rgba(255,255,255,0.08);
    padding:8px 14px;
    font:12px ui-monospace,monospace;
    cursor:pointer;
    border-radius:4px;
  `;
  return btn;
}

function setStep(rt: ExperienceRuntimeContext, state: ControlState, step: WizardStep): void {
  state.step = step;
  state.dom.stepTitle.textContent = STEP_TITLES[step];
  state.dom.stepHelp.textContent = STEP_HELP[step];
  state.dom.resetBtn.style.display = step === 'pool-corners' ? 'inline-block' : 'none';
  state.dom.nextBtn.disabled = !canAdvance(state);
  state.dom.backBtn.disabled = step === 'markers' || step === 'done' || step === 'compute';
  state.dom.nextBtn.textContent =
    step === 'preview' ? 'Done (Space)' : step === 'background' ? 'Continue (Space)' : 'Next (Space)';
  updateStatus(state);
  drawOverlay(state);

  void rt.events.emit(WIZARD_EVENTS.Step, { step });

  if (step === 'compute') {
    void runCompute(rt, state);
  } else if (step === 'background') {
    void runBackground(rt, state);
  }
}

function canAdvance(state: ControlState): boolean {
  switch (state.step) {
    case 'markers':
      // Allow advance even with partial detection; user knows best.
      return true;
    case 'pool-corners':
      return state.corners.length === 4;
    case 'compute':
      return false;
    case 'background':
      return !state.busy;
    case 'preview':
      return true;
    default:
      return false;
  }
}

function updateStatus(state: ControlState): void {
  let text = '';
  switch (state.step) {
    case 'markers':
      text = `markers detected: ${state.detectedMarkers}/${state.totalMarkers}`;
      break;
    case 'pool-corners':
      text = `corners: ${state.corners.length}/4`;
      break;
    case 'compute':
      text = 'computing…';
      break;
    case 'background':
      text = state.busy ? 'capturing background…' : 'click Continue to capture';
      break;
    case 'preview':
      text = 'press Done to finish';
      break;
    case 'done':
      text = 'done · closing';
      break;
    case 'abort':
      text = 'aborted';
      break;
  }
  state.dom.status.textContent = text;
  state.dom.nextBtn.disabled = !canAdvance(state);
}

function drawCamera(state: ControlState): void {
  const ctx = state.dom.cameraCanvas.getContext('2d');
  if (!ctx) return;
  const canvas = state.dom.cameraCanvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.camFrame) return;
  // Letterbox to preserve aspect ratio.
  const aspect = state.camFrame.naturalWidth / state.camFrame.naturalHeight;
  const cAspect = canvas.width / canvas.height;
  let dw, dh, dx, dy;
  if (aspect > cAspect) {
    dw = canvas.width;
    dh = canvas.width / aspect;
    dx = 0;
    dy = (canvas.height - dh) / 2;
  } else {
    dh = canvas.height;
    dw = canvas.height * aspect;
    dy = 0;
    dx = (canvas.width - dw) / 2;
  }
  ctx.drawImage(state.camFrame, dx, dy, dw, dh);
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;
const CORNER_HIT_RADIUS_PX = 28;

function drawOverlay(state: ControlState): void {
  const ctx = state.dom.overlay.getContext('2d');
  if (!ctx) return;
  const canvas = state.dom.overlay;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.step === 'pool-corners' && state.corners.length > 0) {
    const { dx, dy, dw, dh } = imageRectInCanvas(state);

    // Polygon fill + stroke
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.beginPath();
    state.corners.forEach((p, i) => {
      const x = dx + p.x * dw;
      const y = dy + p.y * dh;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (state.corners.length === 4) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(74,222,128,0.12)';
      ctx.fill();
    }
    ctx.stroke();

    // Corner handles with labels
    for (let i = 0; i < state.corners.length; i++) {
      const p = state.corners[i]!;
      const x = dx + p.x * dw;
      const y = dy + p.y * dh;
      const active = i === state.draggingIdx;
      const radius = active ? 12 : 8;
      ctx.fillStyle = active ? '#22d3ee' : '#4ade80';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Label
      ctx.fillStyle = '#000';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CORNER_LABELS[i] ?? `${i + 1}`, x, y);
    }
  }
}

function imageRectInCanvas(state: ControlState): {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
} {
  const canvas = state.dom.overlay;
  if (!state.camFrameSize) return { dx: 0, dy: 0, dw: canvas.width, dh: canvas.height };
  const aspect = state.camFrameSize.w / state.camFrameSize.h;
  const cAspect = canvas.width / canvas.height;
  if (aspect > cAspect) {
    const dw = canvas.width;
    const dh = canvas.width / aspect;
    return { dx: 0, dy: (canvas.height - dh) / 2, dw, dh };
  }
  const dh = canvas.height;
  const dw = canvas.height * aspect;
  return { dx: (canvas.width - dw) / 2, dy: 0, dw, dh };
}

/** Convert a MouseEvent to canvas-pixel coords. Uses the live rect-to-buffer
 * ratio (not `devicePixelRatio`) so hit-testing stays correct even if the
 * canvas buffer is briefly out of sync with the CSS box. */
function mouseToCanvas(state: ControlState, e: MouseEvent): { px: number; py: number } {
  const rect = state.dom.overlay.getBoundingClientRect();
  const scaleX = rect.width > 0 ? state.dom.overlay.width / rect.width : 1;
  const scaleY = rect.height > 0 ? state.dom.overlay.height / rect.height : 1;
  return { px: (e.clientX - rect.left) * scaleX, py: (e.clientY - rect.top) * scaleY };
}

/** Convert canvas-pixel coords to normalised image coords (0..1). */
function canvasToNorm(
  state: ControlState,
  px: number,
  py: number,
): { u: number; v: number } | null {
  const { dx, dy, dw, dh } = imageRectInCanvas(state);
  if (px < dx || py < dy || px > dx + dw || py > dy + dh) return null;
  return { u: (px - dx) / dw, v: (py - dy) / dh };
}

/** Find the index of the corner closest to (px, py), or -1. */
function hitTestCorner(state: ControlState, px: number, py: number): number {
  const { dx, dy, dw, dh } = imageRectInCanvas(state);
  const rect = state.dom.overlay.getBoundingClientRect();
  const scale = rect.width > 0 ? state.dom.overlay.width / rect.width : 1;
  const hitR = CORNER_HIT_RADIUS_PX * scale;
  let bestIdx = -1;
  let bestDist = hitR;
  for (let i = 0; i < state.corners.length; i++) {
    const p = state.corners[i]!;
    const cx = dx + p.x * dw;
    const cy = dy + p.y * dh;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function onPointerDown(rt: ExperienceRuntimeContext, state: ControlState, e: MouseEvent): void {
  if (state.step !== 'pool-corners') return;
  const { px, py } = mouseToCanvas(state, e);
  const hit = hitTestCorner(state, px, py);
  if (hit >= 0) {
    // Start dragging an existing corner.
    state.draggingIdx = hit;
    drawOverlay(state);
    return;
  }
  // No corner hit — add a new corner if fewer than 4 exist.
  if (state.corners.length >= 4) return;
  const norm = canvasToNorm(state, px, py);
  if (!norm) return;
  state.corners.push({ x: norm.u, y: norm.v });
  void rt.events.emit(WIZARD_EVENTS.Corners, { points: state.corners } satisfies CornersEvent);
  drawOverlay(state);
  updateStatus(state);
}

function onPointerMove(_rt: ExperienceRuntimeContext, state: ControlState, e: MouseEvent): void {
  if (state.step !== 'pool-corners') return;
  const { px, py } = mouseToCanvas(state, e);
  if (state.draggingIdx >= 0) {
    const norm = canvasToNorm(state, px, py);
    if (norm) {
      state.corners[state.draggingIdx] = { x: norm.u, y: norm.v };
      drawOverlay(state);
    }
    return;
  }
  // Cursor feedback: pointer near a handle, crosshair otherwise.
  const hit = hitTestCorner(state, px, py);
  state.dom.overlay.style.cursor = hit >= 0 ? 'grab' : 'crosshair';
}

function onPointerUp(rt: ExperienceRuntimeContext, state: ControlState, _e: MouseEvent): void {
  if (state.draggingIdx < 0) return;
  state.draggingIdx = -1;
  state.dom.overlay.style.cursor = 'crosshair';
  void rt.events.emit(WIZARD_EVENTS.Corners, { points: state.corners } satisfies CornersEvent);
  drawOverlay(state);
  updateStatus(state);
}

function resetCorners(rt: ExperienceRuntimeContext, state: ControlState): void {
  if (state.step !== 'pool-corners') return;
  state.corners = [];
  void rt.events.emit(WIZARD_EVENTS.Corners, { points: state.corners } satisfies CornersEvent);
  drawOverlay(state);
  updateStatus(state);
}

async function onKey(
  rt: ExperienceRuntimeContext,
  state: ControlState,
  e: KeyboardEvent,
): Promise<void> {
  if (state.step === 'markers') {
    let panHandled = true;
    switch (e.code) {
      case 'ArrowLeft':
        state.markerTransform.offsetX -= PAN_STEP;
        break;
      case 'ArrowRight':
        state.markerTransform.offsetX += PAN_STEP;
        break;
      case 'ArrowUp':
        state.markerTransform.offsetY -= PAN_STEP;
        break;
      case 'ArrowDown':
        state.markerTransform.offsetY += PAN_STEP;
        break;
      default:
        panHandled = false;
    }
    if (panHandled) {
      e.preventDefault();
      void rt.events.emit(WIZARD_EVENTS.MarkerTransform, {
        transform: state.markerTransform,
      } satisfies MarkerTransformEvent);
      return;
    }
  }

  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    await advance(rt, state);
  } else if (e.code === 'Backspace') {
    e.preventDefault();
    await revert(rt, state);
  } else if (e.code === 'Escape') {
    e.preventDefault();
    await abort(rt, state);
  } else if (e.code === 'KeyR') {
    e.preventDefault();
    resetCorners(rt, state);
  }
}

async function advance(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  if (!canAdvance(state)) return;
  const idx = ORDERED_STEPS.indexOf(state.step);
  if (idx < 0 || idx >= ORDERED_STEPS.length - 1) return;
  const next = ORDERED_STEPS[idx + 1]!;
  if (state.step === 'pool-corners') {
    await persistCorners(rt, state);
  }
  if (next === 'done') {
    setStep(rt, state, 'done');
    await rt.events.emit(WIZARD_EVENTS.Finished, { ok: true });
    return;
  }
  setStep(rt, state, next);
}

async function revert(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  if (state.step === 'markers' || state.step === 'done' || state.step === 'compute') return;
  const idx = ORDERED_STEPS.indexOf(state.step);
  if (idx <= 0) return;
  setStep(rt, state, ORDERED_STEPS[idx - 1]!);
}

async function abort(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  setStep(rt, state, 'abort');
  await rt.events.emit(WIZARD_EVENTS.Aborted, { ok: true });
  await rt.events.emit(WIZARD_EVENTS.Finished, { ok: false });
}

async function persistCorners(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  if (state.corners.length !== 4) return;
  const quad: FocusQuad = {
    points: [state.corners[0]!, state.corners[1]!, state.corners[2]!, state.corners[3]!],
  };
  await rt.storage.set(STORAGE_KEYS.FocusQuad, quad);
  rt.log.info('focus quad saved', { points: 4 });
}

async function runCompute(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  state.busy = true;
  updateStatus(state);
  try {
    // Send the focus_quad and frame_size to the driver so it can ALSO compute
    // the camera->surface homography (and where the surface lands in display
    // space). The surface reference resolution defaults to 1920x1080 -- it is
    // what apps render in. Falls back gracefully if the camera frame size has
    // not been observed yet.
    const surfaceSize: SizeXY = DEFAULT_SURFACE_SIZE;
    const focusQuadParam =
      state.corners.length === 4
        ? state.corners.map((p) => ({ x: p.x, y: p.y }))
        : undefined;
    const frameSizeParam = state.camFrameSize
      ? { width: state.camFrameSize.w, height: state.camFrameSize.h }
      : undefined;

    const result = (await rt.drivers.execute('calibration', 'compute', {
      focus_quad: focusQuadParam,
      frame_size: frameSizeParam,
      surface_size: surfaceSize,
    })) as {
      ok: boolean;
      error?: string;
      matrix?: number[];
      inverse?: number[];
      surface_matrix?: number[] | null;
      surface_inverse?: number[] | null;
      surface_quad_display?: Point2D[] | null;
      surface_size?: SizeXY | null;
      frame_size?: SizeXY | null;
      inliers?: number;
      samples?: number;
      markers?: number;
      reprojection_error_mean?: number;
      reprojection_error_max?: number;
    };
    if (!result.ok) {
      rt.log.error('compute failed', { err: result.error });
      state.dom.status.textContent = `compute failed: ${result.error ?? 'unknown'}`;
      state.dom.status.style.background = 'rgba(239,68,68,0.85)';
      state.busy = false;
      state.dom.backBtn.disabled = false;
      return;
    }
    if (Array.isArray(result.matrix)) {
      await rt.storage.set(STORAGE_KEYS.Homography, result.matrix);
      if (Array.isArray(result.inverse)) {
        await rt.storage.set(STORAGE_KEYS.HomographyInverse, result.inverse);
      }
      // Surface-space matrices (camera -> apps' reference space).
      if (Array.isArray(result.surface_matrix)) {
        await rt.storage.set(STORAGE_KEYS.HomographySurface, result.surface_matrix);
      } else {
        // Clear any stale surface matrix so apps fall back cleanly.
        await rt.storage.remove(STORAGE_KEYS.HomographySurface).catch(() => undefined);
      }
      if (Array.isArray(result.surface_inverse)) {
        await rt.storage.set(STORAGE_KEYS.HomographySurfaceInverse, result.surface_inverse);
      } else {
        await rt.storage
          .remove(STORAGE_KEYS.HomographySurfaceInverse)
          .catch(() => undefined);
      }
      // Where the physical surface lands in display space, needed for CSS
      // matrix3d keystone correction in consumer apps.
      if (Array.isArray(result.surface_quad_display) && result.surface_quad_display.length === 4) {
        const quadDisplay: SurfaceQuadDisplay = {
          points: [
            result.surface_quad_display[0]!,
            result.surface_quad_display[1]!,
            result.surface_quad_display[2]!,
            result.surface_quad_display[3]!,
          ],
        };
        await rt.storage.set(STORAGE_KEYS.SurfaceQuadDisplay, quadDisplay);
      } else {
        await rt.storage.remove(STORAGE_KEYS.SurfaceQuadDisplay).catch(() => undefined);
      }
      if (result.surface_size) {
        await rt.storage.set(STORAGE_KEYS.SurfaceSize, result.surface_size);
      }
      if (result.frame_size) {
        await rt.storage.set(STORAGE_KEYS.FrameSize, result.frame_size);
      }
      const errMean = result.reprojection_error_mean ?? 0;
      const errMax = result.reprojection_error_max ?? 0;
      rt.log.info('homography persisted', {
        inliers: result.inliers,
        samples: result.samples,
        markers: result.markers,
        errorMean: errMean,
        errorMax: errMax,
        surface: Array.isArray(result.surface_matrix),
      });
    }
  } catch (err) {
    rt.log.error('compute threw', { err: String(err) });
    state.dom.status.textContent = `compute error: ${String(err)}`;
    state.dom.status.style.background = 'rgba(239,68,68,0.85)';
    state.busy = false;
    state.dom.backBtn.disabled = false;
    return;
  }
  state.busy = false;
  setStep(rt, state, 'background');
}

async function runBackground(rt: ExperienceRuntimeContext, state: ControlState): Promise<void> {
  // The dashboard listens for the step event and will hide this window before
  // calling `capture_background`. The control window stays responsive though;
  // we wait for the window to be visually hidden, then ask the driver for the
  // latest frame and save it. The dashboard will re-show the window once we
  // emit the next step.
  state.busy = true;
  updateStatus(state);
  await wait(700);
  try {
    const result = (await rt.drivers.execute('calibration', 'capture_background', null)) as {
      ok: boolean;
      error?: string;
      jpeg_base64?: string;
    };
    if (!result.ok || typeof result.jpeg_base64 !== 'string') {
      rt.log.error('background capture failed', { err: result.error });
      state.dom.status.textContent = `background capture failed: ${result.error ?? 'unknown'}`;
      state.dom.status.style.background = 'rgba(239,68,68,0.85)';
      state.busy = false;
      // Allow retry via Back -> Next.
      return;
    }
    await rt.storage.set(STORAGE_KEYS.BackgroundJpeg, result.jpeg_base64);
    rt.log.info('background captured', { kb: Math.round(result.jpeg_base64.length / 1024) });
    await rt.events.emit(WIZARD_EVENTS.BackgroundCaptured, { ok: true });
  } catch (err) {
    rt.log.error('background capture threw', { err: String(err) });
    state.dom.status.textContent = `background capture error: ${String(err)}`;
    state.dom.status.style.background = 'rgba(239,68,68,0.85)';
    state.busy = false;
    return;
  }
  state.busy = false;
  setStep(rt, state, 'preview');
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
