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
        { slug: 'menu', name: 'Menu', entry: './menu.ts' },
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

  test('parses network.connect origins', () => {
    const m = validateManifest(PATH, {
      slug: 'n',
      name: 'N',
      version: '0.1.0',
      experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
      network: { connect: ['ws://relay.local:8080', 'https://api.example.com'] },
    });
    expect(m.network).toEqual({ connect: ['ws://relay.local:8080', 'https://api.example.com'] });
  });

  test('rejects network.connect entries that are not plain origins', () => {
    for (const network of [
      { connect: 'ws://relay.local' },
      { connect: ['ws://relay.local/socket'] },
      { connect: ['ws://*.local'] },
      { connect: ["ws://a.local 'unsafe-inline'"] },
      ['ws://relay.local'],
    ]) {
      expect(() =>
        validateManifest(PATH, {
          slug: 'n',
          name: 'N',
          version: '0.1.0',
          experiences: [{ slug: 'a', name: 'A', entry: './a.ts' }],
          network,
        }),
      ).toThrow(ManifestError);
    }
  });

  describe('calibration', () => {
    const withCalibration = (calibration: unknown, extra: Record<string, unknown> = {}) =>
      validateManifest(PATH, {
        slug: 'c',
        name: 'C',
        version: '0.1.0',
        experiences: [
          { slug: 'a', name: 'A', entry: './a.ts' },
          { slug: 'setup', name: 'Setup', entry: './setup.ts' },
        ],
        calibration,
        ...extra,
      });

    test('parses a built-in kind with its options', () => {
      const m = withCalibration({
        kind: 'camera-projector-surface',
        required: true,
        options: {
          surfaceSize: { width: 1920, height: 1080 },
          cornerLabels: ['A', 'B', 'C', 'D'],
          stepCopy: { 'surface-corners': { title: 'Corners' } },
          projectorMessages: { compute: 'computing' },
        },
      });
      expect(m.calibration).toEqual({
        kind: 'camera-projector-surface',
        required: true,
        options: {
          surfaceSize: { width: 1920, height: 1080 },
          cornerLabels: ['A', 'B', 'C', 'D'],
          stepCopy: { 'surface-corners': { title: 'Corners' } },
          projectorMessages: { compute: 'computing' },
        },
      });
    });

    test('`required` defaults to false', () => {
      expect(withCalibration({ kind: 'camera-projector-surface' }).calibration).toEqual({
        kind: 'camera-projector-surface',
        required: false,
      });
    });

    test("checks a built-in kind's options", () => {
      expect(() =>
        withCalibration({ kind: 'camera-projector-surface', options: { cornerLabels: ['A'] } }),
      ).toThrow(/calibration\.options\.cornerLabels/);
      expect(() =>
        withCalibration({ kind: 'camera-projector-surface', options: { stepCopy: { x: {} } } }),
      ).toThrow(/calibration\.options\.stepCopy/);
    });

    test('a custom kind needs an experience of the app, and keeps its options as they are', () => {
      expect(() => withCalibration({ kind: 'acme-depth-grid' })).toThrow(/calibration\.experience/);
      expect(() => withCalibration({ kind: 'acme-depth-grid', experience: 'missing' })).toThrow(
        /"missing" does not match any experience slug/,
      );
      const m = withCalibration({
        kind: 'acme-depth-grid',
        experience: 'setup',
        options: { anything: [1, 2] },
      });
      expect(m.calibration).toEqual({
        kind: 'acme-depth-grid',
        required: false,
        experience: 'setup',
        options: { anything: [1, 2] },
      });
      // A built-in kind can run a custom flow too.
      expect(
        withCalibration({ kind: 'camera-projector-surface', experience: 'setup' }).calibration
          ?.experience,
      ).toBe('setup');
    });

    test('rejects the old entry-module shape and bad kinds', () => {
      expect(() => withCalibration({ required: true, entry: 'dist/calibration.js' })).toThrow(
        ManifestError,
      );
      expect(() => withCalibration({ required: false })).toThrow(ManifestError);
      expect(() => withCalibration({ kind: 'Camera Surface' })).toThrow(ManifestError);
      expect(() => withCalibration({ kind: 'camera-projector-surface', required: 'yes' })).toThrow(
        ManifestError,
      );
    });
  });

  const base = {
    slug: 'app',
    name: 'App',
    version: '1.0.0',
    experiences: [{ slug: 'main', name: 'Main', entry: 'dist/main.js' }],
  };
  const errorOf = (value: unknown): string => {
    try {
      validateManifest(PATH, value);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected the manifest to be rejected');
  };

  test('accepts $schema and leaves it out of the parsed manifest', () => {
    const m = validateManifest(PATH, { $schema: '../schema.json', ...base });
    expect(m).not.toHaveProperty('$schema');
  });

  test('ignores builtin and unknown top-level fields with a warning', () => {
    const warnings: string[] = [];
    const m = validateManifest(PATH, { ...base, builtin: false, homepage: 'https://x' }, (w) =>
      warnings.push(w),
    );
    expect(m).not.toHaveProperty('builtin');
    expect(m).not.toHaveProperty('homepage');
    expect(warnings).toEqual([
      '`builtin` is ignored; it comes from where the app is installed',
      'unknown field `homepage` is ignored',
    ]);
    // Inside an experience an unknown field is still a mistake.
    expect(errorOf({ ...base, experiences: [{ ...base.experiences[0], extra: 1 }] })).toContain(
      'extra',
    );
  });

  test('checks experience references', () => {
    const experiences = [
      { slug: 'main', name: 'Main', entry: 'dist/main.js', required: ['setup'] },
      { slug: 'setup', name: 'Setup', entry: 'dist/setup.js' },
    ];
    expect(validateManifest(PATH, { ...base, experiences, startup: ['main'] }).startup).toEqual([
      'main',
    ]);
    expect(errorOf({ ...base, startup: ['missing'] })).toContain('startup.0');
    expect(
      errorOf({
        ...base,
        experiences: [{ ...experiences[0], required: ['nope'] }, experiences[1]],
      }),
    ).toContain('"nope" does not match');
    expect(
      errorOf({
        ...base,
        experiences: [
          { slug: 'a', name: 'A', entry: 'a.js', required: ['b'] },
          { slug: 'b', name: 'B', entry: 'b.js', required: ['a'] },
        ],
      }),
    ).toContain('a -> b -> a');
    expect(errorOf({ ...base, experiences: [base.experiences[0], base.experiences[0]] })).toContain(
      'duplicate experience slug',
    );
  });

  test('rejects wrong types instead of dropping or coercing them', () => {
    expect(
      errorOf({ ...base, experiences: [{ ...base.experiences[0], exclusive: 'yes' }] }),
    ).toContain('exclusive');
    expect(
      errorOf({ ...base, experiences: [{ ...base.experiences[0], drivers: ['camera', 3] }] }),
    ).toContain('drivers.1');
    const select = (options: unknown, def?: unknown): unknown => ({
      ...base,
      settings: {
        groups: [
          {
            label: 'G',
            fields: [{ key: 'mode', label: 'Mode', type: 'select', options, default: def }],
          },
        ],
      },
    });
    expect(errorOf(select([{ value: 1, label: 'One' }]))).toContain('value');
    expect(errorOf(select([{ value: 'a', label: 'A' }], 'b'))).toContain('not one of the options');
    expect(errorOf({ ...base, settings: { storageKey: '../x', groups: [] } })).toContain(
      'storageKey',
    );
  });

  test('checks icons and entries stay inside the app', () => {
    expect(validateManifest(PATH, { ...base, icon: 'assets/icon.png', author: 'Me' }).icon).toBe(
      'assets/icon.png',
    );
    expect(errorOf({ ...base, icon: '../outside.png' })).toContain('icon');
    expect(
      errorOf({ ...base, experiences: [{ ...base.experiences[0], entry: '/etc/passwd' }] }),
    ).toContain('entry');
  });

  test('rejects the reserved system slug', () => {
    expect(errorOf({ ...base, slug: 'system' })).toContain('reserved');
  });

  test('accepts requestable capabilities only', () => {
    expect(validateManifest(PATH, { ...base, capabilities: ['logs:read'] }).capabilities).toEqual([
      'logs:read',
    ]);
    expect(errorOf({ ...base, capabilities: ['apps:manage'] })).toContain('only the dashboard');
    expect(errorOf({ ...base, capabilities: ['fly'] })).toContain('unknown capability');
  });
});
