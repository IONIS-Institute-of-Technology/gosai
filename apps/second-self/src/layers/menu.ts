/**
 * Gesture-driven launcher menu.
 *
 * An index fingertip is the cursor. Dwelling on the central button opens the
 * launcher; dwelling on a row toggles a layer, fires or toggles one of its
 * options, or runs one of the actions listed after the layers. Running layers
 * are highlighted, and the options of a running layer show beneath it.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawText, fillCircle, strokeCircle } from '../shared/draw.js';
import type { MenuOption } from '../shared/layers.js';
import { REF_WIDTH, type Layer } from '../shared/types.js';
import {
  CursorPicker,
  dist,
  drawHoverButton,
  drawProgressRing,
  inRect,
  stepDwell,
  type Rect,
} from '../shared/ui.js';

const BUTTON_X = REF_WIDTH / 2;
const BUTTON_Y = 130;
const BUTTON_R = 80;
/** Dwell timing is wall-clock, so it doesn't depend on the display refresh rate. */
const OPEN_DWELL_MS = 900;
const SELECT_DWELL_MS = 1100;
const COOLDOWN_MS = 900;
/** An in-progress dwell grows its hitbox so boundary jitter doesn't cancel it. */
const HYSTERESIS_PX = 18;

const ROW_W = 560;
const ROW_H = 84;
const ROW_GAP = 14;
const OPTION_INDENT = 60;
const LIST_TOP = BUTTON_Y + BUTTON_R + 40;

const ORANGE = '#ff8100';
const WHITE = '#ffffff';

/** A menu row that runs something other than a layer, such as the calibration. */
export interface MenuAction {
  readonly id: string;
  readonly label: string;
  run(): void;
}

interface Row {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly indent: boolean;
  /** Close the launcher after firing: app rows do, option rows keep it open. */
  readonly closesMenu: boolean;
  fire(): void;
}

export function createMenuLayer(deps: LayerDeps, actions: readonly MenuAction[] = []): Layer {
  const cursorPicker = new CursorPicker();
  /** Per-row dwell progress in milliseconds. */
  const dwell = new Map<string, number>();
  const cooldownUntil = new Map<string, number>();
  let buttonMs = 0;
  let buttonCooldownUntil = 0;
  let open = false;

  function reset(): void {
    dwell.clear();
    cooldownUntil.clear();
    buttonMs = 0;
    buttonCooldownUntil = 0;
    open = false;
    cursorPicker.reset();
  }

  function buildRows(): Row[] {
    const { layers } = deps;
    const rows: Row[] = [];
    for (const def of layers.definitions()) {
      if (!def.inMenu) continue;
      const running = layers.isRunning(def.slug);
      rows.push({
        id: `app:${def.slug}`,
        label: def.label,
        active: running,
        indent: false,
        closesMenu: true,
        fire: () => void layers.toggle(def.slug),
      });
      if (!running) continue;
      for (const option of def.options ?? []) {
        rows.push(optionRow(deps, def.slug, option));
      }
    }
    for (const action of actions) {
      rows.push({
        id: `action:${action.id}`,
        label: action.label,
        active: false,
        indent: false,
        closesMenu: true,
        fire: () => action.run(),
      });
    }
    return rows;
  }

  return {
    start: reset,

    render({ ctx, timestamp, deltaMs }): void {
      const cursor = cursorPicker.pick(deps.feed.mirror.data, timestamp);

      const buttonRadius = BUTTON_R + (buttonMs > 0 ? HYSTERESIS_PX : 0);
      const overButton =
        cursor !== null && dist(cursor.x, cursor.y, BUTTON_X, BUTTON_Y) < buttonRadius;
      buttonMs = stepDwell(buttonMs, overButton && timestamp >= buttonCooldownUntil, deltaMs);
      if (buttonMs >= OPEN_DWELL_MS) {
        open = !open;
        buttonMs = 0;
        buttonCooldownUntil = timestamp + COOLDOWN_MS;
      }
      drawButton(ctx, open, buttonMs / OPEN_DWELL_MS);

      if (!open) {
        const { layers } = deps;
        if (layers.running().every((slug) => layers.definition(slug)?.overlay)) drawHint(ctx);
        return;
      }

      let y = LIST_TOP;
      const seen = new Set<string>();
      for (const row of buildRows()) {
        seen.add(row.id);
        const indent = row.indent ? OPTION_INDENT : 0;
        const rect: Rect = { x: BUTTON_X - ROW_W / 2 + indent, y, w: ROW_W - indent, h: ROW_H };
        const ms = dwell.get(row.id) ?? 0;
        const hovered = inRect(cursor, rect, ms > 0 ? HYSTERESIS_PX : 0);
        const onCooldown = (cooldownUntil.get(row.id) ?? 0) > timestamp;
        let next = stepDwell(ms, hovered && !onCooldown, deltaMs);
        const progress = next / SELECT_DWELL_MS;
        if (next >= SELECT_DWELL_MS) {
          row.fire();
          next = 0;
          cooldownUntil.set(row.id, timestamp + COOLDOWN_MS);
          // Selecting an app closes the launcher so its rows never cover the
          // experience that just started.
          if (row.closesMenu) {
            open = false;
            dwell.clear();
            return;
          }
        }
        dwell.set(row.id, next);

        drawHoverButton(ctx, rect, row.label, progress, {
          color: row.active ? ORANGE : WHITE,
          progressColor: 'rgba(255,129,0,0.35)',
          textColor: row.active ? ORANGE : WHITE,
          align: 'left',
        });
        if (row.active && !row.indent) {
          fillCircle(ctx, rect.x + rect.w - 36, y + ROW_H / 2, 22, ORANGE);
        }
        y += ROW_H + ROW_GAP;
      }

      // Forget dwell counters for rows that disappeared.
      for (const id of dwell.keys()) {
        if (!seen.has(id)) dwell.delete(id);
      }
    },

    stop: reset,
  };
}

function optionRow(deps: LayerDeps, slug: string, option: MenuOption): Row {
  const toggle = option.type === 'toggle';
  return {
    id: `opt:${slug}:${option.name}`,
    label: toggle ? option.name : `▶ ${option.name}`,
    active: toggle && deps.options.get(slug, option.name),
    indent: true,
    closesMenu: false,
    fire: () => {
      if (toggle) deps.options.toggle(slug, option.name);
      else deps.options.trigger(slug, option.name);
    },
  };
}

function drawButton(ctx: CanvasRenderingContext2D, open: boolean, progress: number): void {
  fillCircle(
    ctx,
    BUTTON_X,
    BUTTON_Y,
    BUTTON_R * 2,
    open ? 'rgba(255,129,0,0.85)' : 'rgba(40,40,40,0.7)',
  );
  strokeCircle(ctx, BUTTON_X, BUTTON_Y, BUTTON_R * 2, 6, WHITE);
  // Hamburger glyph.
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 8;
  ctx.beginPath();
  for (let i = -1; i <= 1; i++) {
    ctx.moveTo(BUTTON_X - 28, BUTTON_Y + i * 18);
    ctx.lineTo(BUTTON_X + 28, BUTTON_Y + i * 18);
  }
  ctx.stroke();
  if (progress > 0.02) {
    drawProgressRing(ctx, BUTTON_X, BUTTON_Y, BUTTON_R + 12, progress, {
      color: WHITE,
      lineWidth: 5,
    });
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
