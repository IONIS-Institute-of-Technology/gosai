import { describe, expect, test } from 'bun:test';
import {
  driverReference,
  driverTypesModule,
  readDriverSchemas,
  type DriverDescription,
} from '../cli/driver-types.js';
import { DriverClientImpl } from '../src/driver-client.js';
import type { DriverClient } from '../src/types.js';
import { FakeServer } from './fakes.js';

const SENSOR: DriverDescription = {
  name: 'sensor',
  description: 'A test sensor.',
  schema: {
    config: { $ref: '#/$defs/SensorConfig' },
    events: {
      reading: {
        description: 'The latest reading.',
        delivery: 'latest',
        payload: { $ref: '#/$defs/Reading' },
      },
      raw: { description: '', delivery: 'ordered', payload: {} },
    },
    actions: {
      calibrate: {
        description: 'Calibrate against points.',
        params: {
          type: 'array',
          items: {
            type: 'array',
            prefixItems: [{ type: 'number' }, { type: 'string' }],
            items: false,
          },
        },
        result: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/Reading' }] },
        requires_instance: true,
      },
      reset: { description: 'Forget state.', params: null, result: true },
    },
    $defs: {
      SensorConfig: {
        type: 'object',
        properties: { rate: { type: 'integer', default: 30, description: 'Hz.' } },
        required: [],
      },
      Reading: {
        title: 'Reading',
        description: 'One reading.\n    Values are in volts.',
        type: 'object',
        properties: {
          value: { type: 'number' },
          unit: { enum: ['V', 'mV'] },
          'odd-key': { anyOf: [{ type: 'string' }, { type: 'null' }] },
          tags: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['value', 'unit', 'odd-key'],
      },
    },
  },
};

describe('reading schemas', () => {
  test('accepts the Python dump and the drivers:schema reply, sorted by name', () => {
    const fromDump = readDriverSchemas({
      drivers: [
        { name: 'zeta', description: 'Z', dependencies: ['camera'], shared: true, schema: null },
        { name: 'alpha', schema: SENSOR.schema },
      ],
    });
    expect(fromDump.map((d) => d.name)).toEqual(['alpha', 'zeta']);
    expect(fromDump[1]).toEqual({
      name: 'zeta',
      description: 'Z',
      dependencies: ['camera'],
      shared: true,
      schema: null,
    });

    const fromServer = readDriverSchemas({
      schemas: { sensor: { schemaVersion: 'abc', schema: SENSOR.schema }, bare: { schema: null } },
    });
    expect(fromServer.map((d) => [d.name, d.schema === null])).toEqual([
      ['bare', true],
      ['sensor', false],
    ]);
  });

  test('rejects other shapes and invalid driver names', () => {
    expect(() => readDriverSchemas([])).toThrow();
    expect(() => readDriverSchemas({ drivers: [{ name: 'Bad-Name', schema: null }] })).toThrow(
      'driver name',
    );
    expect(() => readDriverSchemas({ drivers: [{ name: 'x', schema: { events: {} } }] })).toThrow(
      'actions',
    );
  });
});

describe('generating types', () => {
  test('writes a namespace per driver and the registry entries', () => {
    const text = driverTypesModule([SENSOR], { kind: 'builtin' });
    expect(text).toContain('export declare namespace DriverTypes {');
    expect(text).toContain('  export namespace sensor {');
    expect(text).toContain(
      [
        '    /**',
        '     * One reading.',
        '     * Values are in volts.',
        '     */',
        '    export interface Reading {',
        '      value: number;',
        "      unit: 'V' | 'mV';".replace(/'/g, '"'),
        '      "odd-key": string | null;',
        '      tags?: { [key: string]: string };',
        '    }',
      ].join('\n'),
    );
    expect(text).toContain(
      '      /**\n       * Hz.\n       * @default 30\n       */\n      rate?: number;',
    );
    expect(text).toContain('export interface BuiltinDrivers {');
    expect(text).toContain('    config: DriverTypes.sensor.SensorConfig;');
    expect(text).toContain('      reading: DriverTypes.sensor.Reading;');
    expect(text).toContain('      raw: unknown;');
    expect(text).toContain('        params: [number, string][];');
    expect(text).toContain('        result: null | DriverTypes.sensor.Reading;');
    expect(text).toContain('      reset: {\n        params: undefined;\n        result: unknown;');
  });

  test('augments a module for app drivers and keeps drivers without a schema untyped', () => {
    const text = driverTypesModule([SENSOR, { name: 'delete', schema: null }], {
      kind: 'augment',
      module: '@gosai/sdk',
      namespace: 'MyDrivers',
    });
    expect(text).toContain("import type {} from '@gosai/sdk';".replace(/'/g, '"'));
    expect(text).toContain('export declare namespace MyDrivers {');
    expect(text).toContain('  export namespace delete_ {');
    expect(text).toContain('declare module "@gosai/sdk" {\n  interface DriverRegistry {');
    expect(text).toContain('      reading: MyDrivers.sensor.Reading;');
    expect(text).toContain('    delete: {\n      config: unknown;');
  });

  test('refuses unsupported references and namespace names', () => {
    const external: DriverDescription = {
      name: 'x',
      schema: {
        config: null,
        events: { e: { payload: { $ref: 'other.json#/Thing' } } },
        actions: {},
      },
    };
    expect(() => driverTypesModule([external], { kind: 'builtin' })).toThrow('$defs');
    expect(() =>
      driverTypesModule([SENSOR], { kind: 'augment', module: 'm', namespace: 'class' }),
    ).toThrow('namespace');
  });

  test('types app drivers under their qualified names', () => {
    const drivers = readDriverSchemas({
      drivers: [{ name: 'hello-app/sensor', schema: SENSOR.schema }],
    });
    const text = driverTypesModule(drivers, {
      kind: 'augment',
      module: '@gosai/sdk',
      namespace: 'AppDriverTypes',
    });
    expect(text).toContain('  export namespace sensor {');
    expect(text).toContain('    "hello-app/sensor": {');
    expect(text).toContain('        reading: AppDriverTypes.sensor.Reading;');
    expect(driverReference(drivers)).toContain('- [`hello-app/sensor`](#hello-appsensor)');

    const clash = readDriverSchemas({
      drivers: [
        { name: 'sensor', schema: null },
        { name: 'hello-app/sensor', schema: null },
      ],
    });
    expect(() => driverTypesModule(clash, { kind: 'builtin' })).toThrow('--drivers');
    expect(() =>
      readDriverSchemas({ drivers: [{ name: 'hello-app/sensor/x', schema: null }] }),
    ).toThrow('driver name');
  });

  test('writes a Markdown reference', () => {
    const text = driverReference([SENSOR]);
    expect(text).toContain('- [`sensor`](#sensor): A test sensor.');
    expect(text).toContain('| `reading` | `Reading` | latest | The latest reading. |');
    expect(text).toContain(
      '| `calibrate` | `[number, string][]` | `null \\| Reading` | Calibrate against points. |',
    );
    expect(text).toContain('| `reset` | none | `unknown` | Forget state. |');
    expect(text).toContain('```ts\nexport interface SensorConfig {');
  });
});

describe('typed driver client', () => {
  const drivers: DriverClient = new DriverClientImpl(new FakeServer().connection, 'demo');

  test('types built-in payloads, params and results, and leaves other drivers unknown', () => {
    // Type-level checks; the calls are never made.
    const check = (): void => {
      drivers.on('heartbeat', 'tick', (data) => {
        const count: number = data.count;
        void count;
      });
      drivers.on('camera', '*', (data) => {
        // Any camera event: a frame, a color frame, the frame size or the rate.
        const rate: number | undefined = 'fps' in data ? data.fps : undefined;
        void rate;
      });
      // @ts-expect-error: pose has no such event
      drivers.on('pose', 'no_such_event', () => undefined);
      drivers.on('my_driver', 'anything', (data) => {
        // @ts-expect-error: unknown drivers have unknown data
        void data.value;
      });

      const pending = drivers.execute('calibration', 'render_marker', { id: 3 });
      void pending.then((marker) => marker.png_base64.length);
      void drivers.execute('pose', 'set_window', 0.5);
      void drivers.execute('ball', 'set_homography', [1, 0, 0, 0, 1, 0, 0, 0, 1] as const);
      void drivers.execute('camera', 'snapshot');
      void drivers.execute('camera', 'set_mode');
      // An action with nothing to report resolves with null.
      const cleared: Promise<null> = drivers.execute('calibration', 'clear');
      void cleared;
      // @ts-expect-error: set_fps needs a number
      void drivers.execute('camera', 'set_fps');
      // @ts-expect-error: snapshot takes no params
      void drivers.execute('camera', 'snapshot', {});
      void drivers.execute('my_driver', 'go', { any: 'thing' });

      // The deprecated casts still compile. An explicit type argument can't
      // infer the driver name, so they accept any driver, marked deprecated.
      const cast: Promise<{ ok: boolean }> = drivers.execute<{ ok: boolean }>('my_driver', 'go', 1);
      const castValue: Promise<number> = drivers.get<number>('my_driver', 'level');
      void cast;
      void castValue;
      // Without a type argument a known driver never falls back to the cast.
      // @ts-expect-error: pose has no set_flipp action
      void drivers.execute('pose', 'set_flipp', true);
      // @ts-expect-error: heartbeat has no such event
      void drivers.get('heartbeat', 'tock');
      void drivers.get('pose', 'raw_data').then((data) => data?.body_pose.length);
    };
    expect(typeof check).toBe('function');
  });

  test('sends params and returns null before the first event', async () => {
    const server = new FakeServer();
    server.reply = (type) => (type === 'driver:get-data' ? undefined : { ok: true });
    const client = new DriverClientImpl(server.connection, 'demo');
    expect(await client.get('heartbeat', 'tick')).toBeNull();
    await client.execute('pose', 'set_flip', true);
    await client.execute('camera', 'snapshot');
    expect(server.requestsOf('driver:execute').map((r) => r.payload)).toEqual([
      { driver: 'pose', action: 'set_flip', data: true, binding: 'demo' },
      { driver: 'camera', action: 'snapshot', data: undefined, binding: 'demo' },
    ]);
  });
});
