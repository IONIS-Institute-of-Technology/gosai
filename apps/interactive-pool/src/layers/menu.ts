/**
 * Gesture-activated menu.
 *
 * Faithful port of the legacy `menu` app. Two index fingertips that pinch
 * together open the menu when spread apart; the same gesture in reverse
 * closes it. While open the user navigates with left/right arrow regions and
 * activates an app by holding their fingertip on the app card.
 *
 * Coordinate system
 * -----------------
 * The legacy code worked in window pixels and assumed 1920x1080. We work in
 * the same reference space, so all magic numbers (90, 250, 500, 70, ...) are
 * preserved verbatim.
 *
 * The menu draws into a frame rotated 180 degrees about its anchor so the
 * UI reads correctly from the projector's perspective.
 */

import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';
import { fillRect, strokeRect } from '../shared/canvas-utils.js';
import type { PoolFeed } from '../shared/feed.js';
import { loadSound, type SoundHandle } from '../shared/audio.js';
import type { MenuController } from '../shared/controller.js';

const MENU_WIDTH = 300;
const MENU_HEIGHT = 600;
const MENU_Y = REF_HEIGHT / 2;

/** Auto-close menu after this many ms of no hands detected. */
const MENU_IDLE_CLOSE_MS = 10_000;
/** Auto-stop active app after this many ms of no hands detected (menu closed). */
const APP_IDLE_STOP_MS = 60_000;
/**
 * Layer slugs that should auto-stop after a period of no hand activity.
 * Matches the legacy `no_menu_tutorial_gif` list: educational layers only.
 * Games (`rabbits_game`) and visualisations (`univers`, `ambient_display`)
 * stay running until manually stopped.
 */
const AUTO_STOP_SLUGS = new Set(['affine', 'triangles']);

/** Index-finger tip landmark (MediaPipe Hands). */
const INDEX_TIP = 8;

/** Animation speed: percentage points per 60fps-equivalent frame. */
const ANIM_STEP = 5;

/** Hover-fill rates (legacy `speed_regulator * N` per frame at 60fps). */
const ARROW_FILL_BASE = 50;
const APP_FILL_BASE = 50;

interface State {
  isOpen: boolean;
  isOpening: boolean;
  isClosing: boolean;
  triggerArmed: boolean;
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
  /** ms since last frame in which any hand was detected. */
  lastHandSeen: number;
  /** ms when menu last opened (resets while hands are visible). */
  menuOpenedAt: number;
  /** ms since last hand seen while an app is active. */
  lastHandSeenWhileAppActive: number;
}

export function createMenuLayer(feed: PoolFeed, controller: MenuController): Layer {
  const state: State = {
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
    lastHandSeen: 0,
    menuOpenedAt: 0,
    lastHandSeenWhileAppActive: 0,
  };

  let soundOpen: SoundHandle | null = null;
  let soundClose: SoundHandle | null = null;
  let soundClick: SoundHandle | null = null;

  function ensureSounds(): void {
    if (soundOpen === null) soundOpen = loadSound('audio/opening_menu.mp3');
    if (soundClose === null) soundClose = loadSound('audio/closing_menu.mp3');
    if (soundClick === null) soundClick = loadSound('audio/click.mp3');
  }

  return {
    start(): void {
      ensureSounds();
      state.lastHandSeen = performance.now();
      state.lastHandSeenWhileAppActive = performance.now();
    },

    render(frame: FrameContext): void {
      ensureSounds();
      step(frame, state, controller, feed, {
        soundOpen,
        soundClose,
        soundClick,
      });
      draw(frame.ctx, state, controller);
    },

    stop(): void {
      soundOpen = null;
      soundClose = null;
      soundClick = null;
    },
  };
}

interface MenuSounds {
  soundOpen: SoundHandle | null;
  soundClose: SoundHandle | null;
  soundClick: SoundHandle | null;
}

// ---------------------------------------------------------------------------
// Step (state update each frame)
// ---------------------------------------------------------------------------

