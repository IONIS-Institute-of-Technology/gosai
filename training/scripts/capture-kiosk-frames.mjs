#!/usr/bin/env node

/**
 * Capture training frames from a running GOSAI kiosk without reopening its
 * camera device.
 *
 * The script discovers the kiosk's private GOSAI server port over SSH, opens a
 * local SSH tunnel, and calls camera.snapshot on the interactive-pool binding.
 * Snapshots copy the camera driver's latest in-memory frame, so ball inference
 * and projector rendering continue normally.
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_OUTPUT = resolve(REPO_ROOT, 'training/models/ball/data/custom/images');
const DEFAULT_SERVER_INFO = '/home/kiosk/.gosai-kiosks/interactive-pool/server-info.json';

function usage() {
  console.log(`Capture projector-on training frames from the running pool kiosk.

Usage:
  node training/scripts/capture-kiosk-frames.mjs [options]

Options:
  --ssh USER@HOST       SSH target (or set GOSAI_KIOSK_SSH)
  --duration SECONDS    Capture duration (default: 60)
  --fps FPS             Snapshot rate, max 10 (default: 5)
  --output DIRECTORY    JPEG destination (default: ball custom/images)
  --prefix NAME         Filename prefix (default: projector-<timestamp>)
  --binding NAME        GOSAI driver binding (default: interactive-pool)
  --server-info PATH    Remote server-info.json path
  --help                Show this message

Example:
  GOSAI_KIOSK_SSH=i2t@pool-kiosk \\
    node training/scripts/capture-kiosk-frames.mjs --duration 120 --fps 5 \\
    --prefix rabbits-skulls
`);
}

function parseArgs(argv) {
  const options = {
    ssh: process.env.GOSAI_KIOSK_SSH,
    duration: 60,
    fps: 5,
    output: DEFAULT_OUTPUT,
    prefix: `projector-${new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/g, '')
      .slice(0, 14)}`,
    binding: 'interactive-pool',
    serverInfo: DEFAULT_SERVER_INFO,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${arg}`);
    }
    index += 1;
    switch (arg) {
      case '--ssh':
        options.ssh = value;
        break;
      case '--duration':
        options.duration = Number(value);
        break;
      case '--fps':
        options.fps = Number(value);
        break;
      case '--output':
        options.output = resolve(value);
        break;
      case '--prefix':
        options.prefix = value;
        break;
      case '--binding':
        options.binding = value;
        break;
      case '--server-info':
        options.serverInfo = value;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    throw new Error('--duration must be positive');
  }
  if (!Number.isFinite(options.fps) || options.fps <= 0 || options.fps > 10) {
    throw new Error('--fps must be between 0 and 10');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.prefix)) {
    throw new Error('--prefix may contain only letters, numbers, underscores, and hyphens');
  }
  if (!options.ssh) {
    throw new Error('provide --ssh USER@HOST or set GOSAI_KIOSK_SSH');
  }
  return options;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function discoverRemotePort(options) {
  const raw = execFileSync(
    'ssh',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      options.ssh,
      `sudo -n cat -- ${shellQuote(options.serverInfo)}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const info = JSON.parse(raw);
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65_535) {
    throw new Error(`invalid kiosk server port in ${options.serverInfo}`);
  }
  return info.port;
}

async function reserveLocalPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error('failed to allocate a local port'));
        else resolvePort(port);
      });
    });
  });
}

async function waitForTunnel(port, tunnel, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (tunnel.exitCode !== null) {
      throw new Error(`SSH tunnel exited with code ${tunnel.exitCode}`);
    }
    const connected = await new Promise((resolveConnection) => {
      const socket = new Socket();
      socket.setTimeout(250);
      socket.once('connect', () => {
        socket.destroy();
        resolveConnection(true);
      });
      const fail = () => {
        socket.destroy();
        resolveConnection(false);
      };
      socket.once('timeout', fail);
      socket.once('error', fail);
      socket.connect(port, '127.0.0.1');
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error('timed out waiting for the SSH tunnel');
}

class GosaiConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', () => reject(new Error('GOSAI WebSocket failed')), {
        once: true,
      });
      socket.addEventListener('message', (event) => this.onMessage(event));
      socket.addEventListener('close', () => {
        for (const { reject: rejectRequest } of this.pending.values()) {
          rejectRequest(new Error('GOSAI WebSocket closed'));
        }
        this.pending.clear();
      });
    });
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.type !== 'response') return;
    const requestId = message.payload?.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (message.payload.ok) pending.resolve(message.payload.data);
    else pending.reject(new Error(message.payload.error?.message ?? 'GOSAI request failed'));
  }

  request(type, payload, timeoutMs = 10_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('GOSAI WebSocket is not open'));
    }
    const id = `capture-${this.nextId}`;
    this.nextId += 1;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectRequest(error);
        },
      });
      this.socket.send(JSON.stringify({ v: 1, id, type, payload }));
    });
  }

  close() {
    this.socket?.close();
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const remotePort = discoverRemotePort(options);
  const localPort = await reserveLocalPort();
  const tunnel = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${localPort}:127.0.0.1:${remotePort}`,
      options.ssh,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const connection = new GosaiConnection(`ws://127.0.0.1:${localPort}/ws`);
  let cameraSubscribed = false;
  try {
    await waitForTunnel(localPort, tunnel);
    await connection.open();
    await connection.request('driver:subscribe', {
      binding: options.binding,
      driver: 'camera',
      event: 'color',
    });
    cameraSubscribed = true;
    // Allow the camera loop to replace any stale preview cache before the
    // first snapshot is requested.
    await delay(Math.max(100, 1000 / options.fps));
    await mkdir(options.output, { recursive: true });

    const metadataPath = resolve(options.output, `${options.prefix}.jsonl`);
    await writeFile(metadataPath, '', { flag: 'wx' }).catch((error) => {
      if (error && typeof error === 'object' && error.code === 'EEXIST') {
        throw new Error(`capture prefix already exists: ${options.prefix}`);
      }
      throw error;
    });
    const intervalMs = 1000 / options.fps;
    const captureSlots = Math.max(1, Math.floor(options.duration * options.fps));
    const captureStartedAt = performance.now();
    let saved = 0;
    let lastCaptureTimestamp = null;

    console.log(
      `Capturing ${options.binding} camera at ${options.fps} fps for ${options.duration}s`,
    );
    console.log(`Destination: ${options.output}`);
    console.log('Press Ctrl-C to stop early.');

    for (let slot = 0; !stopping && slot < captureSlots; slot += 1) {
      const waitMs = captureStartedAt + slot * intervalMs - performance.now();
      if (waitMs > 0) await delay(waitMs);

      const snapshot = await connection.request('driver:execute', {
        binding: options.binding,
        driver: 'camera',
        action: 'snapshot',
      });
      if (!snapshot || typeof snapshot.jpeg_base64 !== 'string') {
        throw new Error('camera.snapshot returned no JPEG');
      }
      if (snapshot.capture_ts === lastCaptureTimestamp) continue;
      lastCaptureTimestamp = snapshot.capture_ts;

      const filename = `${options.prefix}_${String(saved).padStart(6, '0')}.jpg`;
      await writeFile(
        resolve(options.output, filename),
        Buffer.from(snapshot.jpeg_base64, 'base64'),
      );
      await appendFile(
        metadataPath,
        `${JSON.stringify({
          file: filename,
          capture_ts: snapshot.capture_ts,
          width: snapshot.width,
          height: snapshot.height,
          codec: snapshot.codec,
        })}\n`,
      );
      saved += 1;
      if (saved % Math.max(1, Math.round(options.fps * 5)) === 0) {
        console.log(`Saved ${saved} frames`);
      }
    }

    console.log(`Done: saved ${saved} frames`);
    console.log(`Metadata: ${metadataPath}`);
  } finally {
    if (cameraSubscribed) {
      await connection
        .request('driver:unsubscribe', {
          binding: options.binding,
          driver: 'camera',
          event: 'color',
        })
        .catch(() => undefined);
    }
    connection.close();
    tunnel.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
