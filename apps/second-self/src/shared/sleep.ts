/**
 * Presence-based display sleep for the mirror.
 *
 * Watches the raw `pose` feed each frame and derives a smoothed presence
 * confidence from the visibility of the core body landmarks (nose, shoulders,
 * hips), gated by the person's estimated distance from the mirror (people
 * beyond `maxDistanceM` are ignored). Distance uses the same weak-perspective
 * estimate as the `pose_to_mirror` driver: metric shoulder span from
 * `body_world_pose` vs. pixel span from `body_pose` through a pinhole focal
 * length derived from the camera's horizontal FOV.
 *
 * When confidence stays below the sleep threshold for a grace period, the
 * display "falls asleep": a soft opacity veil closes over the screen from the
 * center (radial gradient, no hard edge) with drifting sparkles, until it is
 * completely dark. Someone standing in front for {@link WAKE_CONFIRM_MS}
 * (passers-by are ignored) wakes it with the reverse reveal plus expanding
 * water ripples.
 *
 * The controller renders on top of every layer in reference space and tells
 * the compositor when it is fully dormant so layer rendering can be skipped
 * entirely while nobody is around.
 */

import type { SleepConfig } from './config.js';
import type { MirrorFeed } from './feed.js';
import { REF_HEIGHT, REF_WIDTH, type Landmark } from './types.js';

/** Feed considered stale (driver silent) after this long without an update. */
const STALE_MS = 1200;
/** Smoothing time constant for the confidence EMA. */
const EMA_TAU_MS = 300;
/** Presence must persist this long before waking (ignores passers-by). */
const WAKE_CONFIRM_MS = 2000;
/** Duration of the wake reveal animation. */
const WAKE_MS = 1600;
/** Duration of the fall-asleep animation. */
const SLEEP_MS = 2600;
/** Assumed camera horizontal FOV (matches the pose_to_mirror default). */
const HFOV_DEG = 60;
/** Shoulders must be at least this visible for the distance estimate. */
const MIN_SHOULDER_VIS = 0.5;
/** The distance gate fades out over this fraction beyond maxDistanceM. */
const DISTANCE_FADE = 0.15;

/** MediaPipe pose indices: nose, shoulders, hips. */
const CORE_LANDMARKS = [0, 11, 12, 23, 24];
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;

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

/** Expanding water ripple ring, spawned when the mirror wakes. */
interface Ripple {
  /** Milliseconds until this ripple starts expanding (spawn stagger). */
  delay: number;
  /** Milliseconds since the ripple started (after its delay elapsed). */
  age: number;
  lifeMs: number;
}

const SPARKLE_COLORS = ['180,220,255', '255,235,180', '220,200,255', '240,250,255'];

/** The veil always opens/closes from the screen center. */
const CENTER = { x: REF_WIDTH / 2, y: REF_HEIGHT / 2 };

export class SleepController {
  private phase: Phase = 'awake';
  /** 1 = fully awake, 0 = fully dark. */
  private progress = 1;
  private confidence = 1;
  private absentSince: number | null = null;
  private presentSince: number | null = null;
  private sparkles: Sparkle[] = [];
  private ripples: Ripple[] = [];

  constructor(
    private readonly cfg: SleepConfig,
    private readonly feed: MirrorFeed,
  ) {}

  /** True while fully dark: the compositor can skip layer rendering. */
  dormant(): boolean {
    return (
      this.cfg.enabled &&
      this.phase === 'asleep' &&
      this.sparkles.length === 0 &&
      this.ripples.length === 0
    );
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
        if (sleepConfirmed) this.phase = 'falling-asleep';
        break;
      case 'falling-asleep':
        if (wakeConfirmed) {
          this.beginWake();
        } else {
          this.progress = Math.max(0, this.progress - deltaMs / SLEEP_MS);
          if (this.progress === 0) this.phase = 'asleep';
        }
        break;
      case 'asleep':
        if (wakeConfirmed) this.beginWake();
        break;
      case 'waking':
        this.progress = Math.min(1, this.progress + deltaMs / WAKE_MS);
        if (this.progress === 1) this.phase = 'awake';
        break;
    }

