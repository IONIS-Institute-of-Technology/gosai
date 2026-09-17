/**
 * The control window: runs the wizard (see wizard.ts), shows the camera feed,
 * collects the surface corners, owns the projector's marker pan and zoom,
 * and saves the target app's profile once the operator accepts the preview.
 *
 * Keys: arrows pan and the wheel zooms the markers, Space or Enter goes on,
 * Backspace goes back, Escape cancels, r resets the corners.
 */

import {
  CalibrationWizardTopics,
  computeFit,
  finishCalibration,
  loadCameraProjectorSurfaceCalibration,
  saveCameraProjectorSurfaceCalibration,
  type CalibrationPoint,
  type CameraProjectorSurfaceStep,
  type ExperienceRuntimeContext,
} from '@gosai/sdk';
import type { CalibrationTarget } from './calibrate.js';
import {
  DEFAULT_MARKER_TRANSFORM,
  MARKER_COUNT,
  MARKER_TRANSFORM_TOPIC,
  MAX_SCALE,
  MIN_SCALE,
  PAN_STEP,
  ZOOM_STEP,
  cornerLabels,
  setBodyFullscreen,
  type MarkerTransform,
  type StepEvent,
} from './shared.js';
import {
  addCorner,
  advance,
  canAdvance,
  canGoBack,
  cancel,
  computeFailed,
  computeSucceeded,
  goBack,
  initialWizard,
  moveCorner,
  resetCorners,
  saveFailed,
  saveSucceeded,
  toCalibration,
  type ComputeResult,
  type WizardState,
  type WizardStep,
} from './wizard.js';

const STEP_TITLES: Record<WizardStep, string> = {
  markers: 'Step 1 · ArUco Markers',
  'surface-corners': 'Step 2 · Surface Corners',
  compute: 'Step 3 · Compute Homography',
  preview: 'Step 4 · Preview',
  done: 'Calibration Complete',
  cancelled: 'Cancelled',
};

const STEP_HELP: Record<WizardStep, string> = {
  markers: `Aim the camera so all ${MARKER_COUNT} markers are visible. Use [Arrow keys] to pan and [Scroll wheel] to zoom the pattern to fit the surface. Press [Space] / Next when ready.`,
  'surface-corners':
    'Click to place surface corners (top-left → clockwise). Drag an existing corner to adjust it. Press [r] to reset all, [Space] / Next when 4 corners are placed.',
  compute: 'Computing the camera→display homography. This should only take a moment.',
  preview:
    'Check that the calibration looks right. Press [Space] / Done to save or [Backspace] to pick the corners again.',
  done: 'Calibration saved. Closing windows…',
  cancelled: 'Calibration cancelled. Nothing was saved.',
};

const CORNER_HIT_RADIUS_PX = 28;

interface View {
  readonly root: HTMLDivElement;
  readonly stepTitle: HTMLDivElement;
  readonly stepHelp: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly camera: CanvasRenderingContext2D;
  readonly overlay: CanvasRenderingContext2D;
  readonly status: HTMLDivElement;
  readonly back: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly reset: HTMLButtonElement;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Starts the control window. Returns what removes it. */
export async function startControl(
  rt: ExperienceRuntimeContext,
  target: CalibrationTarget,
): Promise<() => void> {
  rt.log.info('control window starting', { target: target.appSlug });
  // Start from the corners of the last calibration, so a recalibration keeps them.
  const previous = await loadCameraProjectorSurfaceCalibration(rt, { appSlug: target.appSlug });
  const view = createView();
  new ControlWindow(rt, target, view, initialWizard(previous?.focusQuad ?? [])).start();
  return () => view.root.remove();
}

class ControlWindow {
  private frame: HTMLImageElement | null = null;
  private detectedMarkers = 0;
  private transform: MarkerTransform = DEFAULT_MARKER_TRANSFORM;
  private dragging = -1;

  constructor(
    private readonly rt: ExperienceRuntimeContext,
    private readonly target: CalibrationTarget,
    private readonly view: View,
    private wizard: WizardState,
  ) {}

