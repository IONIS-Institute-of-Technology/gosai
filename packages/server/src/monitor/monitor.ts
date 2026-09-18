/**
 * System monitor. Samples OS-wide CPU and memory usage periodically and
 * publishes them as `system:stats`, along with whether Python drivers can
 * run, which the dashboard's status bar shows.
 */

import { cpus, freemem, totalmem, uptime } from 'node:os';
import type { SystemStats } from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/bus.js';
import type { ChildLogger } from '../logger/logger.js';

export interface SystemMonitorOptions {
  readonly bus: EventBus;
  readonly logger: ChildLogger;
  /** Why the built-in Python drivers can't run, or null. See `DriverHub.unavailableReason`. */
  readonly pythonUnavailable?: () => string | null;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;

interface CpuSnapshot {
  readonly idle: number;
  readonly total: number;
}

export class SystemMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpu: CpuSnapshot | null = null;

  constructor(private readonly options: SystemMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.sample();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sample(): void {
    try {
      const stats: SystemStats = {
        cpuPercent: this.cpuPercent(),
        memoryBytes: totalmem() - freemem(),
        memoryTotalBytes: totalmem(),
        uptimeMs: Math.floor(uptime() * 1000),
        pythonUnavailable: this.options.pythonUnavailable?.() ?? null,
      };
      this.options.bus.emit(ServerEvents.Stats, stats, 'monitor');
    } catch (err) {
      this.options.logger.warn('sampling failed', { err: String(err) });
    }
  }

  private cpuPercent(): number {
    const next = aggregateCpu();
    const last = this.lastCpu;
    this.lastCpu = next;
    if (!last) return 0;
    const idleDelta = next.idle - last.idle;
    const totalDelta = next.total - last.total;
    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  }
}

function aggregateCpu(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}
