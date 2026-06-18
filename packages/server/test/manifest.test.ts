import { describe, expect, test } from 'bun:test';
import { validateManifest, ManifestError } from '../src/apps/manifest.js';

const PATH = '/tmp/test/gosai.app.json';

describe('validateManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const m = validateManifest(PATH, {
      slug: 'hello',
      name: 'Hello',
      version: '0.1.0',
      experiences: [{ slug: 'main', name: 'Main', entry: './main.ts' }],
    });
    expect(m.slug).toBe('hello');
    expect(m.experiences).toHaveLength(1);
    expect(m.experiences[0]?.slug).toBe('main');
    expect(m.experiences[0]?.exclusive).toBe(false);
    expect(m.experiences[0]?.drivers).toEqual([]);
  });

  test('rejects invalid slug', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'NotKebab',
        name: 'Bad',
        version: '0.1.0',
        experiences: [{ slug: 'main', name: 'Main', entry: './x' }],
      }),
    ).toThrow(ManifestError);
  });

  test('rejects missing required fields', () => {
    expect(() => validateManifest(PATH, { slug: 'a' })).toThrow(ManifestError);
  });

  test('parses a settings schema', () => {
    const m = validateManifest(PATH, {
      slug: 'x',
      name: 'X',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      settings: {
        storageKey: 'config',
        groups: [
          {
            label: 'Projection',
            fields: [
              {
                key: 'projection.mode',
                label: 'Mode',
                type: 'select',
                default: 'direct',
                options: [
                  { value: 'direct', label: 'Direct' },
                  { value: 'reflection', label: 'Reflection' },
                ],
              },
              {
                key: 'projection.zoom',
                label: 'Zoom',
                type: 'number',
                default: 1,
                min: 0.1,
                step: 0.1,
              },
            ],
          },
        ],
      },
    });
    expect(m.settings?.storageKey).toBe('config');
    expect(m.settings?.groups).toHaveLength(1);
    expect(m.settings?.groups[0]?.fields[0]?.options).toHaveLength(2);
    expect(m.settings?.groups[0]?.fields[1]?.min).toBe(0.1);
  });

  test('rejects an invalid settings field type', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'x',
        name: 'X',
        version: '0.1.0',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
        settings: { groups: [{ label: 'G', fields: [{ key: 'k', label: 'K', type: 'color' }] }] },
      }),
    ).toThrow(ManifestError);
  });

  test('parses python config', () => {
    const m = validateManifest(PATH, {
      slug: 'x',
      name: 'X',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      python: { requirements: './requirements.txt' },
    });
    expect(m.python?.requirements).toBe('./requirements.txt');
  });

  test('accepts a manifest with a default experience matching an existing slug', () => {
    const m = validateManifest(PATH, {
      slug: 'd',
      name: 'D',
      version: '0.1.0',
      default: 'a',
      experiences: [
        { slug: 'a', name: 'A', entry: './a.ts' },
        { slug: 'b', name: 'B', entry: './b.ts' },
      ],
    });
    expect(m.default).toBe('a');
  });

  test('rejects a manifest with a default that does not match an experience slug', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'd',
        name: 'D',
        version: '0.1.0',
        default: 'missing',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      }),
    ).toThrow(ManifestError);
  });

  test('omits the default field when not provided', () => {
    const m = validateManifest(PATH, {
      slug: 'd',
      name: 'D',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
    });
    expect(m.default).toBeUndefined();
  });

  test('preserves driver list on experiences', () => {
    const m = validateManifest(PATH, {
      slug: 'y',
      name: 'Y',
      version: '0.1.0',
      experiences: [
        {
          slug: 'a',
          name: 'A',
          entry: './a.ts',
          drivers: ['camera', 'hand_pose'],
          exclusive: true,
          allowed: ['menu'],
        },
      ],
    });
    expect(m.experiences[0]?.drivers).toEqual(['camera', 'hand_pose']);
    expect(m.experiences[0]?.exclusive).toBe(true);
    expect(m.experiences[0]?.allowed).toEqual(['menu']);
  });

  test('parses app-level device requirements', () => {
    const m = validateManifest(PATH, {
      slug: 'r',
      name: 'R',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      requirements: { display: true, camera: true, microphone: false },
    });
    expect(m.requirements).toEqual({ display: true, camera: true, microphone: false });
  });

  test('omits requirements when not provided', () => {
    const m = validateManifest(PATH, {
      slug: 'r',
      name: 'R',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
    });
    expect(m.requirements).toBeUndefined();
  });

  test('rejects non-boolean requirement flags', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'r',
        name: 'R',
        version: '0.1.0',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
        requirements: { camera: 'yes' },
      }),
    ).toThrow(ManifestError);
  });

  test('rejects a non-object requirements field', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'r',
        name: 'R',
        version: '0.1.0',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
        requirements: ['camera'],
      }),
    ).toThrow(ManifestError);
  });

  test('parses required calibration metadata', () => {
    const m = validateManifest(PATH, {
      slug: 'c',
      name: 'C',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      calibration: {
        required: true,
        entry: 'dist/calibration.js',
        statusKey: 'calibration_status',
      },
    });
    expect(m.calibration).toEqual({
      required: true,
      entry: 'dist/calibration.js',
      statusKey: 'calibration_status',
    });
  });

  test('parses calibration disabled without an entry', () => {
    const m = validateManifest(PATH, {
      slug: 'c',
      name: 'C',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      calibration: { required: false },
    });
    expect(m.calibration).toEqual({ required: false });
  });

  test('rejects required calibration without an entry', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'c',
        name: 'C',
        version: '0.1.0',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
        calibration: { required: true },
      }),
    ).toThrow(ManifestError);
  });

  test('rejects calibration without a boolean required flag', () => {
    expect(() =>
      validateManifest(PATH, {
        slug: 'c',
        name: 'C',
        version: '0.1.0',
        experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
        calibration: { entry: 'dist/calibration.js' },
      }),
    ).toThrow(ManifestError);
  });
});
