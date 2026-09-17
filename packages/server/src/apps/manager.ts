/**
 * App manager. Owns the catalogue of installed apps and the set of running
 * experiences. Coordinates with the DriverManager so experiences get the
 * drivers they declared. Designed so app crashes never bring down the server:
 * lifecycle errors are caught, surfaced as state transitions, and logged.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppManifest,
  AppState,
  ExperienceDescriptor,
  InstalledApp,
  InvalidApp,
  RunningExperience,
} from '@gosai/shared';
import type { Capability } from '@gosai/shared/capabilities';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger, Logger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import type { DriverManager } from '../drivers/manager.js';
import {
  discoverApps,
  type DiscoveredApp,
  type InvalidApp as DiscoveredInvalidApp,
} from './manifest.js';
import { installApp, uninstallApp } from './installer.js';
import { gitOrigin, InstallRecords } from './install-records.js';

export interface AppManagerOptions {
  readonly paths: GosaiPaths;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly drivers: Pick<DriverManager, 'subscribe' | 'unsubscribe'>;
  readonly builtinAppsDir?: string;
  /** Let installs clone `file:` URLs. Only for tests. */
  readonly allowFileInstalls?: boolean;
}

export interface InstallOptions {
  /** Requested capabilities the operator approved. Others stay ungranted. */
  readonly capabilities?: readonly Capability[];
  /**
   * Keep data left by an earlier app with this slug even when it was installed
   * from another source, or the source is unknown.
   */
  readonly reuseData?: boolean;
}

/** Thrown when an install would inherit another app's data. */
export class AppDataConflictError extends Error {
  readonly details = { reason: 'app-data-conflict' } as const;

  constructor(message: string) {
    super(message);
    this.name = 'AppDataConflictError';
  }
}

export interface StartExperienceOptions {
  readonly driverBinding?: string;
}

interface AppRecord {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly installedAt: number;
  readonly builtin: boolean;
  state: AppState;
}

interface InvalidAppRecord extends DiscoveredInvalidApp {
  readonly builtin: boolean;
}

interface ExperienceRecord extends RunningExperience {
  readonly driverBinding: string;
}

export class AppManager {
  private readonly log: ChildLogger;
  private readonly catalogue = new Map<string, AppRecord>();
  private readonly running = new Map<string, ExperienceRecord>();
  private readonly records: InstallRecords;
  private readonly invalid = new Map<string, InvalidAppRecord>();

  constructor(private readonly options: AppManagerOptions) {
    this.log = options.logger.child('apps');
    this.records = new InstallRecords(options.paths, this.log);
    this.removeLeftoverStaging();
    this.discover();
  }

  discover(): void {
    this.catalogue.clear();
    this.invalid.clear();
    if (this.options.builtinAppsDir) {
      const builtin = discoverApps(this.options.builtinAppsDir, this.log);
      for (const found of builtin.apps) this.ingest(found, true);
      for (const app of builtin.invalid) this.invalid.set(app.slug, { ...app, builtin: true });
    }
    // An installed app replaces a built-in one with the same slug.
    const installed = discoverApps(this.options.paths.apps, this.log);
    for (const found of installed.apps) {
      this.ingest(found, false);
      this.invalid.delete(found.manifest.slug);
      this.recordLegacyInstall(found);
    }
    for (const app of installed.invalid) {
      if (!this.catalogue.has(app.slug)) this.invalid.set(app.slug, { ...app, builtin: false });
    }
    this.broadcastList();
  }

  /** App directories whose manifest doesn't parse, with the error. */
  listInvalidApps(): InvalidApp[] {
    return Array.from(this.invalid.values(), ({ slug, builtin, error }) => ({
      slug,
      builtin,
      error,
    }));
  }

  listApps(): InstalledApp[] {
    return Array.from(this.catalogue.values(), (record) => this.toPublicApp(record));
  }

  listRunningExperiences(): RunningExperience[] {
    return Array.from(this.running.values(), toPublicExperience);
  }

  getApp(slug: string): InstalledApp | undefined {
    const record = this.catalogue.get(slug);
    return record && this.toPublicApp(record);
  }

  getManifest(slug: string): AppManifest | undefined {
    return this.catalogue.get(slug)?.manifest;
  }

  /** Filesystem location of an app, for serving its static files. Never sent to clients. */
  getInstallPath(slug: string): string | undefined {
    return this.catalogue.get(slug)?.installPath;
  }

  /**
   * Capabilities an app's tokens hold beyond the defaults: the manifest's
   * requests for built-in apps, and the approved requests for installed ones.
   */
  grantedCapabilities(slug: string): readonly Capability[] {
    const record = this.catalogue.get(slug);
    if (!record) return [];
    const requested = record.manifest.capabilities ?? [];
    if (record.builtin) return requested;
    const approved = new Set(this.records.get(slug)?.approvedCapabilities ?? []);
    return requested.filter((capability) => approved.has(capability));
  }

