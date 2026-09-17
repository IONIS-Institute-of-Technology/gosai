/**
 * Gesture-activated menu.
 *
 * Port of the legacy `menu` app. Two index fingertips that pinch together
 * open the menu when spread apart; the same gesture in reverse closes it.
 * While open the user navigates with left/right arrow regions and starts or
 * stops a layer by holding their fingertip on its card. The cards are the
 * layers whose definition has a `menu` entry.
 *
 * Coordinate system
 * -----------------
 * The legacy code worked in window pixels and assumed 1920x1080. We work in
 * the same reference space, so all magic numbers (90, 250, 500, 70, ...) are
 * preserved verbatim. Counters and fills that the legacy code advanced once
 * per 60 fps frame advance by `frameSteps(deltaMs)` instead.
 *
 * The menu draws into a frame rotated 180 degrees about its anchor so the
 * UI reads correctly from the projector's perspective.
 */

import type { ExperienceRuntimeContext, LayerManager } from '@gosai/sdk';
import { loadSound, type Sound } from '../shared/audio.js';
import { fillRect, strokeRect } from '../shared/draw.js';
import { frameSteps } from '../shared/motion.js';
import {
  REF_HEIGHT,
  REF_WIDTH,
  type PoolFrame,
  type PoolLayer,
  type PoolLayerDefinition,
  type Tracking,
} from '../shared/types.js';

/** The parts of the layer manager the menu drives. */
export type MenuLayers = Pick<
  LayerManager<PoolFrame, PoolLayerDefinition>,
  'definitions' | 'isRunning' | 'stop' | 'toggle'
>;

interface MenuItem {
  readonly slug: string;
  readonly label: string;
  readonly autoStop: boolean;
}

const MENU_WIDTH = 300;
const MENU_HEIGHT = 600;
const MENU_Y = REF_HEIGHT / 2;

/** Auto-close menu after this many ms of no hands detected. */
const MENU_IDLE_CLOSE_MS = 10_000;
/** Stop an `autoStop` layer after this many ms of no hands detected. */
const APP_IDLE_STOP_MS = 60_000;

/** Index-finger tip landmark (MediaPipe Hands). */
const INDEX_TIP = 8;

/** Open/close animation, in percentage points per legacy frame. */
const ANIM_STEP = 5;
/** Legacy frames a pinch stays armed, waiting for the spread. */
const TRIGGER_FRAMES = 35;

interface State {
  isOpen: boolean;
  isOpening: boolean;
  isClosing: boolean;
  triggerArmed: boolean;
  /** Legacy frames since the trigger armed. */
  triggerCounter: number;
  yTrigger: number;
  menuX: number;
  /** 0..100 -- animation progress for open/close. */
  openPct: number;
  selectedIdx: number;
  arrowLeftFill: number;
  arrowRightFill: number;
  appFill: number;
  cooldownLeft: number;
  cooldownRight: number;
  cooldownApp: number;
  /** When the menu last saw a hand while open. */
  menuOpenedAt: number;
  /** When a hand was last seen, for stopping idle layers. */
  lastHandSeen: number;
}

interface MenuSounds {
  readonly open: Sound;
  readonly close: Sound;
  readonly click: Sound;
}

interface Menu {
  readonly state: State;
  readonly layers: MenuLayers;
  readonly items: readonly MenuItem[];
  readonly sounds: MenuSounds;
}

/** Loads a sound by app path. Defaults to `loadSound` through the runtime; tests replace it. */
export type SoundLoader = (path: string) => Promise<Sound>;

export function createMenuLayer(
  rt: ExperienceRuntimeContext,
  layers: MenuLayers,
  load: SoundLoader = (path) => loadSound(rt, path),
): PoolLayer {
  const items: MenuItem[] = layers
    .definitions()
    .flatMap((def) =>
      def.menu
        ? [{ slug: def.slug, label: def.menu.label, autoStop: def.menu.autoStop ?? false }]
        : [],
    );
  let menu: Menu | null = null;

  return {
    async preload(): Promise<void> {
      const [open, close, click] = await Promise.all([
        load('assets/audio/opening_menu.mp3'),
        load('assets/audio/closing_menu.mp3'),
        load('assets/audio/click.mp3'),
      ]);
      menu = { state: initialState(), layers, items, sounds: { open, close, click } };
    },

    render(frame: PoolFrame): void {
      if (!menu) return;
      step(menu, frame);
      draw(frame.ctx, menu);
    },
  };
}

