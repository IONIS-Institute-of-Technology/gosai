/**
 * Canvas helpers. Apps usually draw in a fixed reference space (for example
 * 1920x1080) and let `fit()` map it onto whatever window the experience runs in.
 */

/** How a reference space maps onto the canvas. */
export type FitMode = 'contain' | 'cover' | 'stretch';

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Scale and offset from reference coordinates to canvas backing-store pixels. */
export interface FitTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Computes how a `reference` space fits in a `target` size:
 *
 * - `contain` keeps the aspect ratio and letterboxes.
 * - `cover` keeps the aspect ratio, fills the target and crops the overflow.
 * - `stretch` fills the target exactly and distorts the aspect ratio.
 */
export function computeFit(target: Size, reference: Size, mode: FitMode = 'contain'): FitTransform {
  let scaleX = target.width / reference.width;
  let scaleY = target.height / reference.height;
  if (mode !== 'stretch') {
    const scale = mode === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = scale;
    scaleY = scale;
  }
  return {
    scaleX,
    scaleY,
    offsetX: (target.width - reference.width * scaleX) / 2,
    offsetY: (target.height - reference.height * scaleY) / 2,
  };
}

/** The parts of a canvas `fitCanvas` needs. */
export type FittableCanvas = Pick<HTMLCanvasElement, 'width' | 'height' | 'getBoundingClientRect'>;

/**
 * Sizes the backing store to the canvas's CSS box times the device pixel
 * ratio. Assigning `width` or `height` clears the canvas and resets its
 * context state, so this only assigns them when the size changed. Returns
 * whether it did.
 */
export function fitCanvas(canvas: FittableCanvas, dpr = defaultDpr()): boolean {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === width && canvas.height === height) return false;
  canvas.width = width;
  canvas.height = height;
  return true;
}

export interface FullscreenCanvasOptions {
  /** Element the canvas container goes into. Defaults to `document.body`. */
  readonly parent?: HTMLElement;
  /** Reference space `fit()` maps drawing coordinates from. Defaults to canvas pixels. */
  readonly reference?: Size;
  /** Defaults to `contain`. */
  readonly mode?: FitMode;
  /** CSS background behind the canvas and in letterbox bars. Defaults to black. */
  readonly background?: string;
  /** Overrides `window.devicePixelRatio`. */
  readonly devicePixelRatio?: number;
  /** Removes the canvas when this signal aborts, for example `rt.signal`. */
  readonly signal?: AbortSignal;
}

export interface FullscreenCanvas {
  readonly container: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /**
   * Resizes the backing store when the canvas size changed, then sets the
   * context transform so drawing uses reference coordinates. Call it at the
   * start of each frame. Returns the transform it applied.
   */
  fit(): FitTransform;
  /** Removes the container from the document. */
  remove(): void;
}

/** Creates a fixed, full-window 2D canvas. */
export function createFullscreenCanvas(options: FullscreenCanvasOptions = {}): FullscreenCanvas {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;inset:0;overflow:hidden;';
  container.style.background = options.background ?? '#000';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  container.appendChild(canvas);
  (options.parent ?? document.body).appendChild(container);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    container.remove();
    throw new Error('2D canvas context is unavailable');
  }

  const mode = options.mode ?? 'contain';
  const remove = (): void => container.remove();
  options.signal?.addEventListener('abort', remove, { once: true });

  return {
    container,
    canvas,
    ctx,
    fit(): FitTransform {
      fitCanvas(canvas, options.devicePixelRatio ?? defaultDpr());
      const transform = computeFit(canvas, options.reference ?? canvas, mode);
      ctx.setTransform(
        transform.scaleX,
        0,
        0,
        transform.scaleY,
        transform.offsetX,
        transform.offsetY,
      );
      return transform;
    },
    remove,
  };
}

export interface CanvasOptions {
  readonly id?: string;
  readonly className?: string;
  readonly background?: string;
  readonly devicePixelRatio?: number;
}

/** Appends a canvas that fills `parent` and sizes its backing store once. */
export function createCanvas(parent: HTMLElement, options: CanvasOptions = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  if (options.id) canvas.id = options.id;
  if (options.className) canvas.className = options.className;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  if (options.background) canvas.style.background = options.background;
  parent.appendChild(canvas);
  fitCanvas(canvas, options.devicePixelRatio);
  return canvas;
}

/** Appends a fixed, full-window black container to the document body. */
export function fullscreenContainer(): HTMLElement {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.inset = '0';
  el.style.display = 'block';
  el.style.background = 'black';
  el.style.overflow = 'hidden';
  document.body.appendChild(el);
  return el;
}

function defaultDpr(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}
