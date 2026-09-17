import { describe, expect, test } from 'bun:test';
import { LayerManager, type ExperienceRuntimeContext } from '@gosai/sdk';
import { poolLayerDefinitions } from '../src/pool-layers.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import type { PoolFrame, PoolLayerDefinition } from '../src/shared/types.js';

function manager(): LayerManager<PoolFrame, PoolLayerDefinition> {
  const rt = {} as ExperienceRuntimeContext;
  const layers: LayerManager<PoolFrame, PoolLayerDefinition> = new LayerManager(
    poolLayerDefinitions(
      rt,
      () => DEFAULT_SETTINGS,
      () => layers,
    ),
    {
      onError: (slug, err) => {
        throw new Error(`${slug}: ${String(err)}`);
      },
    },
  );
  return layers;
}

describe('pool layers', () => {
  test('the menu lists the scenes in order', () => {
    const labels = manager()
      .definitions()
      .flatMap((def) => (def.menu ? [def.menu.label] : []));
    expect(labels).toEqual(['Rabbits\nGame', 'Affine', 'Triangles', 'Univers', 'Ambient\nDisplay']);
  });

  test('starting a scene stops the running one and keeps the overlays', async () => {
    const layers = manager();
    await Promise.all([layers.start('balls'), layers.start('debug')]);
    await layers.start('rabbits_game');
    await layers.toggle('univers');
    expect(layers.running()).toEqual(['univers', 'balls', 'debug']);

    await layers.toggle('univers');
    expect(layers.running()).toEqual(['balls', 'debug']);

    await layers.stopAll();
    expect(layers.running()).toEqual([]);
  });
});