    this.updateSparkles(deltaMs);
    this.updateRipples(deltaMs);
  }

  private beginWake(): void {
    this.phase = 'waking';
    // Staggered water ripples radiating from the center.
    this.ripples = [0, 260, 520, 820].map((delay) => ({
      delay,
      age: 0,
      lifeMs: 1900,
    }));
  }

  /** Draw the veil + transition effects. Context is in reference space. */
  render(ctx: CanvasRenderingContext2D, now: number): void {
    if (!this.cfg.enabled) return;
    if (this.phase === 'awake' && this.sparkles.length === 0 && this.ripples.length === 0) {
      return;
    }

    const bounds = visibleRefBounds(ctx);
    const eased = easeInOutCubic(this.progress);
    const maxRadius = farthestCornerDistance(CENTER, bounds);
    const radius = eased * maxRadius;

    ctx.save();

    // Opacity-gradient veil: transparent at the center falling off smoothly
    // to opaque black, with the whole gradient scaled by the reveal radius.
    // No hard edge anywhere; beyond the outer radius the gradient clamps to
    // full black, so the veil naturally covers letterbox bars too.
    if (this.progress <= 0.001) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    } else if (this.progress < 1) {
      // Center opacity rises as the veil closes so the last moment melts to
      // black instead of collapsing into a shrinking dot.
      const centerAlpha = Math.pow(1 - eased, 1.6);
      const grad = ctx.createRadialGradient(CENTER.x, CENTER.y, 0, CENTER.x, CENTER.y, radius);
      const stops = 8;
      for (let i = 0; i <= stops; i++) {
        const k = i / stops;
        const alpha = centerAlpha + (1 - centerAlpha) * Math.pow(k, 2.4);
        grad.addColorStop(k, `rgba(0,0,0,${alpha.toFixed(4)})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
    }

    const transitioning = this.phase === 'falling-asleep' || this.phase === 'waking';
    ctx.globalCompositeOperation = 'lighter';

    // Wide, soft glow band that rides the veil's falloff (no crisp ring).
    if (transitioning && this.progress > 0.001 && this.progress < 0.999) {
      const k = Math.sin(Math.PI * this.progress);
      const glowR = Math.max(1, radius);
      const band = Math.max(120, glowR * 0.4);
      const glow = ctx.createRadialGradient(
        CENTER.x,
        CENTER.y,
        Math.max(0, glowR - band),
        CENTER.x,
        CENTER.y,
        glowR + band,
      );
      glow.addColorStop(0, 'rgba(150,205,255,0)');
      glow.addColorStop(0.5, `rgba(150,205,255,${(0.2 * k).toFixed(3)})`);
      glow.addColorStop(1, 'rgba(150,205,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

      this.spawnSparkles(radius, maxRadius);
    }

    this.renderRipples(ctx, maxRadius);

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

  /**
   * Instantaneous presence confidence: core-landmark visibility scaled by the
   * distance gate, so a fully visible person beyond `maxDistanceM` counts as
   * absent.
   */
  private rawConfidence(now: number): number {
    const snap = this.feed.raw;
    if (now - snap.lastUpdate > STALE_MS) return 0;
    const pose = snap.data.body_pose;
    if (pose.length === 0) return 0;
    let sum = 0;
    for (const idx of CORE_LANDMARKS) sum += landmarkVisibility(pose[idx]);
    return (sum / CORE_LANDMARKS.length) * this.distanceGate();
  }

  /**
   * 1 within `maxDistanceM`, fading to 0 shortly beyond it (the soft edge
   * keeps someone hovering right at the limit from strobing the mirror).
   * Passes when the distance cannot be estimated.
   */
  private distanceGate(): number {
    const meters = this.estimateDistanceM();
    if (meters === null) return 1;
    const max = this.cfg.maxDistanceM;
    return clamp(1 - (meters - max) / (max * DISTANCE_FADE), 0, 1);
  }

  /**
   * Weak-perspective distance from the camera in meters: metric shoulder span
   * (from `body_world_pose`) over pixel span through the pinhole focal length,
   * mirroring `pose_to_mirror._estimate_distance`. Null when the shoulders
   * are not reliably visible.
   */
  private estimateDistanceM(): number | null {
    const { body_pose, body_world_pose, frame_width } = this.feed.raw.data;
    const lp = body_pose[LEFT_SHOULDER];
    const rp = body_pose[RIGHT_SHOULDER];
    const lw = body_world_pose[LEFT_SHOULDER];
    const rw = body_world_pose[RIGHT_SHOULDER];
    if (!lp || !rp || !lw || !rw || lp.length < 2 || rp.length < 2) return null;
    if (
      landmarkVisibility(lp) < MIN_SHOULDER_VIS ||
      landmarkVisibility(rp) < MIN_SHOULDER_VIS
    ) {
      return null;
    }
    const px = Math.hypot(lp[0]! - rp[0]!, lp[1]! - rp[1]!);
    const meters = Math.hypot((lw[0] ?? 0) - (rw[0] ?? 0), (lw[1] ?? 0) - (rw[1] ?? 0));
    if (px <= 1 || meters <= 0.05) return null;
    const fx = frame_width / 2 / Math.tan((HFOV_DEG * Math.PI) / 360);
    return (fx * meters) / px;
  }

  private renderRipples(ctx: CanvasRenderingContext2D, maxRadius: number): void {
    for (const r of this.ripples) {
      if (r.age <= 0) continue;
      const t = Math.min(1, r.age / r.lifeMs);
      const radius = easeOutCubic(t) * maxRadius;
      const alpha = 0.35 * (1 - t);
      if (alpha <= 0.005 || radius < 1) continue;
      // Soft ripple band: thick blurred crest with a fainter wide skirt.
      ctx.beginPath();
      ctx.arc(CENTER.x, CENTER.y, radius, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(170,220,255,0.8)';
      ctx.shadowBlur = 40;
      ctx.strokeStyle = `rgba(180,225,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = 26 * (1 - t) + 6;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(230,245,255,${(alpha * 0.6).toFixed(3)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  private updateRipples(deltaMs: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i]!;
      if (r.delay > 0) {
        r.delay -= deltaMs;
        continue;
      }
      r.age += deltaMs;
      if (r.age >= r.lifeMs) this.ripples.splice(i, 1);
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
        x: CENTER.x + Math.cos(angle) * r,
        y: CENTER.y + Math.sin(angle) * r,
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

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
