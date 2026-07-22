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
/**
 * Dwell timing is wall-clock so it is independent of the display refresh rate
 * (the legacy frame counters selected ~2x faster on a 60 Hz kiosk than at the
 * ~30 fps the pose feed runs at).
 */
const OPEN_DWELL_MS = 900;
const SELECT_DWELL_MS = 1100;
const COOLDOWN_MS = 900;
/**
 * Hand tracking flickers: single dropped frames must not reset a dwell. The
 * cursor survives brief dropouts (grace), dwell progress decays instead of
 * hard-resetting on hover exit, and an in-progress dwell enlarges its hitbox
 * (hysteresis) so boundary jitter doesn't cancel it.
 */
const CURSOR_GRACE_MS = 300;
const DECAY_FACTOR = 2;
const HYSTERESIS_PX = 18;
/** Switch cursor hands only when the other hand is clearly higher for a while. */
const HAND_SWITCH_MARGIN_PX = 80;
const HAND_SWITCH_MS = 400;

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
  /** Per-row dwell progress in milliseconds. */
  const dwell = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  let buttonMs = 0;
  let buttonCooldownUntil = 0;
  let open = false;

  // Sticky-hand cursor state.
  let activeHand: 'right' | 'left' | null = null;
  let otherHigherSince = 0;
  let lastCursor: { x: number; y: number } | null = null;
  let lastCursorTs = 0;

  function resetCursorState(): void {
    activeHand = null;
    otherHigherSince = 0;
    lastCursor = null;
    lastCursorTs = 0;
  }

  /**
   * Index-fingertip cursor with sticky hand selection and a dropout grace
   * period. The active hand keeps the cursor while it is tracked; the other
   * hand takes over only when it is clearly higher for a sustained interval
   * (or the active hand is lost). On full loss the last position survives
   * {@link CURSOR_GRACE_MS} so momentary tracking flicker doesn't reset dwells.
   */
  function pickCursor(now: number): { x: number; y: number } | null {
    const m = deps.feed.mirror.data;
    const hands = {
      right: m.right_hand_pose[8],
      left: m.left_hand_pose[8],
    } as const;
    const rightValid = isValid(hands.right);
    const leftValid = isValid(hands.left);

    if (activeHand && !(activeHand === 'right' ? rightValid : leftValid)) {
      activeHand = null;
      otherHigherSince = 0;
    }
    if (!activeHand) {
      if (rightValid && leftValid) {
        activeHand = hands.right![1]! <= hands.left![1]! ? 'right' : 'left';
      } else if (rightValid) {
        activeHand = 'right';
      } else if (leftValid) {
        activeHand = 'left';
      }
      otherHigherSince = 0;
    } else if (rightValid && leftValid) {
      const active = activeHand === 'right' ? hands.right! : hands.left!;
      const other = activeHand === 'right' ? hands.left! : hands.right!;
      if (other[1]! < active[1]! - HAND_SWITCH_MARGIN_PX) {
        if (otherHigherSince === 0) otherHigherSince = now;
        if (now - otherHigherSince >= HAND_SWITCH_MS) {
          activeHand = activeHand === 'right' ? 'left' : 'right';
          otherHigherSince = 0;
        }
      } else {
        otherHigherSince = 0;
      }
    } else {
      otherHigherSince = 0;
    }

    if (activeHand) {
      const lm = activeHand === 'right' ? hands.right! : hands.left!;
      lastCursor = { x: lm[0]!, y: lm[1]! };
      lastCursorTs = now;
      return lastCursor;
    }
    if (lastCursor && now - lastCursorTs < CURSOR_GRACE_MS) return lastCursor;
    lastCursor = null;
    return null;
  }

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
      buttonMs = 0;
      buttonCooldownUntil = 0;
      open = false;
      resetCursorState();
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp, deltaMs } = frame;
      const cursor = pickCursor(timestamp);

      // Central toggle button dwell (hysteresis widens the hit radius while a
      // dwell is in progress).
      const buttonRadius = BUTTON_R + (buttonMs > 0 ? HYSTERESIS_PX : 0);
      const overButton =
        cursor !== null && dist(cursor.x, cursor.y, BUTTON_X, BUTTON_Y) < buttonRadius;
      if (overButton && timestamp >= buttonCooldownUntil) {
        buttonMs += deltaMs;
        if (buttonMs >= OPEN_DWELL_MS) {
          open = !open;
          buttonMs = 0;
          buttonCooldownUntil = timestamp + COOLDOWN_MS;
        }
      } else {
        buttonMs = Math.max(0, buttonMs - deltaMs * DECAY_FACTOR);
      }

      drawButton(ctx, open, Math.min(1, buttonMs / OPEN_DWELL_MS));

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
        const ms = dwell.get(row.id) ?? 0;
        const pad = ms > 0 ? HYSTERESIS_PX : 0;
        const hovered =
          cursor !== null &&
          cursor.x > x - pad &&
          cursor.x < x + w + pad &&
          cursor.y > y - pad &&
          cursor.y < y + ROW_H + pad;

        const onCooldown = (cooldownUntil.get(row.id) ?? 0) > timestamp;
        let next = hovered && !onCooldown ? ms + deltaMs : Math.max(0, ms - deltaMs * DECAY_FACTOR);
        const progress = Math.min(1, next / SELECT_DWELL_MS);
        if (next >= SELECT_DWELL_MS) {
          row.fire();
          next = 0;
          cooldownUntil.set(row.id, timestamp + COOLDOWN_MS);
        }
        dwell.set(row.id, next);

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
      resetCursorState();
    },
  };
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
