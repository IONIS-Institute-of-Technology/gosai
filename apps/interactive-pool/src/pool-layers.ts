/**
 * The layers of the main experience. Scenes are exclusive and listed in the
 * gesture menu; overlays are persistent and run for the whole experience.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';
import { createAffineLayer } from './layers/affine.js';
import { createAmbientDisplayLayer } from './layers/ambient-display.js';
import { createBallsLayer } from './layers/balls.js';
import { createDebugLayer } from './layers/debug.js';
import { createLiveLayer } from './layers/live.js';
import { createMenuLayer, type MenuLayers } from './layers/menu.js';
import { createRabbitsLayer } from './layers/rabbits-game.js';
import { createShowHandsLayer } from './layers/show-hands.js';
import { createTrianglesLayer } from './layers/triangles.js';
import { createUniversLayer } from './layers/univers.js';
import type { PoolSettings } from './settings.js';
import type { PoolLayerDefinition } from './shared/types.js';

/** Overlays that run for the whole experience, in z-order. */
export const OVERLAYS = ['balls', 'hands', 'menu', 'debug', 'live'] as const;

/**
 * `menuLayers` returns the manager the definitions end up in, for the menu to
 * start and stop scenes; it is only called once the layers start.
 */
export function poolLayerDefinitions(
  rt: ExperienceRuntimeContext,
  settings: () => PoolSettings,
  menuLayers: () => MenuLayers,
): PoolLayerDefinition[] {
  const scene = { exclusive: true, zIndex: 0 } as const;
  const overlay = (slug: (typeof OVERLAYS)[number], zIndex: number) =>
    ({ slug, zIndex, persistent: true }) as const;
  return [
    {
      ...scene,
      slug: 'rabbits_game',
      menu: { label: 'Rabbits\nGame' },
      create: createRabbitsLayer,
    },
    {
      ...scene,
      slug: 'affine',
      menu: { label: 'Affine', autoStop: true },
      create: createAffineLayer,
    },
    {
      ...scene,
      slug: 'triangles',
      menu: { label: 'Triangles', autoStop: true },
      create: createTrianglesLayer,
    },
    { ...scene, slug: 'univers', menu: { label: 'Univers' }, create: createUniversLayer },
    {
      ...scene,
      slug: 'ambient_display',
      menu: { label: 'Ambient\nDisplay' },
      create: createAmbientDisplayLayer,
    },
    { ...overlay('balls', 10), create: createBallsLayer },
    { ...overlay('hands', 20), create: createShowHandsLayer },
    { ...overlay('menu', 30), create: () => createMenuLayer(rt, menuLayers()) },
    { ...overlay('debug', 40), create: () => createDebugLayer(settings) },
    { ...overlay('live', 50), create: () => createLiveLayer(rt, settings) },
  ];
}
