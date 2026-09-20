import { describe, expect, test } from 'bun:test';
import { LayerManager } from '@gosai/sdk';
import { AssetRegistry, type FetchLike } from '../src/shared/assets.js';
import { foregroundLayer, GuideOverlay, newcomerLayer } from '../src/shared/guide.js';
import type { LayerDef, Layers } from '../src/shared/layers.js';
import type { FrameContext } from '../src/shared/types.js';

const GUIDE = { lines: ['what it is'], hint: 'what to do' } as const;

function def(slug: string, extra: Partial<LayerDef> = {}): LayerDef {
  return {
    slug,
    label: slug,
    inMenu: true,
    guide: GUIDE,
    create: () => ({}),
    ...extra,
  };
}

function manager(defs: readonly LayerDef[]): Layers {
  return new LayerManager<FrameContext, LayerDef>(defs);
}

/** A 2D context that records the text it drew and measures at 10px a character. */
function textContext(): { ctx: CanvasRenderingContext2D; text: string[] } {
  const text: string[] = [];
  const state: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    measureText: (value: string) => ({ width: value.length * 10 }),
    fillText: (value: string) => void text.push(value),
  };
  const ctx = new Proxy(state, {
    get: (target, prop) => (prop in target ? target[prop] : (...args: unknown[]) => void args),
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, text };
}

function emptyRegistry(): AssetRegistry {
  return new AssetRegistry(
    (path) => path,
    () => undefined,
    (() => Promise.reject(new Error('not used'))) as FetchLike,
  );
}

describe('foregroundLayer', () => {
  test('is the top-most running scene', async () => {
    const layers = manager([def('dance', { zIndex: 6 }), def('aria', { zIndex: 5 })]);
    await layers.start('aria');
    await layers.start('dance');
    expect(foregroundLayer(layers)?.slug).toBe('dance');
  });

  test('ignores the overlays, whose z-index sits above every scene', async () => {
    const layers = manager([
      def('body', { zIndex: 50, overlay: true }),
      def('dance', { zIndex: 6 }),
    ]);
    await layers.start('body');
    await layers.start('dance');
    expect(foregroundLayer(layers)?.slug).toBe('dance');
  });

  test('is nothing while only overlays run', async () => {
    const layers = manager([def('body', { zIndex: 50, overlay: true })]);
    await layers.start('body');
    expect(foregroundLayer(layers)).toBeNull();
  });

  test('skips layers with nothing to say', async () => {
    const layers = manager([def('clock', { zIndex: 40, guide: undefined })]);
    await layers.start('clock');
    expect(foregroundLayer(layers)).toBeNull();
  });
});

describe('newcomerLayer', () => {
  test('introduces the scene, not the overlay it pulled in with it', async () => {
    const layers = manager([
      def('body', { zIndex: 50, overlay: true }),
      def('dance', { zIndex: 6, required: ['body'] }),
    ]);
    await layers.start('dance');
    expect(newcomerLayer(layers, new Set())?.slug).toBe('dance');
  });

  test('introduces an overlay started on its own', async () => {
    const layers = manager([def('hands', { zIndex: 60, overlay: true })]);
    await layers.start('hands');
    expect(newcomerLayer(layers, new Set())?.slug).toBe('hands');
  });

  test('is nothing when nothing started', async () => {
    const layers = manager([def('dance')]);
    await layers.start('dance');
    expect(newcomerLayer(layers, new Set(['dance']))).toBeNull();
  });
});

describe('GuideOverlay', () => {
  test('stays quiet about the layers already running at startup', async () => {
    const layers = manager([def('body', { overlay: true })]);
    await layers.start('body');
    const guide = new GuideOverlay(layers, emptyRegistry(), 'idle hint');

    guide.update(0);
    const { ctx, text } = textContext();
    guide.render(ctx, 0);
    expect(text).toEqual(['idle hint']);
  });

  test('cards a layer that starts, then falls back to its hint', async () => {
    const layers = manager([def('dance', { label: 'Dance' })]);
    const guide = new GuideOverlay(layers, emptyRegistry(), 'idle hint');
    guide.update(0);

    await layers.start('dance');
    guide.update(100);
    const shown = textContext();
    guide.render(shown.ctx, 100);
    expect(shown.text).toEqual(['Dance', 'what it is', 'what to do']);

    const later = textContext();
    guide.render(later.ctx, 100_000);
    expect(later.text).toEqual(['what to do']);
  });

  test('drops the card when its layer stops', async () => {
    const layers = manager([def('dance')]);
    const guide = new GuideOverlay(layers, emptyRegistry(), 'idle hint');
    guide.update(0);
    await layers.start('dance');
    guide.update(100);
    await layers.stop('dance');
    guide.update(200);

    const { ctx, text } = textContext();
    guide.render(ctx, 200);
    expect(text).toEqual(['idle hint']);
  });

  test('keeps the card of a broken layer up past the fade, with the fix on it', async () => {
    const layers = manager([def('aria', { label: 'Aria' })]);
    const assets = new AssetRegistry(
      (path) => path,
      () => undefined,
      (async () => new Response(null, { status: 404 })) as FetchLike,
    );
    await assets.require('aria', ['aria/models/papa_de_him_chan.vrm']);
    const guide = new GuideOverlay(layers, assets, 'idle hint');
    guide.update(0);
    await layers.start('aria');
    guide.update(100);

    const { ctx, text } = textContext();
    guide.render(ctx, 100_000);
    expect(text[0]).toBe('Aria');
    expect(text.join(' ')).toContain('Missing papa_de_him_chan.vrm.');
    expect(text.at(-1)).toContain('git lfs pull');
  });
});
