/**
 * App manager. Owns the catalogue of installed apps and the set of running
 * experiences. Coordinates with the DriverManager so experiences get the
 * drivers they declared. Designed so app crashes never bring down the server:
 * lifecycle errors are caught, surfaced as state transitions, and logged.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppManifest,
  AppState,
  ExperienceDescriptor,
  ExperienceState,
  InstalledApp,
  RunningExperience,
} from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger, Logger } from '../logger/index.js';
import type { GosaiPaths } from '../paths.js';
import { DriverManager } from '../drivers/index.js';
import { discoverApps, type DiscoveredApp, ManifestError } from './manifest.js';
import { installApp, linkBuiltinApp, uninstallApp } from './installer.js';

export interface AppManagerOptions {
  readonly paths: GosaiPaths;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly drivers: DriverManager;
  readonly builtinAppsDir?: string;
}

export class AppManager {
  private readonly log: ChildLogger;
  private readonly catalogue = new Map<string, InstalledAppRecord>();
  private readonly running = new Map<string, RunningExperience>();

  constructor(private readonly options: AppManagerOptions) {
    this.log = options.logger.child('apps');
    this.discover();
  }

  discover(): void {
    this.catalogue.clear();
    const builtinDir = this.options.builtinAppsDir;
    if (builtinDir && builtinDir.length > 0) {
      this.discoverBuiltin(builtinDir);
    }
    for (const found of discoverApps(this.options.paths.apps)) {
      this.ingest(found, found.installPath, /* builtin */ false);
    }
    this.broadcastList();
  }

  listApps(): InstalledApp[] {
    return Array.from(this.catalogue.values()).map((r) => r.toPublic());
  }

  listRunningExperiences(): RunningExperience[] {
    return Array.from(this.running.values());
  }

  getApp(slug: string): InstalledApp | undefined {
    return this.catalogue.get(slug)?.toPublic();
  }

  async installFromGit(source: string): Promise<InstalledApp> {
    const result = await installApp({
      source,
      logger: this.log,
      paths: this.options.paths,
    });
    this.ingest(result.app, result.app.installPath, false);
    const record = this.catalogue.get(result.app.manifest.slug);
    if (!record) {
      throw new Error('Install succeeded but app not catalogued');
    }
    this.options.bus.emit(ServerEvents.AppInstalled, record.toPublic(), 'apps');
    this.broadcastList();
    return record.toPublic();
  }

  async uninstall(slug: string): Promise<void> {
    const record = this.catalogue.get(slug);
    if (!record) throw new Error(`App ${slug} not installed`);
    if (record.builtin) throw new Error(`Cannot uninstall built-in app ${slug}`);
    await this.stopAllExperiencesFor(slug);
    await uninstallApp(slug, this.options.paths);
    this.catalogue.delete(slug);
    this.options.bus.emit(ServerEvents.AppUninstalled, { slug }, 'apps');
    this.broadcastList();
  }

  async startExperience(appSlug: string, experienceSlug: string): Promise<RunningExperience> {
    const record = this.requireApp(appSlug);
    const exp = record.getExperience(experienceSlug);

    if (exp.exclusive) {
      const allowed = new Set([exp.slug, ...(exp.allowed ?? [])]);
      await this.stopExclusiveConflicts(appSlug, allowed);
    }
    if (exp.required && exp.required.length > 0) {
      for (const reqSlug of exp.required) {
        if (!this.running.has(experienceKey(appSlug, reqSlug))) {
          await this.startExperience(appSlug, reqSlug);
        }
      }
    }

    const key = experienceKey(appSlug, experienceSlug);
    const existing = this.running.get(key);
    if (existing && existing.state === 'running') return existing;

    const entry: RunningExperience = {
      appSlug,
      experienceSlug,
      state: 'starting',
      startedAt: Date.now(),
    };
    this.running.set(key, entry);
    this.broadcastExperienceState(entry);

    try {
      for (const driverName of exp.drivers) {
        await this.options.drivers.subscribe(appSlug, driverName, '*', key);
      }
      const running: RunningExperience = { ...entry, state: 'running' };
      this.running.set(key, running);
      this.broadcastExperienceState(running);
      record.updateState('running');
      this.broadcastList();
      this.log.info('experience started', { app: appSlug, experience: experienceSlug });
      return running;
    } catch (err) {
      const failed: RunningExperience = { ...entry, state: 'crashed' };
      this.running.set(key, failed);
      this.broadcastExperienceState(failed);
      record.updateState('crashed');
      this.broadcastList();
      this.log.error('failed to start experience', {
        app: appSlug,
        experience: experienceSlug,
        err: String(err),
      });
      throw err;
    }
  }

  async stopExperience(appSlug: string, experienceSlug: string): Promise<void> {
    const key = experienceKey(appSlug, experienceSlug);
    const current = this.running.get(key);
    if (!current) return;
    const stopping: RunningExperience = { ...current, state: 'stopping' };
    this.running.set(key, stopping);
    this.broadcastExperienceState(stopping);

    const record = this.catalogue.get(appSlug);
    const drivers = record?.getExperience(experienceSlug).drivers ?? [];
    for (const driverName of drivers) {
      try {
        await this.options.drivers.unsubscribe(appSlug, driverName, '*', key);
      } catch (err) {
        this.log.warn('driver unsubscribe failed', { driver: driverName, err: String(err) });
      }
    }
    this.running.delete(key);
    const idleEntry: RunningExperience = { ...current, state: 'idle' };
    this.broadcastExperienceState(idleEntry);
    if (record && !this.hasRunningExperienceFor(appSlug)) {
      record.updateState('installed');
      this.broadcastList();
    }
    this.log.info('experience stopped', { app: appSlug, experience: experienceSlug });
  }

  async shutdown(): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const key of this.running.keys()) {
      const [appSlug, experienceSlug] = key.split('::');
      if (appSlug && experienceSlug) {
        stops.push(this.stopExperience(appSlug, experienceSlug).catch(() => undefined));
      }
    }
    await Promise.all(stops);
  }

  private discoverBuiltin(builtinDir: string): void {
    if (!existsSync(builtinDir)) return;
    for (const entry of readdirSync(builtinDir)) {
      const dir = join(builtinDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const discovered = linkBuiltinApp(dir, this.options.paths);
        this.ingest(discovered, dir, true);
      } catch (err) {
        if (err instanceof ManifestError) {
          this.log.warn('built-in app manifest invalid', { path: dir, err: err.message });
        }
      }
    }
  }

  private ingest(found: DiscoveredApp, installPath: string, builtin: boolean): void {
    const manifest: AppManifest = { ...found.manifest, builtin };
    const record = new InstalledAppRecord({
      manifest,
      installPath,
      installedAt: this.recordedInstallTime(installPath),
      source: builtin ? 'builtin' : 'git',
      builtin,
    });
    this.catalogue.set(manifest.slug, record);
    this.ensureAppDirs(manifest.slug);
  }

  private ensureAppDirs(slug: string): void {
    const base = join(this.options.paths.apps, slug);
    mkdirSync(join(base, '_data'), { recursive: true });
    mkdirSync(join(base, '_config'), { recursive: true });
  }

  private async stopExclusiveConflicts(appSlug: string, allowed: Set<string>): Promise<void> {
    const toStop: Array<[string, string]> = [];
    for (const [key, running] of this.running.entries()) {
      if (running.appSlug !== appSlug) continue;
      if (!allowed.has(running.experienceSlug)) {
        toStop.push([running.appSlug, running.experienceSlug]);
        void key;
      }
    }
    for (const [a, e] of toStop) {
      await this.stopExperience(a, e);
    }
  }

  private async stopAllExperiencesFor(appSlug: string): Promise<void> {
    const toStop: string[] = [];
    for (const [key, running] of this.running.entries()) {
      if (running.appSlug === appSlug) {
        toStop.push(key);
      }
    }
    for (const key of toStop) {
      const [a, e] = key.split('::');
      if (a && e) {
        await this.stopExperience(a, e);
      }
    }
  }

  private hasRunningExperienceFor(appSlug: string): boolean {
    for (const running of this.running.values()) {
      if (running.appSlug === appSlug) return true;
    }
    return false;
  }

  private broadcastList(): void {
    this.options.bus.emit(ServerEvents.AppsListChanged, { apps: this.listApps() }, 'apps');
  }

  private broadcastExperienceState(state: RunningExperience): void {
    this.options.bus.emit(ServerEvents.ExperienceStateChanged, state, 'apps');
    this.options.bus.emit(
      ServerEvents.ExperiencesListChanged,
      { experiences: this.listRunningExperiences() },
      'apps',
    );
  }

  private requireApp(slug: string): InstalledAppRecord {
    const record = this.catalogue.get(slug);
    if (!record) throw new Error(`App not installed: ${slug}`);
    return record;
  }

  private recordedInstallTime(installPath: string): number {
    try {
      return Math.floor(statSync(installPath).mtimeMs);
    } catch {
      return Date.now();
    }
  }
}

interface InstalledAppRecordOptions {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly installedAt: number;
  readonly source: string;
  readonly builtin: boolean;
}

class InstalledAppRecord {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly installedAt: number;
  readonly source: string;
  readonly builtin: boolean;
  private state: AppState = 'installed';

  constructor(options: InstalledAppRecordOptions) {
    this.manifest = options.manifest;
    this.installPath = options.installPath;
    this.installedAt = options.installedAt;
    this.source = options.source;
    this.builtin = options.builtin;
  }

  updateState(state: AppState): void {
    this.state = state;
  }

  toPublic(): InstalledApp {
    return {
      manifest: this.manifest,
      installPath: this.installPath,
      installedAt: this.installedAt,
      source: this.source,
      state: this.state,
    };
  }

  getExperience(slug: string): ExperienceDescriptor {
    const exp = this.manifest.experiences.find((e) => e.slug === slug);
    if (!exp) throw new Error(`Experience ${slug} not found in ${this.manifest.slug}`);
    return exp;
  }
}

function experienceKey(appSlug: string, experienceSlug: string): string {
  return `${appSlug}::${experienceSlug}`;
}

// Re-export for tests that need it.
export type ExperienceLifecycleState = ExperienceState;