  start(): void {
    const { rt, view } = this;
    const signal = rt.signal;

    rt.drivers.on('camera', 'color', (payload) => {
      const jpeg = (payload as { jpeg_base64?: unknown } | null)?.jpeg_base64;
      if (typeof jpeg !== 'string') return;
      const img = new Image();
      img.onload = () => {
        this.frame = img;
        this.draw();
      };
      img.src = `data:image/jpeg;base64,${jpeg}`;
    });
    rt.drivers.on('calibration', 'detection', (payload) => {
      const detected = (payload as { detected?: unknown } | null)?.detected;
      if (typeof detected !== 'number') return;
      this.detectedMarkers = detected;
      this.updateStatus();
    });

    // The header's help text wraps differently between steps, which resizes
    // the body without a window resize.
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(view.body);
    signal.addEventListener('abort', () => resize.disconnect());

    const overlay = view.overlay.canvas;
    overlay.addEventListener('mousedown', (e) => this.pointerDown(e), { signal });
    overlay.addEventListener('mousemove', (e) => this.pointerMove(e), { signal });
    window.addEventListener('mouseup', () => this.pointerUp(), { signal });
    document.addEventListener('keydown', (e) => this.key(e), { signal });
    document.addEventListener('wheel', (e) => this.wheel(e), { passive: false, signal });
    view.next.addEventListener('click', () => this.next(), { signal });
    view.back.addEventListener('click', () => this.back(), { signal });
    view.cancel.addEventListener('click', () => this.cancel(), { signal });
    view.reset.addEventListener('click', () => this.update(resetCorners(this.wizard)), { signal });

    this.resize();
    this.render();
    this.broadcastStep();
  }

  /** Applies a wizard transition, then tells the projector and runs the step's work. */
  private update(next: WizardState): void {
    const stepChanged = next.step !== this.wizard.step;
    this.wizard = next;
    this.render();
    if (!stepChanged) return;
    this.broadcastStep();
    if (next.step === 'compute') void this.compute();
  }

  private next(): void {
    const next = advance(this.wizard);
    if (next === this.wizard) return;
    this.update(next);
    if (next.saving) void this.save();
  }

  private back(): void {
    this.update(goBack(this.wizard));
  }

  private cancel(): void {
    // No cancel once the flow is over, or while the profile saves.
    const next = cancel(this.wizard);
    if (next === this.wizard) return;
    this.update(next);
    void this.finish({ ok: false, cancelled: true, error: 'Calibration cancelled' });
  }

  private async compute(): Promise<void> {
    const { rt, wizard } = this;
    const frame = this.frame;
    try {
      const result = await rt.drivers.execute<ComputeResult>('calibration', 'compute', {
        focus_quad: wizard.corners,
        frame_size: frame ? { width: frame.naturalWidth, height: frame.naturalHeight } : undefined,
        surface_size: this.target.options.surfaceSize,
      });
      const converted = toCalibration(result, wizard.corners);
      if (!converted.ok) throw new Error(converted.error);
      rt.log.info('homography computed', {
        markers: result.markers,
        inliers: result.inliers,
        errorMean: result.reprojection_error_mean,
        errorMax: result.reprojection_error_max,
        surface: result.surface_matrix !== null,
      });
      this.update(computeSucceeded(this.wizard, converted.calibration));
    } catch (err) {
      // The driver rejects when it can't compute, e.g. with too few markers.
      const message = err instanceof Error ? err.message : String(err);
      rt.log.warn('compute failed', { err: message });
      this.update(computeFailed(this.wizard, `compute failed: ${message}`));
    }
  }

