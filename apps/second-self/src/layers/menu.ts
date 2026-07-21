/**
 * Gesture-driven launcher menu.
 *
 * Ports the legacy `menu` app (components/menu2.js) to Canvas2D + the in-process
 * {@link MenuController}. An index fingertip (mirror landmark 8 of either hand;
 * the raised one wins) is the cursor. Dwelling on the central button opens the
 * launcher; dwelling on a row toggles a layer on/off or triggers/toggles one of
 * its options.
 *
 * Running layers are highlighted; layers that expose options reveal their
 * option rows beneath them while running.
 */

import { drawText, fillCircle, strokeCircle } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import type { MenuController, MenuOption } from '../shared/menu-controller.js';
import { isValid } from '../shared/mirror.js';
import { REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';

const BUTTON_X = REF_WIDTH / 2;
const BUTTON_Y = 130;
const BUTTON_R = 80;
const OPEN_FRAMES = 36;
const SELECT_FRAMES = 45;
const COOLDOWN_MS = 900;

const ROW_W = 560;
const ROW_H = 84;
const ROW_GAP = 14;
const OPTION_INDENT = 60;
const LIST_TOP = BUTTON_Y + BUTTON_R + 40;

const ORANGE = '#ff8100';
const WHITE = '#ffffff';

interface Row {
  id: string;
  label: string;
  active: boolean;
  indent: boolean;
  fire(): void;
}

export function createMenuLayer(deps: LayerDeps): Layer {
  const controller = deps.controller;
  const dwell = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  let buttonCount = 0;
  let open = false;

  function buildRows(): Row[] {
    const rows: Row[] = [];
    for (const item of controller.items()) {
      const running = controller.isRunning(item.slug);
      rows.push({
        id: `app:${item.slug}`,
        label: item.label,
        active: running,
        indent: false,
        fire: () => controller.toggle(item.slug),
      });
      if (running && item.options && item.options.length > 0) {
        for (const opt of item.options) {
          rows.push(makeOptionRow(controller, item.slug, opt));
        }
      }
    }
    return rows;
  }

  return {
    start(): void {
      dwell.clear();
      cooldownUntil.clear();
      buttonCount = 0;
      open = false;
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp } = frame;
      // Either index fingertip drives the menu (legacy only tracked one hand,
      // whose side depended on the driver's handedness convention). When both
      // hands are up, the higher one wins: that's the pointing hand.
      const m = deps.feed.mirror.data;
      const cursor = pickCursor(m.right_hand_pose[8], m.left_hand_pose[8]);

      // Central toggle button dwell.
      if (cursor && dist(cursor.x, cursor.y, BUTTON_X, BUTTON_Y) < BUTTON_R) {
        buttonCount += 1;
        if (buttonCount >= OPEN_FRAMES) {
          open = !open;
          buttonCount = -OPEN_FRAMES; // brief debounce before re-trigger.
        }
      } else {
        buttonCount = Math.max(0, buttonCount);
        if (buttonCount > 0) buttonCount -= 2;
      }

      drawButton(ctx, open, Math.max(0, buttonCount) / OPEN_FRAMES);

      if (!open) {
        if (controller.runningSlugs().every(isPassive)) {
          drawHint(ctx);
        }
        return;
      }

      const rows = buildRows();
      let y = LIST_TOP;
      const seen = new Set<string>();
      for (const row of rows) {
        seen.add(row.id);
        const x = BUTTON_X - ROW_W / 2 + (row.indent ? OPTION_INDENT : 0);
        const w = ROW_W - (row.indent ? OPTION_INDENT : 0);
        const hovered =
          cursor !== null &&
          cursor.x > x &&
          cursor.x < x + w &&
          cursor.y > y &&
          cursor.y < y + ROW_H;

        let progress = 0;
        const onCooldown = (cooldownUntil.get(row.id) ?? 0) > timestamp;
        if (hovered && !onCooldown) {
          const c = (dwell.get(row.id) ?? 0) + 1;
          dwell.set(row.id, c);
          progress = Math.min(1, c / SELECT_FRAMES);
          if (c >= SELECT_FRAMES) {
            row.fire();
            dwell.set(row.id, 0);
            cooldownUntil.set(row.id, timestamp + COOLDOWN_MS);
          }
        } else {
          dwell.set(row.id, 0);
        }

        drawRow(ctx, x, y, w, row, progress);
        y += ROW_H + ROW_GAP;
      }

      // Forget dwell counters for rows that disappeared.
      for (const key of [...dwell.keys()]) {
        if (!seen.has(key)) dwell.delete(key);
      }
    },

    stop(): void {
      dwell.clear();
      cooldownUntil.clear();
    },
  };
}

