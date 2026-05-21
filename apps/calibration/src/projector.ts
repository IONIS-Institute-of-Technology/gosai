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

import {
  type AppEventsSubscription,
  type DriverSubscription,
  type ExperienceRuntimeContext,
  computeCSSMatrix3d,
  perspectiveTransformPoint,
  type Point2D,
} from '@gosai/sdk';
import {
  WIZARD_EVENTS,
  STORAGE_KEYS,
  type MarkerImage,
  type MarkerSlot,
  type MarkerTransform,
  type MarkerTransformEvent,
  type StepEvent,
  type SurfaceQuadDisplay,
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
  /** SVG overlay drawn on top of the warped preview: shows the focus quad in
   * display space so the user can visually confirm the warp is consistent. */
  previewOverlay: SVGSVGElement;
  step: WizardStep;
  layout: MarkerSlot[];
  transform: MarkerTransform;
  /** Last known camera frame size; used to scale the preview img to its
   * natural dimensions before applying the camera->display warp. */
  previewFrameSize: { w: number; h: number } | null;
  /** Whether the preview img has been positioned/styled for the warp yet. */
  previewWarpApplied: boolean;
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
    'position:absolute;inset:0;width:100vw;height:100vh;object-fit:contain;display:none;opacity:0.85;';
  root.appendChild(previewImg);

  // SVG overlay drawn on the same plane as the projector window (not warped)
  // so we can highlight the focus_quad in display space for visual sanity
  // checks during the preview step.
  const previewOverlay = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'svg',
  ) as SVGSVGElement;
  previewOverlay.setAttribute('width', '100%');
  previewOverlay.setAttribute('height', '100%');
  previewOverlay.style.cssText =
    'position:absolute;inset:0;width:100vw;height:100vh;pointer-events:none;display:none;';
  root.appendChild(previewOverlay);

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
    previewOverlay,
    step: 'markers',
    layout: [],
    transform: { ...DEFAULT_MARKER_TRANSFORM },
    previewFrameSize: null,
    previewWarpApplied: false,
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

  // Camera feed for the live preview step. We also pluck the frame width and
  // height so the perspective warp can size the preview img to its native
  // dimensions (otherwise the matrix3d math is off).
  state.driverSubs.push(
    rt.drivers.on('camera', 'color', (payload) => {
      if (state.step !== 'preview') return;
      const data = payload as { jpeg_base64?: string; width?: number; height?: number };
      if (typeof data?.jpeg_base64 !== 'string') return;
      state.previewImg.src = `data:image/jpeg;base64,${data.jpeg_base64}`;
      if (typeof data.width === 'number' && typeof data.height === 'number') {
        const next = { w: data.width, h: data.height };
        const prev = state.previewFrameSize;
        if (!prev || prev.w !== next.w || prev.h !== next.h) {
          state.previewFrameSize = next;
          // If the warp was already set up we need to re-apply it with the
          // updated frame size.
          state.previewWarpApplied = false;
          void applyPreviewWarp(rt, state);
        }
      }
    }),
  );

  state.eventSubs.push(
    rt.events.on(WIZARD_EVENTS.Step, (payload) => {
      const data = payload as StepEvent;
      applyStep(state, data.step, data.message);
      if (data.step === 'preview') {
        // Lazily fetch the freshly-computed homography and warp the camera
        // preview into display space. This makes the projected camera feed
        // land exactly on the physical surface -- the central success
        // criterion the user wants to verify here.
        void applyPreviewWarp(rt, state);
      } else if (state.previewWarpApplied) {
        resetPreviewWarp(state);
      }
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

/**
 * Apply a CSS `matrix3d` to the preview image so the camera feed -- projected
 * by the projector -- lands exactly on the physical surface it was captured
 * from. The img element is sized to the camera frame's native dimensions and
 * its (0, 0) -> (frameW, frameH) box is mapped via the camera->display
 * homography. When the projector itself is aligned with the table, this
 * makes the projected camera feed coincide with the real-world objects.
 *
 * Requires (a) the compute step to have stored the homography in app
 * storage and (b) at least one camera frame to have arrived so we know the
 * frame's native dimensions.
 */
async function applyPreviewWarp(
  rt: ExperienceRuntimeContext,
  state: ProjectorState,
): Promise<void> {
  if (state.step !== 'preview' || state.previewWarpApplied) return;
  if (!state.previewFrameSize) return;

  // Pull the homography we just computed; fall back to the legacy stretched
  // preview if it is missing (e.g. user re-entered preview before compute).
  const homography = await rt.storage.get<number[]>(STORAGE_KEYS.Homography).catch(() => null);
  if (!homography || !Array.isArray(homography) || homography.length !== 9) {
    rt.log.warn('preview warp: homography not found, falling back to letterbox');
    return;
  }

  const { w: cw, h: ch } = state.previewFrameSize;
  const dispW = window.innerWidth;
  const dispH = window.innerHeight;

  // Warp the four corners of the camera frame to display space.
  const corners: Point2D[] = [
    perspectiveTransformPoint(homography, 0, 0),
    perspectiveTransformPoint(homography, cw, 0),
    perspectiveTransformPoint(homography, cw, ch),
    perspectiveTransformPoint(homography, 0, ch),
  ];

  // If the warped image lands entirely outside the projector window we have
  // a stale or bogus homography -- keep the legacy letterbox preview rather
  // than throwing a confusing all-black screen at the user.
  const intersects = corners.some(
    (c) => c.x >= 0 && c.x <= dispW && c.y >= 0 && c.y <= dispH,
  );
  if (!intersects) {
    rt.log.warn('preview warp: warped corners do not intersect display, skipping');
    return;
  }

  // Size the img element to its intrinsic camera dimensions, anchor at the
  // origin, and let matrix3d move it.
  const img = state.previewImg;
  img.style.position = 'absolute';
  img.style.left = '0';
  img.style.top = '0';
  img.style.right = 'auto';
  img.style.bottom = 'auto';
  img.style.width = `${cw}px`;
  img.style.height = `${ch}px`;
  img.style.objectFit = 'fill';
  img.style.transformOrigin = '0 0';
  img.style.backfaceVisibility = 'hidden';
  try {
    img.style.transform = computeCSSMatrix3d(cw, ch, [
      corners[0]!,
      corners[1]!,
      corners[2]!,
      corners[3]!,
    ]);
  } catch (err) {
    rt.log.warn('preview warp: matrix3d compute failed', { err: String(err) });
    return;
  }

  state.previewWarpApplied = true;

  // Also load the surface quad in display space (the user-picked pool corners
  // warped to projector pixels) and draw a thin guideline polygon so the user
  // can visually confirm the projection aligns with the physical surface.
  const surfaceQuadDisplay = await rt.storage
    .get<SurfaceQuadDisplay>(STORAGE_KEYS.SurfaceQuadDisplay)
    .catch(() => null);
  drawPreviewOverlay(state, dispW, dispH, surfaceQuadDisplay);
}

function resetPreviewWarp(state: ProjectorState): void {
  state.previewWarpApplied = false;
  const img = state.previewImg;
  img.style.transform = '';
  img.style.transformOrigin = '';
  img.style.width = '100vw';
  img.style.height = '100vh';
  img.style.left = '';
  img.style.top = '';
  img.style.right = '';
  img.style.bottom = '';
  img.style.objectFit = 'contain';
  state.previewOverlay.style.display = 'none';
  while (state.previewOverlay.firstChild) {
    state.previewOverlay.removeChild(state.previewOverlay.firstChild);
  }
}

function drawPreviewOverlay(
  state: ProjectorState,
  dispW: number,
  dispH: number,
  surfaceQuadDisplay: SurfaceQuadDisplay | null,
): void {
  const overlay = state.previewOverlay;
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  overlay.setAttribute('viewBox', `0 0 ${dispW} ${dispH}`);

  if (surfaceQuadDisplay?.points?.length === 4) {
    const ns = 'http://www.w3.org/2000/svg';
    const polygon = document.createElementNS(ns, 'polygon');
    polygon.setAttribute(
      'points',
      surfaceQuadDisplay.points.map((p) => `${p.x},${p.y}`).join(' '),
    );
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', '#4ade80');
    polygon.setAttribute('stroke-width', '4');
    polygon.setAttribute('stroke-dasharray', '14 10');
    overlay.appendChild(polygon);

    // Corner labels (TL/TR/BR/BL) help the operator spot a flipped or
    // mis-clicked corner immediately.
    const labels = ['TL', 'TR', 'BR', 'BL'];
    surfaceQuadDisplay.points.forEach((p, i) => {
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(p.x + 12));
      text.setAttribute('y', String(p.y - 12));
      text.setAttribute('fill', '#4ade80');
      text.setAttribute('font-family', 'ui-monospace, monospace');
      text.setAttribute('font-size', '16');
      text.textContent = labels[i] ?? '';
      overlay.appendChild(text);
    });
  }
  overlay.style.display = 'block';
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
  state.blackLayer.style.background = 'rgba(0,0,0,0)';

  state.status.style.display = step === 'preview' ? 'none' : 'block';

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