function step(
  frame: FrameContext,
  state: State,
  controller: MenuController,
  feed: PoolFeed,
  sounds: MenuSounds,
): void {
  // Normalise the frame's delta to the legacy 60fps base. At 60fps,
  // speedReg ~= 1.0, which matches the legacy speed_regulator at 60fps.
  const speedReg = Math.min(3, frame.deltaMs / (1000 / 60));

  // Locate the two index-finger tips, if available, in reference-space px.
  const tipA = readTip(feed, 0);
  const tipB = readTip(feed, 1);
  const haveA = tipA !== null;
  const haveB = tipB !== null;

  if (haveA) {
    state.lastHandSeen = frame.timestamp;
    state.lastHandSeenWhileAppActive = frame.timestamp;
  }

  // Decay trigger counter every frame regardless of state.
  if (state.triggerArmed) {
    state.triggerCounter += 1;
    if (state.triggerCounter > 35) {
      state.triggerArmed = false;
      state.triggerCounter = 0;
    }
  }

  // Gesture detection -- only when both hands are visible.
  if (haveA && haveB && tipA && tipB) {
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
        startOpen(state, sounds, frame.timestamp);
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
    state.openPct = Math.min(100, state.openPct + ANIM_STEP);
    if (state.openPct === 100) state.isOpening = false;
  }
  if (state.isClosing) {
    state.openPct = Math.max(0, state.openPct - ANIM_STEP);
    if (state.openPct === 0) state.isClosing = false;
  }

  // Cool-down decay -- once started, a cooldown counts up until it loops past
  // 50 (legacy semantics: cooldown=1 means "armed but in cooldown").
  state.cooldownLeft = tickCooldown(state.cooldownLeft, speedReg);
  state.cooldownRight = tickCooldown(state.cooldownRight, speedReg);
  state.cooldownApp = tickCooldown(state.cooldownApp, speedReg);

  // Button hover progress (only when fully open and a hand is visible).
  if (state.isOpen && state.openPct === 100 && haveA && tipA) {
    updateButtonFills(state, tipA, speedReg, controller, sounds);
  } else {
    state.arrowLeftFill = 0;
    state.arrowRightFill = 0;
    state.appFill = 0;
  }

  // Auto-close menu when hands disappear for a while.
  if (state.isOpen) {
    if (haveA) state.menuOpenedAt = frame.timestamp;
    if (frame.timestamp - state.menuOpenedAt > MENU_IDLE_CLOSE_MS) {
      startClose(state, sounds);
    }
  }

  // Auto-stop active educational app when no hands detected for a long
  // while. Games and visualisations are excluded (matches legacy behaviour).
  const active = controller.active();
  if (!haveA && active !== null && AUTO_STOP_SLUGS.has(active)) {
    if (frame.timestamp - state.lastHandSeenWhileAppActive > APP_IDLE_STOP_MS) {
      controller.setActive(null);
      state.lastHandSeenWhileAppActive = frame.timestamp;
    }
  } else if (haveA) {
    state.lastHandSeenWhileAppActive = frame.timestamp;
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
  if (state.menuX < MENU_WIDTH / 2 + 50) state.menuX = MENU_WIDTH / 2 + 50;
  if (state.menuX > REF_WIDTH - MENU_WIDTH / 2 - 50) {
    state.menuX = REF_WIDTH - MENU_WIDTH / 2 - 50;
  }
  sounds.soundOpen?.play();
}

function startClose(state: State, sounds: MenuSounds): void {
  state.isOpening = false;
  state.isClosing = true;
  state.isOpen = false;
  state.triggerArmed = false;
  state.triggerCounter = 0;
  sounds.soundClose?.play();
}

function tickCooldown(value: number, speedReg: number): number {
  if (value < 1) return 0;
  const next = value + speedReg;
  return next > 50 ? 0 : next;
}

function updateButtonFills(
  state: State,
  tip: { x: number; y: number },
  speedReg: number,
  controller: MenuController,
  sounds: MenuSounds,
): void {
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
    state.appFill += speedReg * (APP_FILL_BASE / 50) * 4;
    if (state.appFill > MENU_WIDTH * 0.7) {
      state.appFill = 0;
      state.cooldownApp = 1;
      sounds.soundClick?.play();
      toggleSelectedApp(controller, state.selectedIdx);
      // Legacy behaviour: closing the menu after toggling so the launched
      // layer becomes immediately visible.
      startClose(state, sounds);
    }
  } else {
    state.appFill = 0;
  }

  // Arrow buttons row, at cy - MENU_HEIGHT*0.375 .. cy - MENU_HEIGHT*0.275.
  const inArrowRowY = tip.y < cy - MENU_HEIGHT * 0.325 && tip.y > cy - MENU_HEIGHT * 0.425;

  const inLeftArrow =
    tip.x > cx - MENU_WIDTH * 0.35 && tip.x < cx && inArrowRowY && state.cooldownLeft === 0;
  const inRightArrow =
    tip.x > cx && tip.x < cx + MENU_WIDTH * 0.35 && inArrowRowY && state.cooldownRight === 0;

  if (inLeftArrow) {
    state.arrowRightFill += speedReg * (ARROW_FILL_BASE / 50) * 2;
  } else {
    state.arrowRightFill = 0;
  }
  if (inRightArrow) {
    state.arrowLeftFill += speedReg * (ARROW_FILL_BASE / 50) * 2;
  } else {
    state.arrowLeftFill = 0;
  }

  if (state.arrowLeftFill > MENU_WIDTH * 0.35) {
    state.arrowLeftFill = 0;
    state.selectedIdx = wrapIdx(state.selectedIdx - 1, controller.items.length);
    state.cooldownRight = 1;
    sounds.soundClick?.play();
  }
  if (state.arrowRightFill > MENU_WIDTH * 0.35) {
    state.arrowRightFill = 0;
    state.selectedIdx = wrapIdx(state.selectedIdx + 1, controller.items.length);
    state.cooldownLeft = 1;
    sounds.soundClick?.play();
  }
}