function initialState(): State {
  const now = performance.now();
  return {
    isOpen: false,
    isOpening: false,
    isClosing: false,
    triggerArmed: false,
    triggerCounter: 0,
    yTrigger: 0,
    menuX: REF_WIDTH / 2,
    openPct: 0,
    selectedIdx: 0,
    arrowLeftFill: 0,
    arrowRightFill: 0,
    appFill: 0,
    cooldownLeft: 0,
    cooldownRight: 0,
    cooldownApp: 0,
    menuOpenedAt: now,
    lastHandSeen: now,
  };
}

// ---------------------------------------------------------------------------
// Step (state update each frame)
// ---------------------------------------------------------------------------

function step(menu: Menu, frame: PoolFrame): void {
  const { state, sounds } = menu;
  const steps = frameSteps(frame.deltaMs);
  const now = frame.timestamp;

  // The two index-finger tips, if available, in reference-space px.
  const tipA = readTip(frame.tracking, 0);
  const tipB = readTip(frame.tracking, 1);

  // Disarm a pinch that wasn't followed by a spread in time.
  if (state.triggerArmed) {
    state.triggerCounter += steps;
    if (state.triggerCounter > TRIGGER_FRAMES) {
      state.triggerArmed = false;
      state.triggerCounter = 0;
    }
  }

  // Gesture detection -- only when both hands are visible.
  if (tipA && tipB) {
    const gapX = Math.abs(tipA.x - tipB.x);
    const gapY = Math.abs(tipA.y - tipB.y);

    if (!state.isOpen) {
      // Close -> open path.
      if (gapX < 90 && gapY < 100) {
        state.yTrigger = tipA.y;
        state.triggerArmed = true;
        state.triggerCounter = 0;
        state.menuX = tipA.x;
      }
      if (
        state.triggerArmed &&
        gapX > 250 &&
        gapX < 500 &&
        Math.abs(state.yTrigger - tipA.y) < 70
      ) {
        startOpen(state, sounds, now);
      }
    } else {
      // Open -> close path.
      if (gapX > 250 && gapX < 500 && gapY < 100 && Math.abs(state.menuX - tipA.x) < 300) {
        state.yTrigger = tipA.y;
        state.triggerArmed = true;
        state.triggerCounter = 0;
      }
      if (state.triggerArmed && gapX < 90 && Math.abs(state.yTrigger - tipA.y) < 70) {
        startClose(state, sounds);
      }
    }
  }

  // Animation progression.
  if (state.isOpening) {
    state.openPct = Math.min(100, state.openPct + ANIM_STEP * steps);
    if (state.openPct === 100) state.isOpening = false;
  }
  if (state.isClosing) {
    state.openPct = Math.max(0, state.openPct - ANIM_STEP * steps);
    if (state.openPct === 0) state.isClosing = false;
  }

  // Cool-down decay -- once started, a cooldown counts up until it loops past
  // 50 (legacy semantics: cooldown=1 means "armed but in cooldown").
  state.cooldownLeft = tickCooldown(state.cooldownLeft, steps);
  state.cooldownRight = tickCooldown(state.cooldownRight, steps);
  state.cooldownApp = tickCooldown(state.cooldownApp, steps);

  // Button hover progress (only when fully open and a hand is visible).
  if (state.isOpen && state.openPct === 100 && tipA) {
    updateButtonFills(menu, tipA, steps);
  } else {
    state.arrowLeftFill = 0;
    state.arrowRightFill = 0;
    state.appFill = 0;
  }

  // Auto-close menu when hands disappear for a while.
  if (state.isOpen) {
    if (tipA) state.menuOpenedAt = now;
    if (now - state.menuOpenedAt > MENU_IDLE_CLOSE_MS) startClose(state, sounds);
  }

  // Stop idle educational layers when no hands were seen for a long while.
  // Games and visualisations keep running (matches legacy behaviour).
  if (tipA) {
    state.lastHandSeen = now;
  } else if (now - state.lastHandSeen > APP_IDLE_STOP_MS) {
    for (const item of menu.items) {
      if (item.autoStop && menu.layers.isRunning(item.slug)) void menu.layers.stop(item.slug);
    }
    state.lastHandSeen = now;
  }
}

