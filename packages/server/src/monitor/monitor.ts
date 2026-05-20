/**
 * System monitor. Samples process-level metrics periodically and forwards
 * performance samples emitted by drivers to clients.
 */

import { cpus, freemem, totalmem, uptime } from 'node:os';
import type { PerformanceSample, SystemStats } from '@gosai/shared';
import { ServerEvents } from '@gosai/shared/events';
import type { EventBus } from '../ipc/index.js';
import type { ChildLogger } from '../logger/index.js';

export interface SystemMonitorOptions {
  readonly bus: EventBus;
  readonly logger: ChildLogger;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;
const MAX_RECENT_SAMPLES = 200;

interface CpuSnapshot {
  readonly idle: number;
  readonly total: number;
}

export class SystemMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpu: CpuSnapshot | null = null;
  private readonly recentPerformance: PerformanceSample[] = [];
  private readonly perfUnsubscribe: () => void;

  constructor(private readonly options: SystemMonitorOptions) {
    this.perfUnsubscribe = options.bus.on(ServerEvents.PerformanceSample, (_event, payload) => {
      if (this.isPerformanceSample(payload)) {
        this.recentPerformance.push(payload);
        if (this.recentPerformance.length > MAX_RECENT_SAMPLES) {
          this.recentPerformance.shift();
        }
      }
    });
  }

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
    this.perfUnsubscribe();
  }

  recentSamples(): readonly PerformanceSample[] {
    return this.recentPerformance.slice();
  }

  private sample(): void {
    try {
      const cpu = this.cpuPercent();
      const stats: SystemStats = {
        cpuPercent: cpu,
        memoryBytes: totalmem() - freemem(),
        memoryTotalBytes: totalmem(),
        uptimeMs: Math.floor(uptime() * 1000),
      };
      this.options.bus.emit(ServerEvents.Stats, stats, 'monitor');
    } catch (err) {
      this.options.logger.warn('sampling failed', { err: String(err) });
    }
  }

  private cpuPercent(): number {
    const next = aggregateCpu();
    if (!this.lastCpu) {
      this.lastCpu = next;
      return 0;
    }
    const idleDelta = next.idle - this.lastCpu.idle;
    const totalDelta = next.total - this.lastCpu.total;
    this.lastCpu = next;
    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  }

  private isPerformanceSample(value: unknown): value is PerformanceSample {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.source === 'string' &&
      typeof v.type === 'string' &&
      typeof v.metric === 'string' &&
      typeof v.value === 'number' &&
      typeof v.timestamp === 'number'
    );
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
