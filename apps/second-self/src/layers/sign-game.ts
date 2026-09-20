/**
 * Sign Game: a sign-language visual novel.
 *
 * The story is authored in a small scripting language (`$bg`, `$show`, `$menu`,
 * `$if`, dialog lines, ...). The player advances dialog by holding the "ok"
 * sign and picks menu choices by holding the matching sign; the avatar
 * demonstrates each one, and a bar fills as the hold builds up.
 *
 * The engine keeps the legacy script format and sign-driven interaction.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawContain, drawCover, drawText, fillRect, strokeRect } from '../shared/draw.js';
import { createMediaCache, MediaCache } from '../shared/media.js';
import { SignTracker } from '../shared/sign.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from '../shared/types.js';
import type { Rect } from '../shared/ui.js';

type Pos = 'LEFT' | 'CENTER' | 'RIGHT';

type Element =
  | { type: 'bg'; id: string }
  | { type: 'show'; name: string; pos: Pos }
  | { type: 'hide'; name: string }
  | { type: 'setSprite'; name: string; sprite: string }
  | { type: 'addAnim'; name: string; anim: string }
  | { type: 'setVar'; name: string; value: string }
  | { type: 'jump'; tag: string }
  | { type: 'if'; name: string; value: string; trueTag: string; falseTag: string }
  | { type: 'dialog'; name: string; text: string; cmd: string | null }
  | { type: 'menu'; char: string; items: Array<{ sign: string; tag: string }> }
  | { type: 'end' };

interface CharState {
  visible: boolean;
  sprite: string | null;
  pos: Pos;
  anim: string | null;
}

const ADVANCE_COOLDOWN_MS = 1500;
const POS_X: Record<Pos, number> = { LEFT: 320, CENTER: 540, RIGHT: 760 };
/** The dialogue box, and the ground the characters stand on just above it. */
const TEXT_BOX = { x: 40, y: 1450, w: REF_WIDTH - 80, h: 410 } as const;
const GROUND_Y = TEXT_BOX.y - 20;
/**
 * The box a character's sprite is fitted into. Every sprite is cropped to the
 * same shared box (see the app README), so one box lands every character on
 * the same ground line at the same scale, whatever their pose.
 */
const SPRITE_BOX = { y: GROUND_Y - 400, width: 520, height: 800 } as const;
/**
 * The box a character's sign clip is fitted into, `dx` from its POS_X. The
 * clips frame Aria closer than her sprites do, so this box is fitted to make
 * her body the same size as her sprite's, standing on the same ground line:
 * the switch between the two doesn't jump.
 */
const ANIM_BOX = { dx: 54, y: GROUND_Y - 449, width: 615, height: 897 } as const;
/**
 * The sign that turns a page of dialogue. Its clip plays in the corner of the
 * text box: naming a sign only helps someone who already knows it. It is drawn
 * framed and captioned so it reads as a button, not as a second character.
 */
const ADVANCE_SIGN = 'ok';
const ADVANCE_BOX = { x: 790, y: 1478, w: 230, h: 310 } as const;
/** Dialogue wraps before the clip, leaving a gutter between the two. */
const DIALOG_TEXT_WIDTH = ADVANCE_BOX.x - 80 - 40;
/** The sign clips, whose portrait shape sets the height of a choice column. */
const CLIP_WIDTH = 444;
const CLIP_HEIGHT = 648;
/** The choice columns: as wide as they fit, stacked just above the text box. */
const MENU_WIDTH = REF_WIDTH - 80;
const MENU_GAP = 20;
const MENU_LABEL_H = 64;
const MENU_MAX_COLUMN_W = 425;
const MENU_BOTTOM = TEXT_BOX.y - 50;
const FONT_FAMILY = 'PressStart2P';

