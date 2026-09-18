/**
 * The projector window, fullscreen on the target app's display. It only
 * follows the control window:
 *
 * - `markers`: the ArUco grid, panned and zoomed from the control window,
 * - `preview`: the camera feed warped through the computed homography, so it
 *   lands on the physical surface, with the surface corners outlined,
 * - other steps: a status line.
 */

import {
  CalibrationWizardTopics,
  applyQuadWarp,
  clearQuadWarp,
  type CalibrationQuad,
  type CalibrationSize,
  type DriverTypes,
  type ExperienceRuntimeContext,
} from '@gosai/sdk';
import type { CalibrationTarget } from './calibrate.js';
import {
  DEFAULT_MARKER_TRANSFORM,
  MARKER_TRANSFORM_TOPIC,
  applyTransformToLayout,
  cornerLabels,
  makeMarkerLayout,
  setBodyFullscreen,
  type MarkerSlot,
  type MarkerTransform,
  type StepEvent,
} from './shared.js';
import { frameQuadInDisplay } from './wizard.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARKER_IMAGE_SIZE = 200;

interface View {
  readonly root: HTMLDivElement;
  readonly markers: HTMLDivElement;
  readonly preview: HTMLImageElement;
  readonly outline: SVGSVGElement;
  readonly status: HTMLDivElement;
}

/** Starts the projector window. Returns what removes it. */
export async function startProjector(
  rt: ExperienceRuntimeContext,
  target: CalibrationTarget,
): Promise<() => void> {
  rt.log.info('projector window starting', { target: target.appSlug });
  const view = createView();
  const projector = new ProjectorWindow(rt, target, view);
  await projector.start();
  return () => view.root.remove();
}

class ProjectorWindow {
  private readonly width = window.innerWidth;
  private readonly height = window.innerHeight;
  private readonly layout: readonly MarkerSlot[] = makeMarkerLayout(this.width, this.height);
  private transform: MarkerTransform = DEFAULT_MARKER_TRANSFORM;
  private step: StepEvent = { step: 'markers' };
  private frameSize: CalibrationSize | null = null;

  constructor(
    private readonly rt: ExperienceRuntimeContext,
    private readonly target: CalibrationTarget,
    private readonly view: View,
  ) {}

  async start(): Promise<void> {
    const { rt } = this;
    rt.events.on(MARKER_TRANSFORM_TOPIC, (payload) => {
      this.transform = payload as MarkerTransform;
      this.applyTransform();
    });
    rt.events.on(CalibrationWizardTopics.Step, (payload) => this.show(payload as StepEvent));
    rt.drivers.on('camera', 'color', (payload) => this.previewFrame(payload));

    this.show(this.step);
    await this.drawMarkers();
    await rt.drivers.execute('calibration', 'set_marker_layout', this.layout);
  }