function wrapIdx(idx: number, len: number): number {
  if (len === 0) return 0;
  return ((idx % len) + len) % len;
}

function toggleSelectedApp(controller: MenuController, idx: number): void {
  const item = controller.items[idx];
  if (!item) return;
  if (controller.active() === item.slug) {
    controller.setActive(null);
  } else {
    controller.setActive(item.slug);
  }
}

function readTip(feed: PoolFeed, handIdx: number): { x: number; y: number } | null {
  const hand = feed.hands.hands[handIdx];
  if (!hand) return null;
  const tip = hand[INDEX_TIP];
  if (!tip || tip.length < 2) return null;
  const xn = tip[0];
  const yn = tip[1];
  if (typeof xn !== 'number' || typeof yn !== 'number') return null;
  return { x: xn * REF_WIDTH, y: yn * REF_HEIGHT };
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

function draw(ctx: CanvasRenderingContext2D, state: State, controller: MenuController): void {
  // Show the fingertip dot while menu is *not* yet open (matches legacy debug
  // dot behaviour). We draw a small white circle at hand-0's index tip.
  if (state.openPct === 0 && !state.isOpening) return;

  const actualW = (state.openPct * MENU_WIDTH) / 100;
  const actualH = (state.openPct * MENU_HEIGHT) / 100;

  ctx.save();
  ctx.translate(state.menuX, MENU_Y);
  ctx.rotate(Math.PI);

  // Outline.
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  strokeRect(ctx, -actualW / 2, -actualH / 2, actualW, actualH, 2, '#ffffff');

  if (state.isOpen && state.openPct === 100) {
    drawMenuContents(ctx, state, controller);
  }

  ctx.restore();
}

function drawMenuContents(
  ctx: CanvasRenderingContext2D,
  state: State,
  controller: MenuController,
): void {
  // Header (rotated frame coords).
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 40px ui-monospace, monospace';
  ctx.fillText('- MENU -', 0, -(MENU_HEIGHT / 2) * 0.8);
  ctx.font = '28px ui-monospace, monospace';
  // Two-line instruction.
  const helpLine1 = 'Keep your index on';
  const helpLine2 = 'an app to launch it';
  ctx.fillText(helpLine1, 0, -(MENU_HEIGHT / 2) * 0.6 - 16);
  ctx.fillText(helpLine2, 0, -(MENU_HEIGHT / 2) * 0.6 + 16);

  drawAppCard(ctx, state, controller);
  drawArrowButtons(ctx, state);
}

function drawAppCard(
  ctx: CanvasRenderingContext2D,
  state: State,
  controller: MenuController,
): void {
  const item = controller.items[state.selectedIdx];
  const w = MENU_WIDTH * 0.7;
  const h = MENU_HEIGHT * 0.4;
  const x = -MENU_WIDTH * 0.35;
  const y = -MENU_HEIGHT * 0.15;

  // Card outline (green when running, lavender otherwise).
  const running = item && controller.active() === item.slug;
  ctx.lineWidth = 5;
  ctx.strokeStyle = running ? '#00ff7f' : '#d8bfd8';
  ctx.strokeRect(x, y, w, h);

  // Hover progress fill.
  if (state.appFill > 0) {
    fillRect(ctx, x, y, Math.min(state.appFill, w), h, 'rgba(125,125,125,0.85)');
  }

  // App label (legacy capitalises and replaces _ with newline).
  ctx.fillStyle = '#ffffff';
  ctx.font = '38px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const label = item ? item.label : '(no apps)';
  const lines = label.split('\n');
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
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(MENU_WIDTH * 0.15, -MENU_HEIGHT * 0.03);
  ctx.lineTo(MENU_WIDTH * 0.15, MENU_HEIGHT * 0.03);
  ctx.lineTo(MENU_WIDTH * 0.225, 0);
  ctx.closePath();
  ctx.fill();

  // Fill progress (grey rectangles growing from each button's outer edge).
  if (state.arrowLeftFill > 0) {
    fillRect(
      ctx,
      -MENU_WIDTH * 0.35,
      -MENU_HEIGHT * 0.05,
      Math.min(state.arrowLeftFill, MENU_WIDTH * 0.35),
      MENU_HEIGHT * 0.1,
      'rgba(125,125,125,0.85)',
    );
  }
  if (state.arrowRightFill > 0) {
    fillRect(
      ctx,
      0,
      -MENU_HEIGHT * 0.05,
      Math.min(state.arrowRightFill, MENU_WIDTH * 0.35),
      MENU_HEIGHT * 0.1,
      'rgba(125,125,125,0.85)',
    );
  }

  ctx.restore();
}