  /** Records which of an installed app's requested capabilities the operator approved. */
  approveCapabilities(slug: string, capabilities: readonly Capability[]): InstalledApp {
    const record = this.requireApp(slug);
    if (record.builtin) throw new Error(`Built-in app ${slug} holds its requested capabilities`);
    const current = this.records.get(slug);
    this.records.set(slug, {
      source: current?.source ?? gitOrigin(record.installPath) ?? '',
      installedAt: current?.installedAt ?? record.installedAt,
      approvedCapabilities: approvedSubset(record.manifest, capabilities),
    });
    this.log.info('approved app capabilities', { app: slug, capabilities: [...capabilities] });
    this.broadcastList();
    return this.toPublicApp(record);
  }

  async installFromGit(source: string, options: InstallOptions = {}): Promise<InstalledApp> {
    const trimmed = source.trim();
    const result = await installApp({
      source: trimmed,
      logger: this.log,
      paths: this.options.paths,
      allowFileSources: this.options.allowFileInstalls === true,
      checkManifest: (manifest) => {
        if (!options.reuseData) this.checkLeftoverData(manifest.slug, trimmed);
      },
    });
    const slug = result.app.manifest.slug;
    this.records.set(slug, {
      source: trimmed,
      installedAt: Date.now(),
      approvedCapabilities: approvedSubset(result.app.manifest, options.capabilities ?? []),
    });
    const installed = this.toPublicApp(this.ingest(result.app, false));
    this.options.bus.emit(ServerEvents.AppInstalled, installed, 'apps');
    this.broadcastList();
    return installed;
  }

  /** Refuses data left by an app from another, or an unknown, source. */
  private checkLeftoverData(slug: string, source: string): void {
    const dataDir = appDataDir(this.options.paths, slug);
    if (!existsSync(dataDir)) return;
    const previous = this.records.get(slug)?.source;
    if (previous === source) return;
    const origin = previous ? `installed from ${previous}` : 'from an unknown source';
    throw new AppDataConflictError(
      `Data for ${slug} ${origin} already exists at ${dataDir}. Reuse it explicitly, or delete it first.`,
    );
  }

  /**
   * Removes the app's checkout. Its data stays unless `deleteData` is set.
   * Works on an app whose manifest no longer parses too.
   */
  async uninstall(slug: string, options: { deleteData?: boolean } = {}): Promise<boolean> {
    const record = this.catalogue.get(slug);
    const invalid = this.invalid.get(slug);
    if (!record && invalid && !invalid.builtin) {
      await uninstallApp(slug, this.options.paths);
      this.invalid.delete(slug);
      return this.finishUninstall(slug, options);
    }
    if (!record) throw new Error(`App ${slug} not installed`);
    if (record.builtin) throw new Error(`Cannot uninstall built-in app ${slug}`);
    await this.stopAllExperiencesFor(slug);
    await uninstallApp(slug, this.options.paths);
    this.catalogue.delete(slug);
    return this.finishUninstall(slug, options);
  }

  private finishUninstall(slug: string, options: { deleteData?: boolean }): boolean {
    const dataDir = appDataDir(this.options.paths, slug);
    if (options.deleteData) {
      rmSync(dataDir, { recursive: true, force: true });
      this.log.info('uninstalled app and deleted its data', { app: slug });
    } else if (existsSync(dataDir)) {
      this.log.info('uninstalled app; its data was kept', { app: slug, dataDir });
    }
    this.options.bus.emit(ServerEvents.AppUninstalled, { slug }, 'apps');
    this.broadcastList();
    return options.deleteData === true;
  }

  /**
   * Starts an experience and, first, the experiences it requires, all with
   * the same driver binding. When any of them fails, the ones this call
   * started are stopped again.
   */
  async startExperience(
    appSlug: string,
    experienceSlug: string,
    options: StartExperienceOptions = {},
  ): Promise<RunningExperience> {
    const record = this.requireApp(appSlug);
    const driverBinding = options.driverBinding ?? appSlug;
    const started: ExperienceDescriptor[] = [];
    try {
      const running = await this.startWithRequirements(
        record,
        requireExperience(record, experienceSlug),
        driverBinding,
        started,
        [],
      );
      return toPublicExperience(running);
    } catch (err) {
      for (const experience of started.reverse()) {
        await this.stopExperience(appSlug, experience.slug).catch((stopErr: unknown) =>
          this.log.warn('could not roll back a required experience', {
            app: appSlug,
            experience: experience.slug,
            err: String(stopErr),
          }),
        );
      }
      throw err;
    }
  }