  private async drawMarkers(): Promise<void> {
    for (const slot of this.layout) {
      try {
        const marker = await this.rt.drivers.execute('calibration', 'render_marker', {
          id: slot.id,
          size: MARKER_IMAGE_SIZE,
        });
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${marker.png_base64}`;
        img.style.cssText = `position:absolute;left:${slot.x - slot.size / 2}px;top:${slot.y - slot.size / 2}px;width:${slot.size}px;height:${slot.size}px;image-rendering:pixelated;`;
        this.view.markers.appendChild(img);
      } catch (err) {
        this.rt.log.warn('marker render failed', { id: slot.id, err: String(err) });
      }
    }
  }

  /** Moves the drawn markers and tells the driver where they are now. */
  private applyTransform(): void {
    const { offsetX, offsetY, scale } = this.transform;
    const markers = this.view.markers.style;
    markers.transformOrigin = `${this.width / 2}px ${this.height / 2}px`;
    markers.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    const layout = applyTransformToLayout(this.layout, this.transform, this.width, this.height);
    this.rt.drivers
      .execute('calibration', 'set_marker_layout', layout)
      .catch((err: unknown) => this.rt.log.warn('set_marker_layout failed', { err: String(err) }));
    if (this.step.step === 'markers') this.setStatus(this.markersStatus());
  }

  private show(event: StepEvent): void {
    this.step = event;
    const { view } = this;
    const messages = this.target.options.projectorMessages;
    view.markers.style.display = event.step === 'markers' ? 'block' : 'none';
    view.preview.style.display = event.step === 'preview' ? 'block' : 'none';
    clearQuadWarp(view.preview);
    view.outline.replaceChildren();

    switch (event.step) {
      case 'markers':
        this.setStatus(this.markersStatus());
        break;
      case 'surface-corners':
        this.setStatus(messages?.surfaceCorners ?? 'pick surface corners on the control window');
        break;
      case 'compute':
        this.setStatus(messages?.compute ?? 'computing homography…');
        break;
      case 'preview':
        this.setStatus(null);
        this.warpPreview();
        this.outlineSurface(event.surfaceQuadDisplay);
        break;
      case 'done':
        this.setStatus(messages?.done ?? 'calibration complete');
        break;
      case 'cancelled':
        this.setStatus(messages?.cancelled ?? 'calibration cancelled');
        break;
    }
  }

  private previewFrame(frame: DriverTypes.camera.ColorPayload): void {
    if (this.step.step !== 'preview') return;
    this.view.preview.src = `data:image/jpeg;base64,${frame.jpeg_base64}`;
    if (frame.width === this.frameSize?.width && frame.height === this.frameSize.height) return;
    this.frameSize = { width: frame.width, height: frame.height };
    this.warpPreview();
  }

  /**
   * Warps the camera image through the camera->display homography, so the
   * projected feed lands on the objects it shows. Without a frame size yet,
   * or when a frame corner maps to infinity, the preview stays letterboxed.
   */
  private warpPreview(): void {
    const { step } = this;
    if (step.step !== 'preview' || !this.frameSize) return;
    const quad = frameQuadInDisplay(step.homography, this.frameSize);
    if (!quad) {
      this.setStatus('the camera frame maps to infinity on the display; showing it unwarped');
      return;
    }
    try {
      applyQuadWarp(this.view.preview, quad, this.frameSize);
    } catch (err) {
      this.rt.log.warn('preview warp failed', { err: String(err) });
    }
  }

  /** Outlines the surface corners, so a flipped or misplaced corner shows at once. */
  private outlineSurface(quad: CalibrationQuad | null): void {
    const outline = this.view.outline;
    outline.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    if (!quad) return;
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    polygon.setAttribute('points', quad.map((p) => `${p.x},${p.y}`).join(' '));
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', '#4ade80');
    polygon.setAttribute('stroke-width', '4');
    polygon.setAttribute('stroke-dasharray', '14 10');
    outline.appendChild(polygon);
    const labels = cornerLabels(this.target.options);
    quad.forEach((p, i) => {
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', String(p.x + 12));
      text.setAttribute('y', String(p.y - 12));
      text.setAttribute('fill', '#4ade80');
      text.setAttribute('font-family', 'ui-monospace, monospace');
      text.setAttribute('font-size', '16');
      text.textContent = labels[i] ?? '';
      outline.appendChild(text);
    });
  }

  private markersStatus(): string {
    const { offsetX, offsetY, scale } = this.transform;
    return `markers projected · ↔ ${offsetX} ↕ ${offsetY} · zoom ${Math.round(scale * 100)}% · pan and zoom from the control window`;
  }

  private setStatus(text: string | null): void {
    this.view.status.style.display = text === null ? 'none' : 'block';
    this.view.status.textContent = text;
  }
}

function createView(): View {
  setBodyFullscreen('#000');
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;background:#000;color:#fff;';

  const markers = document.createElement('div');
  markers.style.cssText = 'position:absolute;inset:0;background:#fff;display:none;';

  const preview = document.createElement('img');
  preview.style.cssText =
    'position:absolute;inset:0;width:100vw;height:100vh;object-fit:contain;display:none;opacity:0.85;';

  // Not warped: it outlines the surface in display pixels.
  const outline = document.createElementNS(SVG_NS, 'svg');
  outline.setAttribute('width', '100%');
  outline.setAttribute('height', '100%');
  outline.style.cssText = 'position:absolute;inset:0;width:100vw;height:100vh;pointer-events:none;';

  const status = document.createElement('div');
  status.style.cssText =
    'position:fixed;top:24px;left:24px;background:rgba(0,0,0,0.7);color:#fff;padding:10px 16px;font:13px ui-monospace,monospace;border-radius:6px;z-index:10;max-width:60vw;';

  root.append(markers, preview, outline, status);
  document.body.appendChild(root);
  return { root, markers, preview, outline, status };
}
