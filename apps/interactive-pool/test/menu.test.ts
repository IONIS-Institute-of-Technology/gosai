import { describe, expect, test } from 'bun:test';
import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { createMenuLayer, type MenuLayers } from '../src/layers/menu.js';
import { createTracking } from '../src/tracking.js';
import type { Hand, PoolLayer, PoolLayerDefinition } from '../src/shared/types.js';
import { frame } from './fakes.js';

const FRAME_MS = 1000 / 60;

/** A hand whose 21 landmarks all sit at (x, y) reference pixels. */
function hand(x: number, y: number): Hand {
  return Array.from({ length: 21 }, () => [x / 1920, y / 1080, 0]);
}

function scene(slug: string, autoStop = false): PoolLayerDefinition {
  return { slug, exclusive: true, menu: { label: slug, autoStop }, create: () => ({}) };
}

async function harness() {
  const running = new Set<string>();
  const calls: string[] = [];
  const layers: MenuLayers = {
    definitions: () => [
      scene('rabbits_game'),
      scene('affine', true),
      { slug: 'balls', persistent: true, create: () => ({}) },
    ],
    isRunning: (slug) => running.has(slug),
    stop: async (slug) => {
      calls.push(`stop ${slug}`);
      running.delete(slug);
    },
    toggle: async (slug) => {
      calls.push(`toggle ${slug}`);
      if (!running.delete(slug)) running.add(slug);
    },
  };
  const played: string[] = [];
  const menu: PoolLayer = createMenuLayer({} as ExperienceRuntimeContext, layers, async (path) => ({
    play: () => void played.push(path.replace(/^.*\//, '')),
  }));
  await menu.preload?.();

  let now = performance.now();
  const tracking = createTracking();
  /** Renders `count` frames at 60 fps with these hands on the table. */
  const run = (count: number, ...hands: Hand[]): void => {
    tracking.hands = hands;
    for (let i = 0; i < count; i++) {
      now += FRAME_MS;
      menu.render?.(frame(now, tracking, FRAME_MS));
    }
  };
  const skip = (ms: number): void => {
    now += ms;
  };
  return { run, skip, running, calls, played };
}

/** Pinch both index fingers together, then spread them apart. */
function openMenu(h: Awaited<ReturnType<typeof harness>>): void {
  h.run(1, hand(960, 540), hand(1000, 540));
  h.run(1, hand(800, 540), hand(1150, 540));
  // The open animation takes 20 frames.
  h.run(20, hand(800, 540), hand(1150, 540));
}

describe('gesture menu', () => {
  test('pinch then spread opens it, spread then pinch closes it', async () => {
    const h = await harness();
    // Spreading without a pinch first does nothing.
    h.run(5, hand(800, 540), hand(1150, 540));
    expect(h.played).toEqual([]);

    openMenu(h);
    expect(h.played).toEqual(['opening_menu.mp3']);

    // Still spread: arms the close; pinching closes.
    h.run(1, hand(800, 540), hand(1150, 540));
    h.run(1, hand(960, 540), hand(1000, 540));
    expect(h.played).toEqual(['opening_menu.mp3', 'closing_menu.mp3']);
  });

  test('a pinch expires when the spread comes too late', async () => {
    const h = await harness();
    h.run(1, hand(960, 540), hand(1000, 540));
    h.run(40);
    h.run(1, hand(800, 540), hand(1150, 540));
    expect(h.played).toEqual([]);
  });

  test('holding a finger on the card toggles its layer and closes the menu', async () => {
    const h = await harness();
    openMenu(h);

    // The card fills 4 px per frame and triggers past 210 px.
    h.run(52, hand(960, 540));
    expect(h.calls).toEqual([]);
    h.run(1, hand(960, 540));
    expect(h.calls).toEqual(['toggle rabbits_game']);
    expect(h.running.has('rabbits_game')).toBe(true);
    expect(h.played).toEqual(['opening_menu.mp3', 'click.mp3', 'closing_menu.mp3']);
  });

  test('the arrows select the next card', async () => {
    const h = await harness();
    openMenu(h);
    // A finger left of centre in the arrow row fills the button that reads as
    // "next" from the projector side: 2 px per frame, past 105 px.
    h.run(52, hand(900, 540 - 600 * 0.375));
    expect(h.played).toEqual(['opening_menu.mp3']);
    h.run(1, hand(900, 540 - 600 * 0.375));
    expect(h.played).toEqual(['opening_menu.mp3', 'click.mp3']);

    h.run(53, hand(960, 540));
    expect(h.calls).toEqual(['toggle affine']);
  });

  test('stops an auto-stop layer after a minute without hands', async () => {
    const h = await harness();
    h.running.add('affine');
    h.running.add('rabbits_game');
    h.run(1, hand(100, 100));

    h.skip(59_000);
    h.run(1);
    expect(h.calls).toEqual([]);

    h.skip(1_000);
    h.run(1);
    expect(h.calls).toEqual(['stop affine']);
    expect(h.running.has('rabbits_game')).toBe(true);
  });

  test('a hand on the table keeps auto-stop layers running', async () => {
    const h = await harness();
    h.running.add('affine');
    for (let i = 0; i < 4; i++) {
      h.skip(20_000);
      h.run(1, hand(100, 100));
    }
    expect(h.calls).toEqual([]);
  });
});