  private async startWithRequirements(
    record: AppRecord,
    experience: ExperienceDescriptor,
    driverBinding: string,
    started: ExperienceDescriptor[],
    path: readonly string[],
  ): Promise<ExperienceRecord> {
    const appSlug = record.manifest.slug;
    if (path.includes(experience.slug)) {
      throw new Error(`Experiences require each other: ${[...path, experience.slug].join(' -> ')}`);
    }
    if (experience.exclusive) {
      const keep = new Set([
        experience.slug,
        ...(experience.allowed ?? []),
        ...(experience.required ?? []),
        ...path,
      ]);
      await this.stopExclusiveConflicts(appSlug, keep);
    }
    for (const requiredSlug of experience.required ?? []) {
      const current = this.running.get(experienceKey(appSlug, requiredSlug));
      if (current?.state === 'running' && current.driverBinding === driverBinding) continue;
      const required = requireExperience(record, requiredSlug);
      await this.startWithRequirements(record, required, driverBinding, started, [
        ...path,
        experience.slug,
      ]);
    }
    const existing = this.running.get(experienceKey(appSlug, experience.slug));
    if (existing?.state === 'running' && existing.driverBinding === driverBinding) return existing;
    if (existing) await this.stopExperience(appSlug, experience.slug);

    const running = await this.startOne(record, experience, driverBinding);
    started.push(experience);
    return running;
  }

  private async startOne(
    record: AppRecord,
    experience: ExperienceDescriptor,
    driverBinding: string,
  ): Promise<ExperienceRecord> {
    const appSlug = record.manifest.slug;
    const key = experienceKey(appSlug, experience.slug);
    const starting: ExperienceRecord = {
      appSlug,
      experienceSlug: experience.slug,
      state: 'starting',
      startedAt: Date.now(),
      driverBinding,
    };
    this.running.set(key, starting);
    this.broadcastExperience(starting);

    const subscribed: string[] = [];
    try {
      for (const driver of experience.drivers) {
        await this.options.drivers.subscribe(driverBinding, driver, '*', key);
        subscribed.push(driver);
      }
    } catch (err) {
      await this.releaseDrivers(driverBinding, subscribed, key);
      this.running.delete(key);
      record.state = 'crashed';
      this.broadcastExperience({ ...starting, state: 'crashed' });
      this.broadcastList();
      this.log.error('failed to start experience', {
        app: appSlug,
        experience: experience.slug,
        err: String(err),
      });
      throw err;
    }

    const running: ExperienceRecord = { ...starting, state: 'running' };
    this.running.set(key, running);
    record.state = 'running';
    this.broadcastExperience(running);
    this.broadcastList();
    this.log.info('experience started', {
      app: appSlug,
      experience: experience.slug,
      driverBinding,
    });
    return running;
  }

  async stopExperience(appSlug: string, experienceSlug: string): Promise<void> {
    const key = experienceKey(appSlug, experienceSlug);
    const current = this.running.get(key);
    if (!current) return;
    this.running.set(key, { ...current, state: 'stopping' });
    this.broadcastExperience({ ...current, state: 'stopping' });

    const record = this.catalogue.get(appSlug);
    const drivers = record?.manifest.experiences.find((e) => e.slug === experienceSlug)?.drivers;
    await this.releaseDrivers(current.driverBinding, drivers ?? [], key);
    this.running.delete(key);
    this.broadcastExperience({ ...current, state: 'idle' });
    // A crash stays visible until the next successful start.
    if (record && record.state !== 'crashed' && !this.hasRunningExperienceFor(appSlug)) {
      record.state = 'installed';
      this.broadcastList();
    }
    this.log.info('experience stopped', { app: appSlug, experience: experienceSlug });
  }

