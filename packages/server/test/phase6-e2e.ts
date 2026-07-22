/**
 * Phase 6 end-to-end:
 * - Boots server with the workspace Python dir.
 * - Pulls the driver list from /v1/drivers.
 * - Verifies every Phase 6 driver is discovered with the expected events,
 *   actions, and dependencies.
 *
 * Hardware-dependent drivers (camera, microphone, speaker, ...) are NOT
 * started in this test - we just check the manifest because not every CI
 * machine has a camera or audio device.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';

const PORT = 17_786;
const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');

const tmp = mkdtempSync(join(tmpdir(), 'gosai-phase6-'));
const paths = {
  root: tmp,
  apps: ensure(join(tmp, 'apps')),
  logs: ensure(join(tmp, 'logs')),
  data: ensure(join(tmp, 'data')),
  config: ensure(join(tmp, 'config')),
};

function ensure(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface DriverEntry {
  name: string;
  events: string[];
  actions: string[];
  dependencies: string[];
}

const EXPECTED: Record<
  string,
  {
    events: string[];
    actions: string[];
    dependencies: string[];
  }
> = {
  heartbeat: {
    events: ['tick'],
    actions: ['echo'],
    dependencies: [],
  },
  camera: {
    events: ['frame', 'color', 'depth', 'frame_size', 'fps'],
    actions: ['set_device', 'set_mode', 'set_resolution', 'set_fps', 'snapshot', 'list_formats'],
    dependencies: [],
  },
  calibration: {
    events: ['detection', 'homography', 'status'],
    actions: ['set_marker_layout', 'set_camera_event', 'compute', 'clear', 'render_marker'],
    dependencies: ['camera'],
  },
  interpolate: {
    events: ['interpolated_data'],
    actions: ['interpolate_points', 'reset'],
    dependencies: [],
  },
  microphone: {
    events: ['audio_stream', 'settings'],
    actions: ['list_devices', 'set_device', 'set_samplerate'],
    dependencies: [],
  },
  speaker: {
    events: ['settings', 'underrun'],
    actions: ['play', 'clear', 'list_devices', 'set_device', 'set_samplerate'],
    dependencies: [],
  },
  frequency_analysis: {
    events: ['frequency'],
    actions: ['set_max_frequency', 'set_window_size'],
    dependencies: ['microphone'],
  },
  hand_pose: {
    events: ['raw_data'],
    actions: ['set_flip', 'set_window'],
    dependencies: ['camera'],
  },
  pose: {
    events: ['raw_data'],
    actions: ['set_flip', 'set_window'],
    dependencies: ['camera'],
  },
  hand_sign: {
    events: ['sign'],
    actions: [],
    dependencies: ['hand_pose'],
  },
  ball: {
    events: ['balls', 'fps'],
    actions: [
      'set_homography',
      'set_output_size',
      'set_confidence',
      'set_max_ball_px',
      'set_min_ball_px',
      'set_frame_skip',
      'set_cuda_device',
    ],
    dependencies: ['camera'],
  },
  speech_activity_detection: {
    events: ['activity'],
    actions: ['predict'],
    dependencies: ['microphone'],
  },
  speech_to_text: {
    events: ['transcription'],
    actions: ['transcribe', 'set_model'],
    dependencies: [],
  },
};

const server = await createServer({
  host: '127.0.0.1',
  port: PORT,
  paths,
  pythonDir: join(REPO_ROOT, 'python'),
  builtinAppsDir: join(REPO_ROOT, 'apps'),
  enablePython: true,
});

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/drivers`);
  if (!res.ok) throw new Error(`/v1/drivers -> ${res.status}`);
  const data = (await res.json()) as { drivers: DriverEntry[] };
  const byName = new Map(data.drivers.map((d) => [d.name, d]));

  const issues: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const got = byName.get(name);
    if (!got) {
      issues.push(`missing driver: ${name}`);
      continue;
    }
    for (const event of expected.events) {
      if (!got.events.includes(event)) {
        issues.push(`${name} missing event ${event}; has ${JSON.stringify(got.events)}`);
      }
    }
    for (const action of expected.actions) {
      if (!got.actions.includes(action)) {
        issues.push(`${name} missing action ${action}; has ${JSON.stringify(got.actions)}`);
      }
    }
    for (const dep of expected.dependencies) {
      if (!got.dependencies.includes(dep)) {
        issues.push(`${name} missing dependency ${dep}; has ${JSON.stringify(got.dependencies)}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`phase 6 driver manifest issues:\n - ${issues.join('\n - ')}`);
  }

  console.log(
    '[phase6] all',
    Object.keys(EXPECTED).length,
    'drivers discovered with expected events/actions/dependencies',
  );
} finally {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
}
