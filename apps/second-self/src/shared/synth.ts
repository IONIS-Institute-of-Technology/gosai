/**
 * Audio synthesis on the runtime's AudioContext (`rt.audio`).
 *
 * - {@link Synth.setLive} drives a continuously running sine oscillator for the
 *   theremin: frequency and amplitude follow the hands every frame.
 * - {@link Synth.playScore} schedules a queue of notes for score playback
 *   (e.g. "La Vie En Rose").
 *
 * The runtime creates, resumes and closes the context; the synth only owns
 * its nodes.
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
  private readonly liveOsc: OscillatorNode;
  private readonly liveGain: GainNode;
  private scoreOsc: OscillatorNode | null = null;
  private scoreGain: GainNode | null = null;

  constructor(private readonly ctx: AudioContext) {
    this.liveGain = ctx.createGain();
    this.liveGain.gain.value = 0;
    this.liveGain.connect(ctx.destination);

    this.liveOsc = ctx.createOscillator();
    this.liveOsc.type = 'sine';
    this.liveOsc.frequency.value = 440;
    this.liveOsc.connect(this.liveGain);
    this.liveOsc.start();
  }

  /** Updates the live theremin tone. A non-positive amplitude or frequency silences it. */
  setLive(frequency: number, amplitude: number): void {
    const now = this.ctx.currentTime;
    const gain = frequency <= 0 || amplitude <= 0 ? 0 : clamp(amplitude) * MAX_GAIN;
    if (frequency > 0) this.liveOsc.frequency.setTargetAtTime(frequency, now, SMOOTHING_S);
    this.liveGain.gain.setTargetAtTime(gain, now, SMOOTHING_S);
  }

  /** The audio clock the synth schedules on, in seconds. */
  get currentTime(): number {
    return this.ctx.currentTime;
  }

  /**
   * Schedules a sequence of notes. Cancels any score currently playing.
   * Returns the {@link currentTime} the first note starts at.
   */
  playScore(notes: readonly Note[]): number {
    const start = this.ctx.currentTime + 0.05;
    if (notes.length === 0) return start;
    this.stopScore();

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.ctx.destination);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(gain);

    let t = start;
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
      gain.disconnect();
      if (this.scoreOsc === osc) {
        this.scoreOsc = null;
        this.scoreGain = null;
      }
    };
    return start;
  }

  stopScore(): void {
    const osc = this.scoreOsc;
    const gain = this.scoreGain;
    this.scoreOsc = null;
    this.scoreGain = null;
    if (osc) {
      osc.onended = null;
      osc.stop();
      osc.disconnect();
    }
    gain?.disconnect();
  }

  /** Stops and disconnects every node. The runtime closes the context itself. */
  dispose(): void {
    this.stopScore();
    this.liveOsc.stop();
    this.liveOsc.disconnect();
    this.liveGain.disconnect();
  }
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