export function createSignGameLayer(deps: LayerDeps): Layer {
  const tracker = new SignTracker();
  const media = createMediaCache();
  let program: Element[] = [];
  const tagMap = new Map<string, number>();
  const imageDefs = new Map<string, string>();
  const charColors = new Map<string, string>();
  let fontLoaded = false;

  const chars = new Map<string, CharState>();
  const variables = new Map<string, string>();
  let bg: string | null = null;
  let index = 0;
  let mode: 'run' | 'dialog' | 'menu' | 'end' = 'run';
  let lastInteraction = 0;
  let lastDialog: { name: string; text: string } | null = null;
  let currentMenu: Array<{ sign: string; tag: string }> = [];
  let currentMenuChar = 'Aria';

  function imageUrl(id: string): string | null {
    const file = imageDefs.get(id);
    return file ? deps.asset(`sign-game/backgrounds/${file}`) : null;
  }
  const spriteUrl = (name: string, sprite: string): string =>
    deps.asset(`sign-game/characters/${name}/sprites/${sprite}.png`);
  const animUrl = (name: string, anim: string): string => deps.asset(`signs/${name}/${anim}.webm`);

  function ensureChar(name: string): CharState {
    let c = chars.get(name);
    if (!c) {
      c = { visible: false, sprite: null, pos: 'CENTER', anim: null };
      chars.set(name, c);
    }
    return c;
  }

  function resetStory(): void {
    chars.clear();
    variables.clear();
    bg = null;
    index = 0;
    mode = 'run';
    lastDialog = null;
    currentMenu = [];
    lastInteraction = performance.now();
    tracker.reset();
    advance();
  }

  /** Execute instantaneous commands until a dialog/menu/end waits for input. */
  function advance(): void {
    let guard = 0;
    while (index < program.length && guard++ < 10000) {
      const el = program[index]!;
      switch (el.type) {
        case 'bg':
          bg = el.id === 'none' ? null : imageUrl(el.id);
          index++;
          break;
        case 'show': {
          const c = ensureChar(el.name);
          c.visible = true;
          c.pos = el.pos;
          index++;
          break;
        }
        case 'hide': {
          const c = ensureChar(el.name);
          c.visible = false;
          c.anim = null;
          index++;
          break;
        }
        case 'setSprite': {
          const c = ensureChar(el.name);
          c.sprite = el.sprite;
          c.anim = null;
          index++;
          break;
        }
        case 'addAnim': {
          const c = ensureChar(el.name);
          c.anim = el.anim;
          index++;
          break;
        }
        case 'setVar':
          variables.set(el.name, el.value);
          index++;
          break;
        case 'jump':
          index = tagMap.get(el.tag) ?? program.length;
          break;
        case 'if': {
          const v = variables.get(el.name);
          const target = v === el.value ? el.trueTag : el.falseTag;
          index = tagMap.get(target) ?? program.length;
          break;
        }
        case 'dialog':
          applyDialogCmd(el);
          lastDialog = { name: el.name, text: el.text };
          mode = 'dialog';
          tracker.setCandidates([ADVANCE_SIGN]);
          return;
        case 'menu':
          currentMenu = el.items;
          currentMenuChar = el.char;
          mode = 'menu';
          // Only the answers on offer count; everything else the recogniser
          // wanders onto is noise. Hands already up must come back to rest
          // before they can answer the question they were up for.
          tracker.setCandidates(el.items.map((item) => item.sign));
          tracker.consume();
          return;
        case 'end':
          mode = 'end';
          return;
      }
    }
    mode = 'end';
  }

  function applyDialogCmd(el: { name: string; cmd: string | null }): void {
    if (!el.cmd) return;
    const c = chars.get(el.name);
    if (!c) return;
    if (el.cmd.includes('LEFT')) c.pos = 'LEFT';
    else if (el.cmd.includes('RIGHT')) c.pos = 'RIGHT';
    else if (el.cmd.includes('CENTER')) c.pos = 'CENTER';
  }

  function onAdvanceDialog(now: number): void {
    if (now - lastInteraction < ADVANCE_COOLDOWN_MS) return;
    lastInteraction = now;
    // Still holding the sign that turned this page must not turn the next one.
    tracker.consume();
    index++;
    advance();
  }

  function chooseMenu(item: { sign: string; tag: string }, now: number): void {
    lastInteraction = now;
    tracker.consume();
    index = tagMap.get(item.tag) ?? program.length;
    currentMenu = [];
    advance();
  }

  const onPointer = (): void => {
    if (mode === 'dialog') onAdvanceDialog(performance.now());
  };

  return {
    async preload(): Promise<void> {
      // The story, and the clip of the sign that turns its pages. The
      // backgrounds and sprites the script names are checked as it runs.
      await deps.assets.require('sign-game', [
        'sign-game/script.txt',
        `signs/Aria/${ADVANCE_SIGN}.webm`,
      ]);
      try {
        const resp = await fetch(deps.asset('sign-game/script.txt'));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const parsed = parseScript(await resp.text());
        program = parsed.program;
        for (const [k, v] of parsed.tags) tagMap.set(k, v);
        for (const [k, v] of parsed.images) imageDefs.set(k, v);
        for (const [k, v] of parsed.colors) charColors.set(k, v);
      } catch (err) {
        deps.rt.log.warn('sign-game: failed to load script', { err: String(err) });
      }
      try {
        const url = deps.asset('sign-game/fonts/PressStart2P.ttf');
        const face = new FontFace(FONT_FAMILY, `url(${url})`);
        await face.load();
        document.fonts.add(face);
        fontLoaded = true;
      } catch (err) {
        deps.rt.log.warn('sign-game: failed to load the font', { err: String(err) });
      }
    },

    start(): void {
      window.addEventListener('pointerdown', onPointer, { signal: deps.rt.signal });
      resetStory();
    },

    render({ ctx, timestamp, deltaMs }): void {
      // Holds are measured in wall-clock time, so they advance every frame,
      // not only when the recogniser produces a guess.
      tracker.update(deps.feed, deltaMs, timestamp);
      if (mode === 'dialog' && tracker.held(ADVANCE_SIGN)) onAdvanceDialog(timestamp);
      else if (mode === 'menu') updateMenu(timestamp);

      // Background. The art is wide (up to 3:1) and the mirror is portrait, so
      // it is cropped to fill rather than squeezed into the frame.
      if (bg) {
        const img = media.image(bg);
        if (MediaCache.imageReady(img)) {
          drawCover(ctx, img, img.naturalWidth, img.naturalHeight, 0, 0, REF_WIDTH, REF_HEIGHT);
        } else {
          fillRect(ctx, 0, 0, REF_WIDTH, REF_HEIGHT, '#101018');
        }
      } else {
        fillRect(ctx, 0, 0, REF_WIDTH, REF_HEIGHT, '#000000');
      }

      drawCharacters(ctx);

      if (mode === 'menu') drawMenu(ctx);
      else if (mode === 'dialog') drawDialog(ctx);
      else if (mode === 'end') drawEnd(ctx);
      media.pauseUnused();
    },

    suspend(): void {
      media.pauseAll();
    },

    stop(): void {
      window.removeEventListener('pointerdown', onPointer);
      media.release();
      tracker.reset();
    },
  };

  function drawCharacters(ctx: CanvasRenderingContext2D): void {
    for (const [name, c] of chars) {
      if (!c.visible) continue;
      if (c.anim) {
        const v = media.video(animUrl(name, c.anim));
        if (media.playing(v)) {
          const { dx, y, width, height } = ANIM_BOX;
          drawContain(ctx, v, v.videoWidth, v.videoHeight, POS_X[c.pos] + dx, y, width, height);
        }
      } else if (c.sprite) {
        const img = media.image(spriteUrl(name, c.sprite));
        if (MediaCache.imageReady(img)) {
          const { y, width, height } = SPRITE_BOX;
          drawContain(
            ctx,
            img,
            img.naturalWidth,
            img.naturalHeight,
            POS_X[c.pos],
            y,
            width,
            height,
          );
        }
      }
    }
  }

  function drawDialog(ctx: CanvasRenderingContext2D): void {
    if (!lastDialog) return;
    drawTextBox(ctx);
    const named = lastDialog.name !== 'N';
    let y = 1520;
    if (named) {
      drawText(
        ctx,
        `${lastDialog.name}:`,
        80,
        y,
        34,
        charColors.get(lastDialog.name) ?? '#fff',
        'left',
        'top',
        font(),
      );
      y += 60;
    }
    wrapText(ctx, lastDialog.text, 80, y, DIALOG_TEXT_WIDTH, 44, 26, '#fff', font());
    drawAdvanceHint(ctx);
    drawSignProgress(ctx);
  }

  /** Aria performing the sign that turns the page, with how far the hold has got. */
  function drawAdvanceHint(ctx: CanvasRenderingContext2D): void {
    const { x, y, w, h } = ADVANCE_BOX;
    const progress = tracker.progressFor(ADVANCE_SIGN);
    const color = progress > 0 ? '#ff8100' : 'rgb(235,52,198)';
    // Framed and captioned, in the same shape as a choice: the clip is a
    // button showing the sign that turns the page, not a character.
    fillRect(ctx, x, y, w, h, 'rgba(0,0,0,0.45)');
    strokeRect(ctx, x, y, w, h, 3, color);
    const video = media.video(animUrl('Aria', ADVANCE_SIGN));
    if (media.playing(video)) {
      drawContain(ctx, video, video.videoWidth, video.videoHeight, x + w / 2, y + h / 2, w, h);
    }
    if (progress > 0) fillRect(ctx, x, y, w * progress, 10, '#ff8100');
    const caption = tracker.armed() ? 'copy to go on' : 'lower hands';
    drawText(ctx, caption, x + w / 2, y + h + 32, 18, color, 'center', 'middle', font());
  }

  interface Column {
    readonly item: { sign: string; tag: string };
    readonly rect: Rect;
    readonly clipH: number;
  }

  /** The choice columns: as wide as they fit, stacked just above the text box. */
  function menuColumns(): Column[] {
    const n = currentMenu.length;
    // A column is never wider than its clip: one choice shouldn't become a
    // letterboxed wall. The row of them is centred on whatever is left over.
    const w = Math.min((MENU_WIDTH - (n - 1) * MENU_GAP) / n, MENU_MAX_COLUMN_W);
    const clipH = w * (CLIP_HEIGHT / CLIP_WIDTH);
    const top = MENU_BOTTOM - clipH - MENU_LABEL_H;
    const left = (REF_WIDTH - (n * w + (n - 1) * MENU_GAP)) / 2;
    return currentMenu.map((item, i) => ({
      item,
      clipH,
      rect: { x: left + i * (w + MENU_GAP), y: top, w, h: clipH + MENU_LABEL_H },
    }));
  }

  function updateMenu(timestamp: number): void {
    for (const { item } of menuColumns()) {
      if (tracker.held(item.sign)) {
        chooseMenu(item, timestamp);
        return;
      }
    }
  }

  function drawMenu(ctx: CanvasRenderingContext2D): void {
    // The choices are a modal over the scene: everything behind them dims,
    // and the line that asked the question stays lit.
    fillRect(ctx, 0, 0, REF_WIDTH, REF_HEIGHT, 'rgba(0,0,0,0.55)');
    if (lastDialog) {
      drawTextBox(ctx);
      wrapText(ctx, lastDialog.text, 80, 1500, REF_WIDTH - 160, 44, 26, '#fff', font());
    }

    const columns = menuColumns();
    for (const { item, rect, clipH } of columns) {
      const { x, y, w, h } = rect;
      const progress = tracker.progressFor(item.sign);
      const matching = progress > 0;

      fillRect(ctx, x, y, w, h, 'rgba(0,0,0,0.8)');
      strokeRect(ctx, x, y, w, h, 4, matching ? '#ff8100' : '#ffffff');
      fillRect(ctx, x, y, w * progress, 14, '#ff8100');

      const vid = media.video(animUrl(currentMenuChar, item.sign));
      if (media.playing(vid)) {
        drawContain(ctx, vid, vid.videoWidth, vid.videoHeight, x + w / 2, y + clipH / 2, w, clipH);
      }
      drawText(
        ctx,
        item.sign,
        x + w / 2,
        y + clipH + MENU_LABEL_H / 2,
        30,
        matching ? '#ff8100' : '#fff',
        'center',
        'middle',
        font(),
      );
    }

    drawText(
      ctx,
      menuPrompt(),
      REF_WIDTH / 2,
      (columns[0]?.rect.y ?? MENU_BOTTOM) - 44,
      30,
      'rgba(255,255,255,0.85)',
      'center',
      'middle',
      font(),
    );
    drawSignProgress(ctx);
  }

  /** Kept short: the pixel font is monospaced and the screen is 1080 wide. */
  function menuPrompt(): string {
    if (!tracker.armed()) return 'Hands down, then copy a sign';
    // Lookalikes commit to nothing, which is silent without saying why.
    if (tracker.contested()) return 'Too alike: sign one more clearly';
    return 'Copy a sign to choose';
  }

  function drawEnd(ctx: CanvasRenderingContext2D): void {
    drawText(
      ctx,
      '- End of Script -',
      REF_WIDTH / 2,
      REF_HEIGHT / 2,
      40,
      '#fff',
      'center',
      'middle',
      font(),
    );
    drawText(
      ctx,
      'Open Sign Game from the menu to play again',
      REF_WIDTH / 2,
      REF_HEIGHT / 2 + 60,
      24,
      'rgba(255,255,255,0.6)',
      'center',
      'middle',
      font(),
    );
  }

  function drawSignProgress(ctx: CanvasRenderingContext2D): void {
    if (!tracker.sign) return;
    drawText(
      ctx,
      `sign: ${tracker.sign}`,
      REF_WIDTH - 60,
      60,
      24,
      'rgba(255,255,255,0.7)',
      'right',
      'middle',
      font(),
    );
  }

  function font(): string {
    return fontLoaded ? `${FONT_FAMILY}, monospace` : 'monospace';
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawTextBox(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, h } = TEXT_BOX;
  fillRect(ctx, x, y, w, h, 'rgba(0,0,0,0.7)');
  strokeRect(ctx, x, y, w, h, 4, '#ffffff');
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  fontPx: number,
  color: string,
  font: string,
): void {
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px ${font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}

// ---------------------------------------------------------------------------
// Script parser
// ---------------------------------------------------------------------------

interface ParseResult {
  program: Element[];
  tags: Map<string, number>;
  images: Map<string, string>;
  colors: Map<string, string>;
}

function parseScript(text: string): ParseResult {
  const program: Element[] = [];
  const tags = new Map<string, number>();
  const images = new Map<string, string>();
  const colors = new Map<string, string>();

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('$')) {
      parseCommand(line, program, tags, images, colors);
      continue;
    }
    if (line === 'END') {
      program.push({ type: 'end' });
      continue;
    }
    // Dialog: "Name: text" optionally with "&CMD".
    const colon = line.indexOf(': ');
    if (colon > 0) {
      const name = line.slice(0, colon);
      let body = line.slice(colon + 2);
      let cmd: string | null = null;
      const amp = body.indexOf('&');
      if (amp >= 0) {
        cmd = body.slice(amp + 1);
        body = body.slice(0, amp).trim();
      }
      program.push({ type: 'dialog', name, text: body, cmd });
    }
  }

  return { program, tags, images, colors };
}

