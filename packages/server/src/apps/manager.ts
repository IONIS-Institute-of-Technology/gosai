/**
 * App manager. Owns the catalogue of installed apps and the set of running
 * experiences. Coordinates with the drivers so experiences get the drivers
 * they declared, and tells them which apps ship drivers of their own. Designed so app crashes never bring down the server:
 * lifecycle errors are caught, surfaced as state transitions, and logged.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AppManifest,
  AppState,
  ExperienceCrash,
  ExperienceDescriptor,
  InstalledApp,
  InvalidApp,
  ExperienceStart,
  RunningExperience,
} from '@gosai/shared';
import type { Capability } from '@gosai/shared/capabilities';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger, Logger } from '../logger/logger.js';
import { appDataDir, type GosaiPaths } from '../paths.js';
import {
  appDriverSourceKey,
  type AppDriverHosts,
  type AppDriverSource,
  type DriverService,
} from '../drivers/hub.js';
import {
  discoverApps,
  type DiscoveredApp,
  type InvalidApp as DiscoveredInvalidApp,
} from './manifest.js';
import { installApp, uninstallApp } from './installer.js';
import type { PythonToolchain } from './python-env.js';
import { gitOrigin, InstallRecords } from './install-records.js';
import { SDK_VERSION } from './sdk-version.js';

export interface AppManagerOptions {
  readonly paths: GosaiPaths;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly drivers: Pick<DriverService, 'subscribe' | 'unsubscribe'>;
  /** Runs the drivers apps ship. Kept in step with the catalogue. */
  readonly appDrivers?: AppDriverHosts;
  /** Builds the Python environment of apps that ship drivers, at install. */
  readonly python?: PythonToolchain;
  readonly builtinAppsDir?: string;
  /** Let installs clone `file:` URLs. Only for tests. */
  readonly allowFileInstalls?: boolean;
  /** SDK version app `sdk` ranges are checked against. Defaults to the one the server serves. */
  readonly sdkVersion?: string;
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

export interface StopExperienceOptions {
  /** Why the experience stopped on its own. It is then reported `crashed`. */
  readonly error?: string;
}

interface AppRecord {
  readonly manifest: AppManifest;
  readonly installPath: string;
  readonly installedAt: number;
  readonly builtin: boolean;
  state: AppState;
  /** Set while `state` is `crashed`. */
  crash: ExperienceCrash | null;
}

interface InvalidAppRecord extends DiscoveredInvalidApp {
  readonly builtin: boolean;
}

interface ExperienceRecord extends RunningExperience {
  readonly driverBinding: string;
  /** The drivers the experience holds leases on. */
  readonly drivers: readonly string[];
}

export class AppManager {
  private readonly log: ChildLogger;
  private readonly catalogue = new Map<string, AppRecord>();
  private readonly running = new Map<string, ExperienceRecord>();
  private readonly records: InstallRecords;
  private readonly invalid = new Map<string, InvalidAppRecord>();
  /** What the app driver hosts were last told to run, by app slug. */
  private readonly syncedDrivers = new Map<string, string>();
  /** Installed apps being uninstalled, whose drivers must not start again. */
  private readonly uninstalling = new Set<string>();
  /** Changes to app driver hosts, one at a time. */
  private driversQueue: Promise<void> = Promise.resolve();