function pickCursor(
  a: number[] | undefined,
  b: number[] | undefined,
): { x: number; y: number } | null {
  const va = isValid(a);
  const vb = isValid(b);
  if (va && vb) {
    return a![1]! <= b![1]! ? { x: a![0]!, y: a![1]! } : { x: b![0]!, y: b![1]! };
  }
  if (va) return { x: a![0]!, y: a![1]! };
  if (vb) return { x: b![0]!, y: b![1]! };
  return null;
}

function makeOptionRow(controller: MenuController, slug: string, opt: MenuOption): Row {
  const isToggle = opt.type === 'toggle';
  return {
    id: `opt:${slug}:${opt.name}`,
    label: isToggle ? opt.name : `▶ ${opt.name}`,
    active: isToggle ? controller.getOption(slug, opt.name) : false,
    indent: true,
    fire: () => {
      if (isToggle) controller.toggleOption(slug, opt.name);
      else controller.triggerOption(slug, opt.name);
    },
  };
}

function isPassive(slug: string): boolean {
  return slug === 'menu' || slug === 'hands' || slug === 'body' || slug === 'face';
}

function drawButton(ctx: CanvasRenderingContext2D, open: boolean, progress: number): void {
  if (open) {
    fillCircle(ctx, BUTTON_X, BUTTON_Y, BUTTON_R * 2, 'rgba(255,129,0,0.85)');
  } else {
    fillCircle(ctx, BUTTON_X, BUTTON_Y, BUTTON_R * 2, 'rgba(40,40,40,0.7)');
  }
  strokeCircle(ctx, BUTTON_X, BUTTON_Y, BUTTON_R * 2, 6, WHITE);
  // Hamburger glyph.
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 8;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(BUTTON_X - 28, BUTTON_Y + i * 18);
    ctx.lineTo(BUTTON_X + 28, BUTTON_Y + i * 18);
    ctx.stroke();
  }
  if (progress > 0.02) {
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(BUTTON_X, BUTTON_Y, BUTTON_R + 12, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
  }
}

function drawRow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  row: Row,
  progress: number,
): void {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeStyle = row.active ? ORANGE : WHITE;
  ctx.lineWidth = 3;
  roundRect(ctx, x, y, w, ROW_H, 16);
  ctx.fill();
  ctx.stroke();

  if (progress > 0) {
    ctx.fillStyle = 'rgba(255,129,0,0.35)';
    roundRect(ctx, x, y, w * progress, ROW_H, 16);
    ctx.fill();
  }

  drawText(
    ctx,
    row.label,
    x + 28,
    y + ROW_H / 2,
    40,
    row.active ? ORANGE : WHITE,
    'left',
    'middle',
  );
  if (row.active && !row.indent) {
    fillCircle(ctx, x + w - 36, y + ROW_H / 2, 22, ORANGE);
  }
}

function drawHint(ctx: CanvasRenderingContext2D): void {
  drawText(
    ctx,
    'Raise a hand and hold your index over the menu button',
    REF_WIDTH / 2,
    BUTTON_Y + BUTTON_R + 70,
    34,
    'rgba(255,255,255,0.6)',
    'center',
    'middle',
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}