function startOpen(state: State, sounds: MenuSounds, now: number): void {
  state.isOpening = true;
  state.isClosing = false;
  state.isOpen = true;
  state.triggerArmed = false;
  state.triggerCounter = 0;
  state.menuOpenedAt = now;
  // Clamp menu position so the full panel stays on-screen.
  const margin = MENU_WIDTH / 2 + 50;
  state.menuX = Math.min(REF_WIDTH - margin, Math.max(margin, state.menuX));
  sounds.open.play();
}

function startClose(state: State, sounds: MenuSounds): void {
  state.isOpening = false;
  state.isClosing = true;
  state.isOpen = false;
  state.triggerArmed = false;
  state.triggerCounter = 0;
  sounds.close.play();
}

function tickCooldown(value: number, steps: number): number {
  if (value < 1) return 0;
  const next = value + steps;
  return next > 50 ? 0 : next;
}

function updateButtonFills(menu: Menu, tip: { x: number; y: number }, steps: number): void {
  const { state, sounds, items } = menu;
  // Translate-rotate(PI) inverts both axes; the legacy code does its hit
  // tests in *un-rotated* finger coords against ranges expressed in the
  // rotated frame. The arrow buttons sit menu_height * 0.375 *above* the
  // menu center in the rotated frame which, after rotation, is below it
  // in screen space. We reproduce the exact legacy hit boxes.
  const cx = state.menuX;
  const cy = MENU_Y;

  // App card: a centred rectangle MENU_WIDTH*0.7 by MENU_HEIGHT*0.4 placed
  // at y in [cy - MENU_HEIGHT*0.25, cy + MENU_HEIGHT*0.15] (legacy bounds).
  const inAppCard =
    tip.x > cx - MENU_WIDTH * 0.35 &&
    tip.x < cx + MENU_WIDTH * 0.35 &&
    tip.y > cy - MENU_HEIGHT * 0.25 &&
    tip.y < cy + MENU_HEIGHT * 0.15 &&
    state.cooldownApp === 0;

  if (inAppCard) {
    state.appFill += steps * 4;
    if (state.appFill > MENU_WIDTH * 0.7) {
      state.appFill = 0;
      state.cooldownApp = 1;
      sounds.click.play();
      const item = items[state.selectedIdx];
      if (item) void menu.layers.toggle(item.slug);
      // Legacy behaviour: close the menu so the launched layer is visible.
      startClose(state, sounds);
    }
  } else {
    state.appFill = 0;
  }

  // Arrow buttons row, at cy - MENU_HEIGHT*0.425 .. cy - MENU_HEIGHT*0.325.
  const inArrowRowY = tip.y < cy - MENU_HEIGHT * 0.325 && tip.y > cy - MENU_HEIGHT * 0.425;

  const inLeftArrow =
    tip.x > cx - MENU_WIDTH * 0.35 && tip.x < cx && inArrowRowY && state.cooldownLeft === 0;
  const inRightArrow =
    tip.x > cx && tip.x < cx + MENU_WIDTH * 0.35 && inArrowRowY && state.cooldownRight === 0;

  // The rotation swaps sides: the left screen region fills the right button.
  state.arrowRightFill = inLeftArrow ? state.arrowRightFill + steps * 2 : 0;
  state.arrowLeftFill = inRightArrow ? state.arrowLeftFill + steps * 2 : 0;

  if (state.arrowLeftFill > MENU_WIDTH * 0.35) {
    state.arrowLeftFill = 0;
    state.selectedIdx = wrapIdx(state.selectedIdx - 1, items.length);
    state.cooldownRight = 1;
    sounds.click.play();
  }
  if (state.arrowRightFill > MENU_WIDTH * 0.35) {
    state.arrowRightFill = 0;
    state.selectedIdx = wrapIdx(state.selectedIdx + 1, items.length);
    state.cooldownLeft = 1;
    sounds.click.play();
  }
}

function wrapIdx(idx: number, len: number): number {
  if (len === 0) return 0;
  return ((idx % len) + len) % len;
}

