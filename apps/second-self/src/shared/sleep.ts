/**
 * Presence-based display sleep for the mirror.
 *
 * Watches the raw `pose` feed each frame and derives a smoothed presence
 * confidence from the visibility of the core body landmarks (nose, shoulders,
 * hips). When confidence stays below the sleep threshold for a grace period,
 * the display "falls asleep": a magical veil closes over the screen (glowing
 * iris ring + drifting sparkles) until it is completely dark. When someone
 * steps back in front, it wakes with the reverse reveal, centered on the
 * person's head when known.
 *
 * The controller renders on top of every layer in reference space and tells
 * the compositor when it is fully dormant so layer rendering can be skipped
 * entirely while nobody is around.
 */

import type { SleepConfig } from './config.js';
import type { MirrorFeed } from './feed.js';
import { isValid } from './mirror.js';
import { REF_HEIGHT, REF_WIDTH, type Landmark } from './types.js';

/** Feed considered stale (driver silent) after this long without an update. */
const STALE_MS = 1200;
/** Smoothing time constant for the confidence EMA. */
const EMA_TAU_MS = 300;
/** Presence must persist this long before waking (debounces flickers). */
const WAKE_CONFIRM_MS = 250;
/** Duration of the wake reveal animation. */
const WAKE_MS = 1600;
/** Duration of the fall-asleep animation. */
const SLEEP_MS = 2600;

/** MediaPipe pose indices: nose, shoulders, hips. */
const CORE_LANDMARKS = [0, 11, 12, 23, 24];

type Phase = 'awake' | 'falling-asleep' | 'asleep' | 'waking';

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** Twinkle phase offset. */
  twinkle: number;
  color: string;
}

const SPARKLE_COLORS = ['180,220,255', '255,235,180', '220,200,255', '240,250,255'];

export class SleepController {
  private phase: Phase = 'awake';
  /** 1 = fully awake, 0 = fully dark. */
  private progress = 1;
  private confidence = 1;
  private absentSince: number | null = null;
  private presentSince: number | null = null;
  private irisCenter = { x: REF_WIDTH / 2, y: REF_HEIGHT * 0.38 };
  private sparkles: Sparkle[] = [];

  constructor(
    private readonly cfg: SleepConfig,
    private readonly feed: MirrorFeed,
  ) {}

  /** True while fully dark: the compositor can skip layer rendering. */
  dormant(): boolean {
    return this.cfg.enabled && this.phase === 'asleep' && this.sparkles.length === 0;
  }

  /** Advance detection + animation state. Call once per frame before render. */
  update(now: number, deltaMs: number): void {
    if (!this.cfg.enabled) return;

    const raw = this.rawConfidence(now);
    const alpha = 1 - Math.exp(-deltaMs / EMA_TAU_MS);
    this.confidence += (raw - this.confidence) * alpha;

    const present = this.confidence >= this.cfg.wakeConfidence;
    const absent = this.confidence < this.cfg.sleepConfidence;
    this.presentSince = present ? (this.presentSince ?? now) : null;
    this.absentSince = absent ? (this.absentSince ?? now) : null;

    const wakeConfirmed = this.presentSince !== null && now - this.presentSince >= WAKE_CONFIRM_MS;
    const sleepConfirmed =
      this.absentSince !== null && now - this.absentSince >= this.cfg.sleepDelaySec * 1000;

    switch (this.phase) {
      case 'awake':
        if (sleepConfirmed) {
          this.captureIrisCenter();
          this.phase = 'falling-asleep';
        }
        break;
      case 'falling-asleep':
        if (wakeConfirmed) {
          this.phase = 'waking';
        } else {
          this.progress = Math.max(0, this.progress - deltaMs / SLEEP_MS);
          if (this.progress === 0) this.phase = 'asleep';
        }
        break;
      case 'asleep':
        if (wakeConfirmed) {
          this.captureIrisCenter();
          this.phase = 'waking';
        }
        break;
      case 'waking':
        this.progress = Math.min(1, this.progress + deltaMs / WAKE_MS);
        if (this.progress === 1) this.phase = 'awake';
        break;
    }

    this.updateSparkles(deltaMs);
  }

  /** Draw the veil + transition effects. Context is in reference space. */
  render(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.cfg.enabled) return;
    if (this.phase === 'awake' && this.sparkles.length === 0) return;

    const bounds = visibleRefBounds(ctx);
    const eased = easeInOutCubic(this.progress);
    const maxRadius = farthestCornerDistance(this.irisCenter, bounds);
    const radius = eased * maxRadius;

    ctx.save();