  /**
   * Starts the `startup` experiences (or the default one) of every listed
   * app. Failures are logged; the others still start.
   */
  async autoStart(appSlugs: readonly string[]): Promise<void> {
    for (const appSlug of appSlugs) {
      const manifest = this.getManifest(appSlug);
      if (!manifest) {
        this.log.warn('auto-start app is not installed', { app: appSlug });
        continue;
      }
      const slugs = manifest.startup ?? [manifest.default ?? manifest.experiences[0]!.slug];
      for (const experienceSlug of slugs) {
        try {
          await this.startExperience(appSlug, experienceSlug);
        } catch (err) {
          this.log.error('auto-start failed', {
            app: appSlug,
            experience: experienceSlug,
            err: String(err),
          });
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.running.values(), (running) =>
        this.stopExperience(running.appSlug, running.experienceSlug).catch((err: unknown) =>
          this.log.warn('experience stop failed during shutdown', {
            app: running.appSlug,
            experience: running.experienceSlug,
            err: String(err),
          }),
        ),
      ),
    );
  }

  private async releaseDrivers(
    driverBinding: string,
    drivers: readonly string[],
    subscriber: string,
  ): Promise<void> {
    for (const driver of drivers) {
      try {
        await this.options.drivers.unsubscribe(driverBinding, driver, '*', subscriber);
      } catch (err) {
        this.log.warn('driver unsubscribe failed', { driver, err: String(err) });
      }
    }
  }

  /** Installs interrupted by a crash or restart leave clones in `.staging`. */
  private removeLeftoverStaging(): void {
    const staging = join(this.options.paths.apps, '.staging');
    if (!existsSync(staging)) return;
    try {
      rmSync(staging, { recursive: true, force: true });
      this.log.info('removed leftover install staging directory');
    } catch (err) {
      this.log.warn('could not remove install staging directory', { err: String(err) });
    }
  }

  private toPublicApp(record: AppRecord): InstalledApp {
    return {
      manifest: record.manifest,
      installedAt: record.installedAt,
      source: record.builtin ? 'builtin' : 'git',
      builtin: record.builtin,
      grantedCapabilities: this.grantedCapabilities(record.manifest.slug),
      state: record.state,
    };
  }

  /**
   * Git apps installed before install records existed get one from their
   * checkout's origin, so a later install from elsewhere can't inherit their data.
   */
  private recordLegacyInstall(found: DiscoveredApp): void {
    const slug = found.manifest.slug;
    if (this.records.get(slug) || !existsSync(join(found.installPath, '.git'))) return;
    const source = gitOrigin(found.installPath);
    if (!source) return;
    this.records.set(slug, {
      source,
      installedAt: installTime(found.installPath),
      approvedCapabilities: [],
    });
  }

  private ingest(found: DiscoveredApp, builtin: boolean): AppRecord {
    const record: AppRecord = {
      manifest: found.manifest,
      installPath: found.installPath,
      installedAt: installTime(found.installPath),
      builtin,
      state: 'installed',
    };
    this.catalogue.set(found.manifest.slug, record);
    return record;
  }

  private async stopExclusiveConflicts(appSlug: string, keep: ReadonlySet<string>): Promise<void> {
    const conflicts = Array.from(this.running.values()).filter(
      (running) => running.appSlug === appSlug && !keep.has(running.experienceSlug),
    );
    for (const running of conflicts) {
      await this.stopExperience(running.appSlug, running.experienceSlug);
    }
  }

  private async stopAllExperiencesFor(appSlug: string): Promise<void> {
    const owned = Array.from(this.running.values()).filter((r) => r.appSlug === appSlug);
    for (const running of owned) {
      await this.stopExperience(running.appSlug, running.experienceSlug);
    }
  }

  private hasRunningExperienceFor(appSlug: string): boolean {
    for (const running of this.running.values()) {
      if (running.appSlug === appSlug) return true;
    }
    return false;
  }

  private broadcastList(): void {
    this.options.bus.emit(
      ServerEvents.AppsListChanged,
      { apps: this.listApps(), invalid: this.listInvalidApps() },
      'apps',
    );
  }

  private broadcastExperience(state: ExperienceRecord): void {
    this.options.bus.emit(ServerEvents.ExperienceStateChanged, toPublicExperience(state), 'apps');
    this.options.bus.emit(
      ServerEvents.ExperiencesListChanged,
      { experiences: this.listRunningExperiences() },
      'apps',
    );
  }

  private requireApp(slug: string): AppRecord {
    const record = this.catalogue.get(slug);
    if (!record) throw new Error(`App not installed: ${slug}`);
    return record;
  }
}

function requireExperience(record: AppRecord, slug: string): ExperienceDescriptor {
  const experience = record.manifest.experiences.find((e) => e.slug === slug);
  if (!experience) throw new Error(`Experience ${slug} not found in ${record.manifest.slug}`);
  return experience;
}

function experienceKey(appSlug: string, experienceSlug: string): string {
  return `${appSlug}::${experienceSlug}`;
}

function installTime(installPath: string): number {
  try {
    return Math.floor(statSync(installPath).mtimeMs);
  } catch {
    return Date.now();
  }
}

function toPublicExperience(record: RunningExperience): RunningExperience {
  return {
    appSlug: record.appSlug,
    experienceSlug: record.experienceSlug,
    state: record.state,
    startedAt: record.startedAt,
  };
}

/** The approved capabilities the manifest actually requests. */
function approvedSubset(
  manifest: AppManifest,
  approved: readonly Capability[],
): readonly Capability[] {
  const allowed = new Set(approved);
  return (manifest.capabilities ?? []).filter((capability) => allowed.has(capability));
}
