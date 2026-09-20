/**
 * What each layer tells the user about itself.
 *
 * Every module is driven by gestures with no labels on them, so a layer that
 * explains nothing is a layer nobody can play. On start, the layer's card
 * comes up in the middle of the mirror with its name and what to do; after a
 * few seconds it fades and leaves a single hint line along the bottom edge.
 * Layers whose assets are broken keep their card up instead, saying so.
 *
 * The menu layer owns the overlay: it is persistent and renders above
 * everything, so the card can't end up under a scene, and it knows to stay out
 * of the way while the launcher is open.
 */

import type { AssetRegistry } from './assets.js';
import { describeProblems } from './assets.js';
import { drawText } from './draw.js';
import type { LayerDef, Layers } from './layers.js';
import { REF_HEIGHT, REF_WIDTH } from './types.js';
import { roundRect } from './ui.js';

export interface LayerGuide {
  /** What the layer is and how to drive it. One or two short lines. */
  readonly lines: readonly string[];
  /** The reminder left along the bottom edge once the card is gone. */
  readonly hint: string;
}

/** How long a card stays up, fade included. */
const CARD_MS = 7000;
const FADE_MS = 800;

const CARD_CENTER_Y = REF_HEIGHT / 2;
const CARD_WIDTH = 920;
const CARD_PADDING = 48;
const TITLE_PX = 58;
const LINE_PX = 34;
const LINE_HEIGHT = 50;
const HINT_PX = 32;
const HINT_Y = REF_HEIGHT - 58;
const WARNING_COLOR = '#ffb24d';

/**
 * The layer whose hint belongs on screen: the top-most running scene. The
 * overlays (hands, body, face) are excluded because they run alongside
 * everything and their hint would hide the scene's.
 */
export function foregroundLayer(layers: Layers): LayerDef | null {
  let best: LayerDef | null = null;
  for (const slug of layers.running()) {
    const def = layers.definition(slug);
    if (!def || def.overlay || !def.guide) continue;
    if (!best || (def.zIndex ?? 0) >= (best.zIndex ?? 0)) best = def;
  }
  return best;
}

/**
 * The layer that earns a card out of the ones that just started. A scene wins
 * over an overlay, so starting Dance (which also starts Body) introduces the
 * dance rather than the skeleton; between equals, the top-most one wins.
 */
export function newcomerLayer(layers: Layers, previous: ReadonlySet<string>): LayerDef | null {
  let best: LayerDef | null = null;
  for (const slug of layers.running()) {
    if (previous.has(slug)) continue;
    const def = layers.definition(slug);
    if (!def?.guide) continue;
    if (!best) {
      best = def;
      continue;
    }
    if (best.overlay && !def.overlay) best = def;
    else if (best.overlay === def.overlay && (def.zIndex ?? 0) >= (best.zIndex ?? 0)) best = def;
  }
  return best;
}

export class GuideOverlay {
  private running: ReadonlySet<string> = new Set();
  /** The first frame only records what is already up, so startup shows no card. */
  private primed = false;
  private card: { def: LayerDef; shownAt: number } | null = null;

  constructor(
    private readonly layers: Layers,
    private readonly assets: AssetRegistry,
    /** Shown while nothing but the overlays run. */
    private readonly idleHint: string,
  ) {}

  reset(): void {
    this.running = new Set();
    this.primed = false;
    this.card = null;
  }

  /** Call once a frame, before {@link render}, whether or not the menu is open. */
  update(timestamp: number): void {
    const running = new Set(this.layers.running());
    if (!this.primed) {
      this.primed = true;
      this.running = running;
      return;
    }
    const newcomer = newcomerLayer(this.layers, this.running);
    this.running = running;
    if (newcomer) this.card = { def: newcomer, shownAt: timestamp };
    else if (this.card && !running.has(this.card.def.slug)) this.card = null;
  }

  render(ctx: CanvasRenderingContext2D, timestamp: number): void {
    const card = this.card;
    if (card) {
      const problems = this.assets.problems(card.def.slug);
      const age = timestamp - card.shownAt;
      // A broken layer keeps saying so: its card never times out.
      if (problems.length > 0) {
        drawCard(ctx, card.def, describeProblems(problems), 1, WARNING_COLOR);
      } else if (age < CARD_MS) {
        const alpha = Math.min(1, (CARD_MS - age) / FADE_MS);
        drawCard(ctx, card.def, card.def.guide?.lines ?? [], alpha, null);
      } else {
        this.card = null;
      }
    }
    drawHint(ctx, this.hintText());
  }

  private hintText(): string {
    const def = foregroundLayer(this.layers);
    if (!def) return this.idleHint;
    const problems = this.assets.problems(def.slug);
    if (problems.length > 0) return describeProblems(problems)[1] ?? this.idleHint;
    return def.guide?.hint ?? this.idleHint;
  }
}

/** Splits `text` into lines that fit `maxWidth` at the context's current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCard(
  ctx: CanvasRenderingContext2D,
  def: LayerDef,
  lines: readonly string[],
  alpha: number,
  accent: string | null,
): void {
  const inner = CARD_WIDTH - CARD_PADDING * 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${LINE_PX}px ui-sans-serif, system-ui, sans-serif`;
  const wrapped = lines.flatMap((line) => wrap(ctx, line, inner));
  const height = CARD_PADDING * 2 + TITLE_PX + 24 + wrapped.length * LINE_HEIGHT;
  const x = (REF_WIDTH - CARD_WIDTH) / 2;
  const y = CARD_CENTER_Y - height / 2;

  roundRect(ctx, x, y, CARD_WIDTH, height, 32);
  ctx.fillStyle = 'rgba(8,8,10,0.92)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = accent ?? 'rgba(255,255,255,0.28)';
  ctx.stroke();

  let textY = y + CARD_PADDING;
  drawText(ctx, def.label, REF_WIDTH / 2, textY, TITLE_PX, accent ?? '#ffffff', 'center', 'top');
  textY += TITLE_PX + 24;
  for (const line of wrapped) {
    drawText(
      ctx,
      line,
      REF_WIDTH / 2,
      textY,
      LINE_PX,
      accent ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.78)',
      'center',
      'top',
    );
    textY += LINE_HEIGHT;
  }
  ctx.restore();
}

function drawHint(ctx: CanvasRenderingContext2D, text: string): void {
  if (!text) return;
  ctx.save();
  ctx.font = `${HINT_PX}px ui-sans-serif, system-ui, sans-serif`;
  // A pill behind the text, so the hint stays readable over any scene.
  const width = ctx.measureText(text).width + 56;
  roundRect(ctx, (REF_WIDTH - width) / 2, HINT_Y - 29, width, 58, 29);
  ctx.fillStyle = 'rgba(8,8,10,0.88)';
  ctx.fill();
  ctx.restore();
  drawText(ctx, text, REF_WIDTH / 2, HINT_Y, HINT_PX, 'rgba(255,255,255,0.88)', 'center', 'middle');
}