function readTip(tracking: Tracking, handIdx: number): { x: number; y: number } | null {
  const tip = tracking.hands[handIdx]?.[INDEX_TIP];
  const [x, y] = tip ?? [];
  if (x === undefined || y === undefined) return null;
  return { x: x * REF_WIDTH, y: y * REF_HEIGHT };
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

function draw(ctx: CanvasRenderingContext2D, menu: Menu): void {
  const { state } = menu;
  // Nothing to draw while the menu is closed.
  if (state.openPct === 0 && !state.isOpening) return;

  const actualW = (state.openPct * MENU_WIDTH) / 100;
  const actualH = (state.openPct * MENU_HEIGHT) / 100;

  ctx.save();
  ctx.translate(state.menuX, MENU_Y);
  ctx.rotate(Math.PI);

  strokeRect(ctx, -actualW / 2, -actualH / 2, actualW, actualH, 2, '#ffffff');

  if (state.isOpen && state.openPct === 100) {
    drawMenuContents(ctx, menu);
  }

  ctx.restore();
}

function drawMenuContents(ctx: CanvasRenderingContext2D, menu: Menu): void {
  // Header (rotated frame coords).
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 40px ui-monospace, monospace';
  ctx.fillText('- MENU -', 0, -(MENU_HEIGHT / 2) * 0.8);
  ctx.font = '28px ui-monospace, monospace';
  ctx.fillText('Keep your index on', 0, -(MENU_HEIGHT / 2) * 0.6 - 16);
  ctx.fillText('an app to launch it', 0, -(MENU_HEIGHT / 2) * 0.6 + 16);

  drawAppCard(ctx, menu);
  drawArrowButtons(ctx, menu.state);
}

function drawAppCard(ctx: CanvasRenderingContext2D, menu: Menu): void {
  const { state } = menu;
  const item = menu.items[state.selectedIdx];
  const w = MENU_WIDTH * 0.7;
  const h = MENU_HEIGHT * 0.4;
  const x = -MENU_WIDTH * 0.35;
  const y = -MENU_HEIGHT * 0.15;

  // Card outline (green when running, lavender otherwise).
  const running = item !== undefined && menu.layers.isRunning(item.slug);
  strokeRect(ctx, x, y, w, h, 5, running ? '#00ff7f' : '#d8bfd8');

  // Hover progress fill.
  if (state.appFill > 0) {
    fillRect(ctx, x, y, Math.min(state.appFill, w), h, 'rgba(125,125,125,0.85)');
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '38px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lines = (item?.label ?? '(no apps)').split('\n');
  const lineH = 44;
  const startY = y + h / 2 - ((lines.length - 1) * lineH) / 2 - 22;
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, startY + i * lineH);
  });
}

function drawArrowButtons(ctx: CanvasRenderingContext2D, state: State): void {
  ctx.save();
  ctx.translate(0, (MENU_HEIGHT / 2) * 0.75);

  // Two button outlines side-by-side.
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(-MENU_WIDTH * 0.35, -MENU_HEIGHT * 0.05, MENU_WIDTH * 0.35, MENU_HEIGHT * 0.1);
  ctx.strokeRect(0, -MENU_HEIGHT * 0.05, MENU_WIDTH * 0.35, MENU_HEIGHT * 0.1);

  // Triangle indicators.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(-MENU_WIDTH * 0.15, -MENU_HEIGHT * 0.03);
  ctx.lineTo(-MENU_WIDTH * 0.15, MENU_HEIGHT * 0.03);
  ctx.lineTo(-MENU_WIDTH * 0.225, 0);
  ctx.closePath();
  ctx.moveTo(MENU_WIDTH * 0.15, -MENU_HEIGHT * 0.03);
  ctx.lineTo(MENU_WIDTH * 0.15, MENU_HEIGHT * 0.03);
  ctx.lineTo(MENU_WIDTH * 0.225, 0);
  ctx.closePath();
  ctx.fill();

  // Fill progress (grey rectangles growing from each button's outer edge).
  const fillW = MENU_WIDTH * 0.35;
  if (state.arrowLeftFill > 0) {
    fillRect(
      ctx,
      -fillW,
      -MENU_HEIGHT * 0.05,
      Math.min(state.arrowLeftFill, fillW),
      MENU_HEIGHT * 0.1,
      'rgba(125,125,125,0.85)',
    );
  }
  if (state.arrowRightFill > 0) {
    fillRect(
      ctx,
      0,
      -MENU_HEIGHT * 0.05,
      Math.min(state.arrowRightFill, fillW),
      MENU_HEIGHT * 0.1,
      'rgba(125,125,125,0.85)',
    );
  }

  ctx.restore();
}
