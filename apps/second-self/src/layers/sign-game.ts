/**
 * Sign Game: a sign-language visual novel.
 *
 * Ports the legacy `sign_game` app (a custom VN engine + `script.txt`). The
 * story is authored in a small scripting language (`$bg`, `$show`, `$menu`,
 * `$if`, dialog lines, ...). The player advances dialog by making the "ok"
 * sign and picks menu choices by performing the matching sign; the avatar
 * demonstrates each option via its sign-animation videos.
 *
 * This is a clean re-implementation of the engine in TypeScript + Canvas2D,
 * preserving the script format and the sign-driven interaction.
 */

import { drawText, fillRect } from '../shared/canvas.js';
import type { LayerDeps } from '../shared/deps.js';
import { ensureVideoPlaying, getImage, getVideo, imageReady } from '../shared/media.js';
import { SignTracker, SIGN_COUNT_THRESHOLD } from '../shared/sign.js';
import { REF_HEIGHT, REF_WIDTH, type FrameContext, type Layer } from '../shared/types.js';

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

export function createSignGameLayer(deps: LayerDeps): Layer {
  const tracker = new SignTracker();
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
    return file ? deps.assetUrl(`sign-game/backgrounds/${file}`) : null;
  }
  const spriteUrl = (name: string, sprite: string): string =>
    deps.assetUrl(`sign-game/characters/${name}/sprites/${sprite}.png`);
  const animUrl = (name: string, anim: string): string =>
    deps.assetUrl(`sign-game/characters/${name}/animations/${anim}.webm`);

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
          return;
        case 'menu':
          currentMenu = el.items;
          currentMenuChar = el.char;
          mode = 'menu';
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
    index++;
    advance();
  }

  function chooseMenu(item: { sign: string; tag: string }, now: number): void {
    lastInteraction = now;
    index = tagMap.get(item.tag) ?? program.length;
    currentMenu = [];
    advance();
  }

  const onPointer = (): void => {
    if (mode === 'dialog') onAdvanceDialog(performance.now());
  };

  return {
    async preload(): Promise<void> {
      try {
        const resp = await fetch(deps.assetUrl('sign-game/script.txt'));
        const text = await resp.text();
        const parsed = parseScript(text);
        program = parsed.program;
        for (const [k, v] of parsed.tags) tagMap.set(k, v);
        for (const [k, v] of parsed.images) imageDefs.set(k, v);
        for (const [k, v] of parsed.colors) charColors.set(k, v);
      } catch (err) {
        deps.rt.log.warn('sign-game: failed to load script', { err: String(err) });
      }
      try {
        const url = deps.assetUrl('sign-game/fonts/PressStart2P.ttf');
        const face = new FontFace('PressStart2P', `url(${url})`);
        await face.load();
        (document.fonts as unknown as { add(f: FontFace): void }).add(face);
        fontLoaded = true;
      } catch {
        fontLoaded = false;
      }
    },

    start(): void {
      window.addEventListener('pointerdown', onPointer);
      resetStory();
    },

    render(frame: FrameContext): void {
      const { ctx, timestamp } = frame;

      if (tracker.update(deps.feed)) {
        if (mode === 'dialog' && tracker.held('ok')) onAdvanceDialog(timestamp);
        else if (mode === 'menu') {
          for (const item of currentMenu) {
            if (tracker.held(item.sign)) {
              chooseMenu(item, timestamp);
              break;
            }
          }
        }
      }

      // Background.
      if (bg) {
        const img = getImage(bg);
        if (imageReady(img)) ctx.drawImage(img, 0, 0, REF_WIDTH, REF_HEIGHT);
        else fillRect(ctx, 0, 0, REF_WIDTH, REF_HEIGHT, '#101018');
      } else {
        fillRect(ctx, 0, 0, REF_WIDTH, REF_HEIGHT, '#000000');
      }

      drawCharacters(ctx);

      if (mode === 'menu') drawMenu(ctx, timestamp);
      else if (mode === 'dialog') drawDialog(ctx, timestamp);
      else if (mode === 'end') drawEnd(ctx);
    },

    stop(): void {
      window.removeEventListener('pointerdown', onPointer);
      tracker.reset();
    },
  };

  function drawCharacters(ctx: CanvasRenderingContext2D): void {
    for (const [name, c] of chars) {
      if (!c.visible) continue;
      if (c.anim) {
        const v = getVideo(animUrl(name, c.anim));
        if (ensureVideoPlaying(v))
          drawContain(ctx, v, v.videoWidth, v.videoHeight, POS_X[c.pos], 560, 460, 460);
      } else if (c.sprite) {
        const img = getImage(spriteUrl(name, c.sprite));
        if (imageReady(img))
          drawContain(ctx, img, img.naturalWidth, img.naturalHeight, POS_X[c.pos], 620, 520, 760);
      }
    }
  }

  function drawDialog(ctx: CanvasRenderingContext2D, now: number): void {
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
    wrapText(ctx, lastDialog.text, 80, y, REF_WIDTH - 160, 44, 26, '#fff');

    if (now - lastInteraction > 4000) {
      drawText(
        ctx,
        'Make the "ok" sign to continue',
        80,
        1820,
        22,
        'rgb(235,52,198)',
        'left',
        'top',
        font(),
      );
    }
    drawSignProgress(ctx);
  }

  function drawMenu(ctx: CanvasRenderingContext2D, now: number): void {
    if (lastDialog) {
      drawTextBox(ctx);
      wrapText(ctx, lastDialog.text, 80, 1500, REF_WIDTH - 160, 44, 26, '#fff');
    }
    const n = currentMenu.length;
    const w = (REF_WIDTH - 80) / n - 20;
    for (let i = 0; i < n; i++) {
      const item = currentMenu[i]!;
      const x = 60 + i * ((REF_WIDTH - 80) / n);
      const matching = tracker.sign === item.sign;
      const progress = matching ? Math.min(1, tracker.count / SIGN_COUNT_THRESHOLD) : 0;

      ctx.strokeStyle = matching ? '#ff8100' : '#ffffff';
      ctx.lineWidth = 4;
      ctx.strokeRect(x, 950, w, 360);
      fillRect(ctx, x, 950, w * progress, 8, '#ff8100');

      const vid = getVideo(animUrl(currentMenuChar, item.sign));
      if (ensureVideoPlaying(vid))
        drawContain(ctx, vid, vid.videoWidth, vid.videoHeight, x + w / 2, 1110, w - 30, 280);
      drawText(
        ctx,
        item.sign,
        x + w / 2,
        1290,
        30,
        matching ? '#ff8100' : '#fff',
        'center',
        'middle',
        font(),
      );
    }
    drawText(
      ctx,
      'Perform a sign to choose',
      REF_WIDTH / 2,
      900,
      30,
      'rgba(255,255,255,0.8)',
      'center',
      'middle',
      font(),
    );
    drawSignProgress(ctx);
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
      'Make the "goodbye"... or reopen from the menu',
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
      `sign: ${tracker.sign} (${tracker.count}/${SIGN_COUNT_THRESHOLD})`,
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
    return fontLoaded ? 'PressStart2P, monospace' : 'monospace';
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function drawTextBox(ctx: CanvasRenderingContext2D): void {
  fillRect(ctx, 40, 1450, REF_WIDTH - 80, 410, 'rgba(0,0,0,0.7)');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 1450, REF_WIDTH - 80, 410);
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  cx: number,
  cy: number,
  maxW: number,
  maxH: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const scale = Math.min(maxW / sw, maxH / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(src, cx - w / 2, cy - h / 2, w, h);
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
): void {
  ctx.fillStyle = color;
  ctx.font = `${fontPx}px PressStart2P, monospace`;
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
const RE_IDENT = /([A-Za-z_][A-Za-z0-9_]*)/g;

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
  const quoted = [...line.matchAll(RE_QUOTED)].map((m) => m[1]!);
  const char = quoted[0] ?? 'Aria';
  // After char and menu name, items alternate "sign" (quoted) and tag (identifier).
  // Quoted strings: [char, menuName, sign1, sign2, ...]; identifiers between commas are tags.
  const signs = quoted.slice(2);
  // Tags are the identifiers following each sign; capture identifiers that are not keywords/char names.
  const idents = [...line.matchAll(RE_IDENT)].map((m) => m[1]!);
  // Reconstruct items by walking the argument list textually.
  const argsStart = line.indexOf('(');
  const args = splitArgs(line.slice(argsStart + 1, line.lastIndexOf(')')));
  const items: Array<{ sign: string; tag: string }> = [];
  // args: charName, menuName, count, sign1, tag1, sign2, tag2, ...
  for (let i = 3; i + 1 < args.length; i += 2) {
    const sign = stripQuotes(args[i]!);
    const tag = args[i + 1]!.trim();
    items.push({ sign, tag });
  }
  void signs;
  void idents;
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