  private async save(): Promise<void> {
    const calibration = this.wizard.calibration;
    if (!calibration) return;
    try {
      await saveCameraProjectorSurfaceCalibration(this.rt, calibration, {
        appSlug: this.target.appSlug,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.rt.log.error('saving the calibration failed', { err: message });
      this.update(saveFailed(this.wizard, `saving failed: ${message}`));
      return;
    }
    this.update(saveSucceeded(this.wizard));
    await this.finish({ ok: true });
  }

  private async finish(result: Parameters<typeof finishCalibration>[1]): Promise<void> {
    try {
      await finishCalibration(this.rt, result);
    } catch (err) {
      this.rt.log.error('could not report the end of the calibration', { err: String(err) });
    }
  }

  private broadcastStep(): void {
    const { step, calibration } = this.wizard;
    if (step !== 'preview') {
      this.emit(CalibrationWizardTopics.Step, { step } satisfies StepEvent);
    } else if (calibration) {
      const { homography, surfaceQuadDisplay } = calibration;
      this.emit(CalibrationWizardTopics.Step, {
        step,
        homography,
        surfaceQuadDisplay,
      } satisfies StepEvent);
    }
  }

  private emit(topic: string, data: unknown): void {
    this.rt.events
      .emit(topic, data)
      .catch((err: unknown) => this.rt.log.warn(`${topic} broadcast failed`, { err: String(err) }));
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private key(e: KeyboardEvent): void {
    if (this.wizard.step === 'markers') {
      const pan: Record<string, [number, number]> = {
        ArrowLeft: [-PAN_STEP, 0],
        ArrowRight: [PAN_STEP, 0],
        ArrowUp: [0, -PAN_STEP],
        ArrowDown: [0, PAN_STEP],
      };
      const delta = pan[e.code];
      if (delta) {
        e.preventDefault();
        this.setTransform({
          ...this.transform,
          offsetX: this.transform.offsetX + delta[0],
          offsetY: this.transform.offsetY + delta[1],
        });
        return;
      }
    }
    const actions: Record<string, () => void> = {
      Space: () => this.next(),
      Enter: () => this.next(),
      Backspace: () => this.back(),
      Escape: () => this.cancel(),
      KeyR: () => this.update(resetCorners(this.wizard)),
    };
    const action = actions[e.code];
    if (!action) return;
    e.preventDefault();
    action();
  }

  private wheel(e: WheelEvent): void {
    if (this.wizard.step !== 'markers') return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, this.transform.scale + direction * ZOOM_STEP),
    );
    this.setTransform({ ...this.transform, scale });
  }

  private setTransform(transform: MarkerTransform): void {
    this.transform = transform;
    this.emit(MARKER_TRANSFORM_TOPIC, transform);
    this.updateStatus();
  }

  private pointerDown(e: MouseEvent): void {
    if (this.wizard.step !== 'surface-corners') return;
    const point = this.canvasPoint(e);
    const hit = this.hitCorner(point);
    if (hit >= 0) {
      this.dragging = hit;
      this.drawOverlay();
      return;
    }
    const corner = this.normalised(point);
    if (corner) this.update(addCorner(this.wizard, corner));
  }

  private pointerMove(e: MouseEvent): void {
    if (this.wizard.step !== 'surface-corners') return;
    const point = this.canvasPoint(e);
    if (this.dragging >= 0) {
      const corner = this.normalised(point);
      if (corner) this.update(moveCorner(this.wizard, this.dragging, corner));
      return;
    }
    this.view.overlay.canvas.style.cursor = this.hitCorner(point) >= 0 ? 'grab' : 'crosshair';
  }

  private pointerUp(): void {
    if (this.dragging < 0) return;
    this.dragging = -1;
    this.view.overlay.canvas.style.cursor = 'crosshair';
    this.drawOverlay();
  }

  /** A mouse position in canvas pixels, from the live CSS box, which may lag the backing store. */
  private canvasPoint(e: MouseEvent): CalibrationPoint {
    const canvas = this.view.overlay.canvas;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (rect.width > 0 ? canvas.width / rect.width : 1),
      y: (e.clientY - rect.top) * (rect.height > 0 ? canvas.height / rect.height : 1),
    };
  }

  /** A canvas point in normalised camera coordinates, or `null` outside the image. */
  private normalised(point: CalibrationPoint): CalibrationPoint | null {
    const image = this.imageRect();
    const x = (point.x - image.x) / image.width;
    const y = (point.y - image.y) / image.height;
    return x < 0 || y < 0 || x > 1 || y > 1 ? null : { x, y };
  }

