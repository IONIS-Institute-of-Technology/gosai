/**
 * In-browser audio synthesis (Web Audio).
 *
 * Replaces the legacy Python `synthesizer` driver, which mixed sine waves on
 * the server and streamed them to the speaker. Doing it in the browser removes
 * the audio round-trip and the Python dependency:
 *
 * - {@link Synth.setLive} drives a continuously-running sine oscillator for the
 *   theremin (frequency + amplitude follow the hands every frame).
 * - {@link Synth.playScore} schedules a queue of notes for score playback
 *   (e.g. "La Vie En Rose"), mirroring the legacy `add_to_queue` behavior.
 */

export interface Note {
  /** Hertz. A non-positive frequency is treated as a rest. */
  frequency: number;
  /** Linear amplitude 0..1 (scaled internally to avoid clipping). */
  amplitude: number;
  /** Seconds. */
  duration: number;
}

const MAX_GAIN = 0.25;
const SMOOTHING_S = 0.02;

export class Synth {
  private ctx: AudioContext | null = null;
  private liveOsc: OscillatorNode | null = null;
  private liveGain: GainNode | null = null;
  private scoreOsc: OscillatorNode | null = null;
  private scoreGain: GainNode | null = null;
  private muted = false;

  /** Create the AudioContext + live oscillator. Safe to call repeatedly. */
  ensure(): void {
    if (this.ctx) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();

    this.liveGain = this.ctx.createGain();
    this.liveGain.gain.value = 0;
    this.liveGain.connect(this.ctx.destination);

    this.liveOsc = this.ctx.createOscillator();
    this.liveOsc.type = 'sine';
    this.liveOsc.frequency.value = 440;
    this.liveOsc.connect(this.liveGain);
    this.liveOsc.start();
  }

  /** Resume the context (required after a user gesture by autoplay policies). */
  async resume(): Promise<void> {
    this.ensure();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        // ignored; will retry on the next gesture.
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.setLive(0, 0);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Update the live theremin tone. amplitude/frequency <= 0 silences it. */
  setLive(frequency: number, amplitude: number): void {
    if (!this.ctx || !this.liveOsc || !this.liveGain) return;
    const now = this.ctx.currentTime;
    const wantGain =
      this.muted || frequency <= 0 || amplitude <= 0 ? 0 : clamp(amplitude) * MAX_GAIN;
    if (frequency > 0) {
      this.liveOsc.frequency.setTargetAtTime(frequency, now, SMOOTHING_S);
    }
    this.liveGain.gain.setTargetAtTime(wantGain, now, SMOOTHING_S);
  }

  /** Schedule a sequence of notes. Cancels any score currently playing. */
  playScore(notes: readonly Note[]): void {
    if (!this.ctx || this.muted || notes.length === 0) return;
    this.stopScore();

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.ctx.destination);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(gain);

    let t = this.ctx.currentTime + 0.05;
    for (const note of notes) {
      const dur = Math.max(note.duration, 0.001);
      if (note.frequency > 0 && note.amplitude > 0) {
        osc.frequency.setValueAtTime(note.frequency, t);
        gain.gain.setValueAtTime(clamp(note.amplitude) * MAX_GAIN, t);
        // Brief release toward the end of the note to avoid clicks.
        gain.gain.setTargetAtTime(0, t + dur * 0.85, dur * 0.1);
      } else {
        gain.gain.setValueAtTime(0, t);
      }
      t += dur;
    }
    gain.gain.setValueAtTime(0, t);
    osc.start();
    osc.stop(t + 0.1);

    this.scoreOsc = osc;
    this.scoreGain = gain;
    osc.onended = (): void => {
      try {
        gain.disconnect();
      } catch {
        // already disconnected.
      }
      if (this.scoreOsc === osc) {
        this.scoreOsc = null;
        this.scoreGain = null;
      }
    };
  }

  stopScore(): void {
    if (this.scoreOsc) {
      try {
        this.scoreOsc.stop();
        this.scoreOsc.disconnect();
      } catch {
        // already stopped.
      }
      this.scoreOsc = null;
    }
    if (this.scoreGain) {
      try {
        this.scoreGain.disconnect();
      } catch {
        // already disconnected.
      }
      this.scoreGain = null;
    }
  }

  /** Tear everything down. */
  dispose(): void {
    this.stopScore();
    if (this.liveOsc) {
      try {
        this.liveOsc.stop();
        this.liveOsc.disconnect();
      } catch {
        // ignore
      }
      this.liveOsc = null;
    }
    if (this.liveGain) {
      try {
        this.liveGain.disconnect();
      } catch {
        // ignore
      }
      this.liveGain = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