  private get sdkVersion(): string {
    return this.options.sdkVersion ?? SDK_VERSION;
  }

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
      const builtin = discoverApps(this.options.builtinAppsDir, this.log, this.sdkVersion);
      for (const found of builtin.apps) this.ingest(found, true);
      for (const app of builtin.invalid) this.invalid.set(app.slug, { ...app, builtin: true });
    }
    // An installed app replaces a built-in one with the same slug.
    const installed = discoverApps(this.options.paths.apps, this.log, this.sdkVersion);
    for (const found of installed.apps) {
      this.ingest(found, false);
      this.invalid.delete(found.manifest.slug);
      this.recordLegacyInstall(found);
    }
    // An invalid installed app stays listed, so it can be uninstalled, even
    // when a built-in app with the same slug keeps running in its place.
    for (const app of installed.invalid) this.invalid.set(app.slug, { ...app, builtin: false });
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
      sdkVersion: this.sdkVersion,
      ...(this.options.python ? { python: this.options.python } : {}),
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
    // Replacing a built-in app with the same slug replaces its drivers too.
    await this.driversQueue;
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
   * Works on an app whose manifest no longer parses too, and on an installed
   * app that shadows a built-in one; the built-in app takes its place again.
   */
  async uninstall(slug: string, options: { deleteData?: boolean } = {}): Promise<boolean> {
    const record = this.catalogue.get(slug);
    const installedPath = join(this.options.paths.apps, slug);
    if (record && !record.builtin) {
      await this.stopAllExperiencesFor(slug);
      // Its drivers stay released while its files go, even if the catalogue is synced meanwhile.
      this.uninstalling.add(slug);
      try {
        await this.queueDriverChange(() => this.releaseAppDrivers(slug));
        await uninstallApp(slug, this.options.paths);
        this.catalogue.delete(slug);
        this.invalid.delete(slug);
        this.restoreBuiltin(slug);
      } finally {
        this.uninstalling.delete(slug);
        void this.syncAppDrivers();
      }
      return this.finishUninstall(slug, options);
    }
    const installedCheckout = existsSync(installedPath) && record?.installPath !== installedPath;
    if (!installedCheckout) {
      throw new Error(
        record ? `Cannot uninstall built-in app ${slug}` : `App ${slug} not installed`,
      );
    }
    // An installed directory that didn't load, next to a running built-in app
    // or on its own.
    await uninstallApp(slug, this.options.paths);
    this.invalid.delete(slug);
    if (!record) this.restoreBuiltin(slug);
    return this.finishUninstall(slug, options);
  }

  /** Lists the built-in app with this slug again, after an installed one that shadowed it left. */
  private restoreBuiltin(slug: string): void {
    if (!this.options.builtinAppsDir) return;
    const builtin = discoverApps(this.options.builtinAppsDir, this.log, this.sdkVersion);
    const found = builtin.apps.find((app) => app.manifest.slug === slug);
    if (found) this.ingest(found, true);
    const invalid = builtin.invalid.find((app) => app.slug === slug);
    if (invalid) this.invalid.set(slug, { ...invalid, builtin: true });
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
    // Only the experience a client asked for counts as requested. One that
    // ran as a requirement becomes requested when a client asks for it.
    const startedAs: ExperienceStart = path.length === 0 ? 'request' : 'requirement';
    const key = experienceKey(appSlug, experience.slug);
    const existing = this.running.get(key);
    if (existing?.state === 'running' && existing.driverBinding === driverBinding) {
      if (startedAs === 'request' && existing.startedAs === 'requirement') {
        const promoted: ExperienceRecord = { ...existing, startedAs };
        this.running.set(key, promoted);
        this.broadcastExperience(promoted);
        return promoted;
      }
      return existing;
    }
    if (existing) await this.stopExperience(appSlug, experience.slug);

    const running = await this.startOne(record, experience, driverBinding, startedAs);
    started.push(experience);
    return running;
  }

  private async startOne(
    record: AppRecord,
    experience: ExperienceDescriptor,
    driverBinding: string,
    startedAs: ExperienceStart,
  ): Promise<ExperienceRecord> {
    const appSlug = record.manifest.slug;
    const key = experienceKey(appSlug, experience.slug);
    const starting: ExperienceRecord = {
      appSlug,
      experienceSlug: experience.slug,
      state: 'starting',
      startedAt: Date.now(),
      startedAs,
      driverBinding,
      drivers: experience.drivers,
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
      const error = err instanceof Error ? err.message : String(err);
      await this.releaseDrivers(driverBinding, subscribed, key);
      this.running.delete(key);
      this.log.error('failed to start experience', {
        app: appSlug,
        experience: experience.slug,
        err: error,
      });
      this.crashed(record, { ...starting, state: 'crashed', error });
      throw err;
    }

    const running: ExperienceRecord = { ...starting, state: 'running' };
    this.running.set(key, running);
    record.state = 'running';
    record.crash = null;
    this.broadcastExperience(running);
    this.broadcastList();
    this.log.info('experience started', {
      app: appSlug,
      experience: experience.slug,
      driverBinding,
    });
    return running;
  }

  /**
   * Stops an experience and releases its drivers. With an `error`, from a
   * window whose experience stopped on its own, it ends `crashed`.
   */
  async stopExperience(
    appSlug: string,
    experienceSlug: string,
    options: StopExperienceOptions = {},
  ): Promise<void> {
    const key = experienceKey(appSlug, experienceSlug);
    const current = this.running.get(key);
    if (!current) return;
    const { error } = options;
    if (error !== undefined) {
      this.log.error('experience crashed', { app: appSlug, experience: experienceSlug, error });
    }
    this.running.set(key, { ...current, state: 'stopping' });
    this.broadcastExperience({ ...current, state: 'stopping' });

    const record = this.catalogue.get(appSlug);
    // The drivers it started with: the manifest may have been replaced since.
    await this.releaseDrivers(current.driverBinding, current.drivers, key);
    this.running.delete(key);
    if (error !== undefined) {
      this.crashed(record, { ...current, state: 'crashed', error });
      return;
    }
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
      ...(record.crash ? { crash: record.crash } : {}),
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
      crash: null,
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
    void this.syncAppDrivers();
    this.options.bus.emit(
      ServerEvents.AppsListChanged,
      { apps: this.listApps(), invalid: this.listInvalidApps() },
      'apps',
    );
  }

  /** Runs `change` after the driver host changes queued before it. Never rejects. */
  private queueDriverChange(change: () => Promise<void>): Promise<void> {
    const next = this.driversQueue.then(change).catch((err: unknown) => {
      this.log.error('updating app drivers failed', { err: String(err) });
    });
    this.driversQueue = next;
    return next;
  }

  /**
   * Tells the driver hosts which apps ship drivers. The bridge of an app that
   * went away, or whose source changed, is released first.
   */
  private syncAppDrivers(): Promise<void> {
    const hosts = this.options.appDrivers;
    if (!hosts) return Promise.resolve();
    return this.queueDriverChange(async () => {
      const sources = this.appDriverSources();
      const keys = new Map(sources.map((app) => [app.slug, appDriverSourceKey(app)]));
      for (const [slug, key] of Array.from(this.syncedDrivers)) {
        if (keys.get(slug) !== key) await this.releaseAppDrivers(slug);
      }
      const unchanged =
        keys.size === this.syncedDrivers.size &&
        Array.from(keys).every(([slug, key]) => this.syncedDrivers.get(slug) === key);
      if (unchanged) return;
      hosts.sync(sources);
      for (const [slug, key] of keys) this.syncedDrivers.set(slug, key);
    });
  }

  /**
   * Stops every running experience, of any app, that holds leases on the
   * drivers of `slug`, then releases those drivers. Releasing drops the
   * leases, so an experience left running would get no more events.
   */
  private async releaseAppDrivers(slug: string): Promise<void> {
    const prefix = `${slug}/`;
    const users = Array.from(this.running.values()).filter((running) =>
      running.drivers.some((driver) => driver.startsWith(prefix)),
    );
    for (const running of users) {
      this.log.warn('stopping an experience whose app drivers are being replaced or removed', {
        app: running.appSlug,
        experience: running.experienceSlug,
        drivers: slug,
      });
      await this.stopExperience(running.appSlug, running.experienceSlug).catch((err: unknown) =>
        this.log.warn('experience stop failed', {
          app: running.appSlug,
          experience: running.experienceSlug,
          err: String(err),
        }),
      );
    }
    await this.options.appDrivers?.release(slug);
    this.syncedDrivers.delete(slug);
  }

  private appDriverSources(): AppDriverSource[] {
    return Array.from(this.catalogue.values()).flatMap((record) =>
      record.manifest.python && !(this.uninstalling.has(record.manifest.slug) && !record.builtin)
        ? [
            {
              slug: record.manifest.slug,
              installPath: record.installPath,
              builtin: record.builtin,
              python: record.manifest.python,
            },
          ]
        : [],
    );
  }

  /** Reports the crash, and keeps it on the app until its next successful start. */
  private crashed(
    record: AppRecord | undefined,
    experience: ExperienceRecord & { readonly error: string },
  ): void {
    if (record) {
      record.state = 'crashed';
      record.crash = { experienceSlug: experience.experienceSlug, error: experience.error };
    }
    this.broadcastExperience(experience);
    if (record) this.broadcastList();
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
    startedAs: record.startedAs,
    ...(record.error !== undefined ? { error: record.error } : {}),
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
