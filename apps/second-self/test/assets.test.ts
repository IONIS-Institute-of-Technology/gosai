import { describe, expect, test } from 'bun:test';
import {
  AssetRegistry,
  describeProblems,
  probeAsset,
  type AssetProblem,
  type FetchLike,
} from '../src/shared/assets.js';

const LFS_POINTER = [
  'version https://git-lfs.github.com/spec/v1',
  'oid sha256:2f5bb276cdaad93fe7032b415a0000000000000000000000000000000000000',
  'size 16385760',
  '',
].join('\n');

/** A fetch whose bodies stream in small chunks, like a real one. */
function fakeFetch(bodies: Record<string, string | null>, chunkSize = 7): FetchLike {
  return async (url) => {
    const body = bodies[url];
    if (body === undefined) throw new TypeError('network error');
    if (body === null) return new Response(null, { status: 404 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(body);
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
}

describe('probeAsset', () => {
  test('accepts a real file', async () => {
    const fetchImpl = fakeFetch({ '/vrm': 'glTF\u0002\u0000\u0000\u0000 binary payload' });
    expect(await probeAsset('/vrm', fetchImpl)).toBeNull();
  });

  test('spots a Git LFS pointer split across chunks', async () => {
    const fetchImpl = fakeFetch({ '/vrm': LFS_POINTER });
    expect(await probeAsset('/vrm', fetchImpl)).toBe('lfs-pointer');
  });

  test('reports a 404 as missing', async () => {
    expect(await probeAsset('/gone', fakeFetch({ '/gone': null }))).toBe('missing');
  });

  test('reports a network failure as missing', async () => {
    expect(await probeAsset('/offline', fakeFetch({}))).toBe('missing');
  });

  test('accepts a file shorter than the pointer prefix', async () => {
    expect(await probeAsset('/tiny', fakeFetch({ '/tiny': 'hi' }))).toBeNull();
  });
});

describe('describeProblems', () => {
  test('says nothing when nothing is wrong', () => {
    expect(describeProblems([])).toEqual([]);
  });

  test('names the file and the command that fixes a pointer', () => {
    const lines = describeProblems([
      { path: 'aria/models/papa_de_him_chan.vrm', fault: 'lfs-pointer' },
    ]);
    expect(lines[0]).toContain('papa_de_him_chan.vrm');
    expect(lines[1]).toContain('git lfs pull');
  });

  test('counts the files it does not name', () => {
    const problems: AssetProblem[] = ['a.webm', 'b.webm', 'c.webm', 'd.webm'].map((path) => ({
      path,
      fault: 'lfs-pointer',
    }));
    expect(describeProblems(problems)[0]).toBe(
      'a.webm, b.webm and 2 more are Git LFS pointers, not the files.',
    );
  });

  test('a missing file reads differently from a pointer', () => {
    expect(describeProblems([{ path: 'dance/dance02.webp', fault: 'missing' }])[0]).toBe(
      'Missing dance02.webp.',
    );
  });
});

describe('AssetRegistry', () => {
  const bodies = {
    'assets/ok.webm': 'real bytes',
    'assets/broken.webm': LFS_POINTER,
    'assets/gone.webm': null,
  };
  const registry = (): { registry: AssetRegistry; reported: string[] } => {
    const reported: string[] = [];
    return {
      reported,
      registry: new AssetRegistry(
        (path) => `assets/${path}`,
        (slug) => void reported.push(slug),
        fakeFetch(bodies),
      ),
    };
  };

  test('a layer with everything in place has no problems and reports nothing', async () => {
    const { registry: assets, reported } = registry();
    await assets.require('sign-game', ['ok.webm']);
    expect(assets.problems('sign-game')).toEqual([]);
    expect(reported).toEqual([]);
  });

  test('keeps the broken assets in the order the layer declared them', async () => {
    const { registry: assets, reported } = registry();
    await assets.require('sign-game', ['gone.webm', 'ok.webm', 'broken.webm']);
    expect(assets.problems('sign-game')).toEqual([
      { path: 'gone.webm', fault: 'missing' },
      { path: 'broken.webm', fault: 'lfs-pointer' },
    ]);
    expect(reported).toEqual(['sign-game']);
  });

  test('a layer that never declared anything has no problems', () => {
    expect(registry().registry.problems('clock')).toEqual([]);
  });
});