  private hitCorner(point: CalibrationPoint): number {
    const canvas = this.view.overlay.canvas;
    const rect = canvas.getBoundingClientRect();
    let best = -1;
    let bestDistance = CORNER_HIT_RADIUS_PX * (rect.width > 0 ? canvas.width / rect.width : 1);
    this.wizard.corners.forEach((corner, index) => {
      const at = this.toCanvas(corner);
      const distance = Math.hypot(point.x - at.x, point.y - at.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  /** Where the letterboxed camera image sits in the canvases. */
  private imageRect(): Rect {
    const { width, height } = this.view.camera.canvas;
    const frame = this.frame;
    if (!frame) return { x: 0, y: 0, width, height };
    const reference = { width: frame.naturalWidth, height: frame.naturalHeight };
    const fit = computeFit({ width, height }, reference, 'contain');
    return {
      x: fit.offsetX,
      y: fit.offsetY,
      width: reference.width * fit.scaleX,
      height: reference.height * fit.scaleY,
    };
  }

  private toCanvas(corner: CalibrationPoint): CalibrationPoint {
    const image = this.imageRect();
    return { x: image.x + corner.x * image.width, y: image.y + corner.y * image.height };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.view.body.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    for (const canvas of [this.view.camera.canvas, this.view.overlay.canvas]) {
      if (canvas.width === width && canvas.height === height) continue;
      canvas.width = width;
      canvas.height = height;
    }
    this.draw();
  }

  private render(): void {
    const { view, wizard } = this;
    const copy = this.stepCopy(wizard.step);
    view.stepTitle.textContent = copy.title;
    view.stepHelp.textContent = copy.help;
    view.reset.style.display = wizard.step === 'surface-corners' ? 'inline-block' : 'none';
    view.back.disabled = !canGoBack(wizard);
    view.next.disabled = !canAdvance(wizard);
    view.next.textContent = wizard.step === 'preview' ? 'Done (Space)' : 'Next (Space)';
    this.updateStatus();
    this.drawOverlay();
  }

  private stepCopy(step: WizardStep): { title: string; help: string } {
    const custom = isFlowStep(step) ? this.target.options.stepCopy?.[step] : undefined;
    return { title: custom?.title ?? STEP_TITLES[step], help: custom?.help ?? STEP_HELP[step] };
  }

  private updateStatus(): void {
    const { wizard, transform } = this;
    const texts: Record<WizardStep, string> = {
      markers: `markers detected: ${this.detectedMarkers}/${MARKER_COUNT} · ↔ ${transform.offsetX} ↕ ${transform.offsetY} · zoom ${Math.round(transform.scale * 100)}%`,
      'surface-corners': `corners: ${wizard.corners.length}/4`,
      compute: 'computing…',
      preview: wizard.saving ? 'saving…' : 'press Done to save',
      done: 'saved · closing',
      cancelled: 'cancelled',
    };
    const error =
      wizard.step === 'surface-corners' || wizard.step === 'preview' ? wizard.error : null;
    this.view.status.textContent = error ? `${texts[wizard.step]} · ${error}` : texts[wizard.step];
    this.view.status.style.background = error ? 'rgba(239,68,68,0.85)' : 'rgba(0,0,0,0.7)';
  }

  private draw(): void {
    const ctx = this.view.camera;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (this.frame) {
      const image = this.imageRect();
      ctx.drawImage(this.frame, image.x, image.y, image.width, image.height);
    }
    this.drawOverlay();
  }

  private drawOverlay(): void {
    const ctx = this.view.overlay;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const corners = this.wizard.corners.map((corner) => this.toCanvas(corner));
    if (this.wizard.step !== 'surface-corners' || corners.length === 0) return;

    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 3;
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (corners.length === 4) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(74,222,128,0.12)';
      ctx.fill();
    }
    ctx.stroke();

    const labels = cornerLabels(this.target.options);
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    corners.forEach((p, i) => {
      const active = i === this.dragging;
      ctx.fillStyle = active ? '#22d3ee' : '#4ade80';
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 12 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.fillText(labels[i] ?? `${i + 1}`, p.x, p.y);
    });
  }
}

function isFlowStep(step: WizardStep): step is CameraProjectorSurfaceStep {
  return step !== 'done' && step !== 'cancelled';
}

function createView(): View {
  setBodyFullscreen('#0a0a0a');
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    css: string,
    parent: HTMLElement,
  ): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    el.style.cssText = css;
    parent.appendChild(el);
    return el;
  };

  const root = element(
    'div',
    'position:fixed;inset:0;display:flex;flex-direction:column;background:#0a0a0a;color:#fff;font:13px ui-monospace,monospace;',
    document.body,
  );
  const header = element(
    'div',
    'padding:12px 16px;border-bottom:1px solid #222;background:#111;display:flex;flex-direction:column;gap:4px;',
    root,
  );
  const stepTitle = element('div', 'font-size:14px;font-weight:600;color:#f5f5f5;', header);
  const stepHelp = element('div', 'font-size:12px;color:#a3a3a3;line-height:1.4;', header);
  const body = element(
    'div',
    'flex:1;position:relative;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center;',
    root,
  );
  const camera = context2d(
    element('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block;', body),
  );
  const overlay = context2d(
    element(
      'canvas',
      'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair;',
      body,
    ),
  );
  const status = element(
    'div',
    'position:absolute;top:8px;right:8px;background:rgba(0,0,0,0.7);padding:6px 10px;border-radius:4px;font-size:11px;color:#d4d4d4;max-width:70%;',
    body,
  );
  const footer = element(
    'div',
    'padding:10px 16px;border-top:1px solid #222;background:#111;display:flex;gap:8px;align-items:center;',
    root,
  );
  const button = (text: string, color = '#1f2937'): HTMLButtonElement => {
    const btn = element(
      'button',
      `background:${color};color:#fff;border:1px solid rgba(255,255,255,0.08);padding:8px 14px;font:12px ui-monospace,monospace;cursor:pointer;border-radius:4px;`,
      footer,
    );
    btn.textContent = text;
    return btn;
  };
  const cancelButton = button('Cancel (Esc)', '#7f1d1d');
  const reset = button('Reset corners (r)');
  element('div', 'flex:1;', footer);
  const back = button('Back (⌫)');
  const next = button('Next (Space)', '#166534');

  return {
    root,
    stepTitle,
    stepHelp,
    body,
    camera,
    overlay,
    status,
    back,
    next,
    cancel: cancelButton,
    reset,
  };
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  return ctx;
}