    // Black veil with a feathered circular reveal around the iris center.
    if (this.progress <= 0.001) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    } else if (this.progress < 1) {
      const feather = Math.max(60, radius * 0.35);
      const grad = ctx.createRadialGradient(
        this.irisCenter.x,
        this.irisCenter.y,
        Math.max(0, radius - feather),
        this.irisCenter.x,
        this.irisCenter.y,
        radius,
      );
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = grad;
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }

    const transitioning = this.phase === 'falling-asleep' || this.phase === 'waking';
    ctx.globalCompositeOperation = 'lighter';

    // Glowing iris ring, brightest mid-transition and gone at both ends.
    if (transitioning) {
      const k = Math.sin(Math.PI * this.progress);
      ctx.beginPath();
      ctx.arc(this.irisCenter.x, this.irisCenter.y, Math.max(1, radius), 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(160,210,255,0.9)';
      ctx.shadowBlur = 50;
      ctx.strokeStyle = `rgba(150,205,255,${0.35 * k})`;
      ctx.lineWidth = 44;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(245,250,255,${0.85 * k})`;
      ctx.lineWidth = 5;
      ctx.stroke();

      this.spawnSparkles(radius, maxRadius);
    }

    for (const s of this.sparkles) {
      const fade = s.life / s.maxLife;
      const glimmer = 0.55 + 0.45 * Math.sin(now * 0.012 + s.twinkle);
      const a = fade * glimmer;
      ctx.fillStyle = `rgba(${s.color},${(0.28 * a).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${s.color},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------

  /** Instantaneous presence confidence from the raw pose feed. */
  private rawConfidence(now: number): number {
    const snap = this.feed.raw;
    if (now - snap.lastUpdate > STALE_MS) return 0;
    const pose = snap.data.body_pose;
    if (pose.length === 0) return 0;
    let sum = 0;
    for (const idx of CORE_LANDMARKS) sum += landmarkVisibility(pose[idx]);
    return sum / CORE_LANDMARKS.length;
  }

  /** Anchor the iris on the person's head when known, else upper center. */
  private captureIrisCenter(): void {
    const nose = this.feed.mirror.data.body_pose[0];
    if (isValid(nose)) {
      this.irisCenter = {
        x: clamp(nose[0]!, 0, REF_WIDTH),
        y: clamp(nose[1]!, 0, REF_HEIGHT),
      };
    } else {
      this.irisCenter = { x: REF_WIDTH / 2, y: REF_HEIGHT * 0.38 };
    }
  }

  private spawnSparkles(radius: number, maxRadius: number): void {
    if (radius < 10 || radius > maxRadius * 0.98) return;
    const count = 2;
    for (let i = 0; i < count; i++) {
      if (this.sparkles.length > 220) return;
      const angle = Math.random() * Math.PI * 2;
      const r = radius + (Math.random() - 0.5) * 40;
      const outward = this.phase === 'waking' ? 1 : -0.4;
      const speed = 0.02 + Math.random() * 0.05;
      const maxLife = 500 + Math.random() * 900;
      this.sparkles.push({
        x: this.irisCenter.x + Math.cos(angle) * r,
        y: this.irisCenter.y + Math.sin(angle) * r,
        vx: Math.cos(angle) * speed * outward + (Math.random() - 0.5) * 0.03,
        vy: Math.sin(angle) * speed * outward - 0.02 - Math.random() * 0.03,
        life: maxLife,
        maxLife,
        size: 1.5 + Math.random() * 3,
        twinkle: Math.random() * Math.PI * 2,
        color: SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)]!,
      });
    }
  }

  private updateSparkles(deltaMs: number): void {
    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      const s = this.sparkles[i]!;
      s.life -= deltaMs;
      if (s.life <= 0) {
        this.sparkles.splice(i, 1);
        continue;
      }
      s.x += s.vx * deltaMs;
      s.y += s.vy * deltaMs;
    }
  }
}

// ---------------------------------------------------------------------------

/** Visibility of a landmark: `[x, y, vis]` (raw) or `[x, y, z, vis]`. */
function landmarkVisibility(lm: Landmark | undefined): number {
  if (!Array.isArray(lm)) return 0;
  const v = lm.length >= 4 ? lm[3] : lm.length >= 3 ? lm[2] : 0;
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The full canvas (including letterbox bars) expressed in reference
 * coordinates, derived from the current context transform.
 */
function visibleRefBounds(ctx: CanvasRenderingContext2D): Bounds {
  const t = ctx.getTransform();
  const x = -t.e / t.a;
  const y = -t.f / t.d;
  return { x, y, w: ctx.canvas.width / t.a, h: ctx.canvas.height / t.d };
}

function farthestCornerDistance(center: { x: number; y: number }, b: Bounds): number {
  const dx = Math.max(Math.abs(center.x - b.x), Math.abs(b.x + b.w - center.x));
  const dy = Math.max(Math.abs(center.y - b.y), Math.abs(b.y + b.h - center.y));
  return Math.hypot(dx, dy);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
