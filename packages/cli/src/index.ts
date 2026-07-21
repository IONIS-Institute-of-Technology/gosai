#!/usr/bin/env bun
/**
 * GOSAI CLI.
 *
 * `gosai kiosk <app-dir>` launches a built app as an isolated kiosk: its own
 * data directory, its own embedded server on an ephemeral port, one
 * fullscreen window, no dashboard. Run it several times with different apps
 * to host several kiosks on one machine - no port coordination needed.
 *
 * The command wraps the GOSAI desktop shell:
 * - `GOSAI_DESKTOP_BIN` points at a packaged GOSAI executable, e.g.
 *   /Applications/GOSAI.app/Contents/MacOS/GOSAI.
 * - Otherwise the repo-local Electron + built desktop bundle is used
 *   (`bun run build:desktop` and `bun run build:sdk` first).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface KioskArgs {
  appDir: string;
  home?: string;
  display?: string;
  experience?: string;
  pythonExtras?: string;
  windowed: boolean;
  calibrate: boolean;
}

function usage(): never {
  console.log(`GOSAI CLI

Usage:
  gosai kiosk <app-dir> [options]

Options:
  --home <dir>          Data directory for this kiosk
                        (default: ~/.gosai-kiosks/<app-slug>)
  --display <index>     Display to open on (0-based index, default: primary)
  --experience <slug>   Experience to run (default: the app's default)
  --python-extras <l>   Comma-separated Python extras (e.g. speech,realsense)
  --calibrate           Force the calibration wizard before the app starts
  --windowed            Open in a window instead of fullscreen kiosk
  -h, --help            Show this help

Environment:
  GOSAI_DESKTOP_BIN     Path to a packaged GOSAI executable to use as runtime
`);
  process.exit(1);
}

function parseKioskArgs(argv: string[]): KioskArgs {
  const positional: string[] = [];
  const args: KioskArgs = { appDir: '', windowed: false, calibrate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--home':
        args.home = argv[++i];
        break;
      case '--display':
        args.display = argv[++i];
        break;
      case '--experience':
        args.experience = argv[++i];
        break;
      case '--python-extras':
        args.pythonExtras = argv[++i];
        break;
      case '--windowed':
        args.windowed = true;
        break;
      case '--calibrate':
        args.calibrate = true;
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}\n`);
          usage();
        }
        positional.push(arg);
    }
  }
  const appDir = positional[0];
  if (!appDir) {
    console.error('Missing <app-dir>\n');
    usage();
  }
  args.appDir = resolve(appDir);
  return args;
}

interface Launcher {
  bin: string;
  args: string[];
}

function resolveLauncher(): Launcher {
  const packaged = process.env.GOSAI_DESKTOP_BIN;
  if (packaged) {
    if (!existsSync(packaged)) {
      console.error(`GOSAI_DESKTOP_BIN does not exist: ${packaged}`);
      process.exit(1);
    }
    return { bin: packaged, args: [] };
  }

  const repoRoot = resolve(import.meta.dir, '..', '..', '..');
  const desktopMain = join(repoRoot, 'packages', 'desktop', 'out', 'main', 'index.js');
  if (!existsSync(desktopMain)) {
    console.error(
      'Desktop bundle not built. Run `bun run build:desktop && bun run build:sdk` first,\n' +
        'or point GOSAI_DESKTOP_BIN at a packaged GOSAI executable.',
    );
    process.exit(1);
  }
  const electronBin = join(repoRoot, 'node_modules', '.bin', 'electron');
  if (!existsSync(electronBin)) {
    console.error(`Electron not found at ${electronBin}. Run \`bun install\` first.`);
    process.exit(1);
  }
  return { bin: electronBin, args: [desktopMain] };
}

function runKiosk(argv: string[]): void {
  const args = parseKioskArgs(argv);

  const manifestPath = join(args.appDir, 'gosai.app.json');
  if (!existsSync(manifestPath)) {
    console.error(`Not a GOSAI app: ${manifestPath} not found`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    slug: string;
    name?: string;
  };

  const launcher = resolveLauncher();
  const childArgs = [...launcher.args, '--kiosk', args.appDir];
  if (args.display !== undefined) childArgs.push('--kiosk-display', args.display);
  if (args.experience) childArgs.push('--kiosk-experience', args.experience);
  if (args.pythonExtras) childArgs.push('--kiosk-python-extras', args.pythonExtras);
  if (args.windowed) childArgs.push('--kiosk-windowed');
  if (args.calibrate) childArgs.push('--kiosk-calibrate');

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.home) env.GOSAI_HOME = resolve(args.home);

  console.log(`[gosai] launching kiosk: ${manifest.name ?? manifest.slug} (${args.appDir})`);
  const child = spawn(launcher.bin, childArgs, { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal));
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'kiosk':
    runKiosk(rest);
    break;
  default:
    usage();
}