const RE_QUOTED = /"([^"]*)"/g;

function parseCommand(
  line: string,
  program: Element[],
  tags: Map<string, number>,
  images: Map<string, string>,
  colors: Map<string, string>,
): void {
  if (line.startsWith('$tag')) {
    const id = firstIdent(line.slice(4));
    if (id) tags.set(id, program.length);
  } else if (line.startsWith('$defineC')) {
    const quoted = [...line.matchAll(RE_QUOTED)].map((m) => m[1]!);
    const color = line.match(/color\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (quoted[0]) {
      colors.set(quoted[0], color ? `rgb(${color[1]},${color[2]},${color[3]})` : '#ffffff');
    }
  } else if (line.startsWith('$defineImg')) {
    const id = firstIdent(line.slice(10));
    const quoted = line.match(RE_QUOTED);
    if (id && quoted) {
      const path = quoted[0].replace(/"/g, '');
      images.set(id, path.split('/').pop()!);
    }
  } else if (line.startsWith('$bg')) {
    const id = firstIdent(line.slice(3));
    if (id) program.push({ type: 'bg', id });
  } else if (line.startsWith('$show')) {
    const name = firstQuoted(line);
    const pos = posOf(line);
    if (name) program.push({ type: 'show', name, pos });
  } else if (line.startsWith('$hide')) {
    const name = firstQuoted(line);
    if (name) program.push({ type: 'hide', name });
  } else if (line.startsWith('$setSprite')) {
    const q = [...line.matchAll(RE_QUOTED)].map((m) => m[1]!);
    if (q[0] && q[1]) program.push({ type: 'setSprite', name: q[0], sprite: q[1] });
  } else if (line.startsWith('$addAnimation')) {
    const q = [...line.matchAll(RE_QUOTED)].map((m) => m[1]!);
    if (q[0] && q[1]) program.push({ type: 'addAnim', name: q[0], anim: q[1] });
  } else if (line.startsWith('$jump')) {
    const id = firstIdent(line.slice(5));
    if (id) program.push({ type: 'jump', tag: id });
  } else if (line.startsWith('$setVar')) {
    const inner = line.slice(7).replace(/[()]/g, '');
    const parts = inner.split(',').map((s) => s.trim());
    if (parts[0]) program.push({ type: 'setVar', name: parts[0], value: parts[1] ?? '' });
  } else if (line.startsWith('$if')) {
    const inner = line.slice(3).replace(/[()]/g, '');
    const parts = inner.split(',').map((s) => s.trim());
    if (parts.length >= 4) {
      program.push({
        type: 'if',
        name: parts[0]!,
        value: parts[1]!,
        trueTag: parts[2]!,
        falseTag: parts[3]!,
      });
    }
  } else if (line.startsWith('$menu')) {
    program.push(parseMenu(line));
  }
}

function parseMenu(line: string): Element {
  // $menu("char", "menu name", count, "sign1", tag1, "sign2", tag2, ...)
  const args = splitArgs(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')));
  const char = stripQuotes(args[0] ?? '"Aria"');
  const items: Array<{ sign: string; tag: string }> = [];
  for (let i = 3; i + 1 < args.length; i += 2) {
    items.push({ sign: stripQuotes(args[i]!), tag: args[i + 1]!.trim() });
  }
  return { type: 'menu', char, items };
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (ch === '(' && !inStr) depth++;
    if (ch === ')' && !inStr) depth--;
    if (ch === ',' && depth === 0 && !inStr) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^"|"$/g, '');
}

function firstQuoted(line: string): string | null {
  const m = line.match(/"([^"]*)"/);
  return m ? m[1]! : null;
}

function firstIdent(s: string): string | null {
  const m = s.match(/([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1]! : null;
}

function posOf(line: string): Pos {
  if (line.includes('LEFT')) return 'LEFT';
  if (line.includes('RIGHT')) return 'RIGHT';
  return 'CENTER';
}
