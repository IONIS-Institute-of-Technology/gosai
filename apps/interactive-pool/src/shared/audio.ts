/**
 * Short sound effects played through the runtime's AudioContext. A file that
 * fails to load logs a warning and plays nothing, so a missing sound never
 * stops the experience.
 */

import type { ExperienceRuntimeContext } from '@gosai/sdk';

export interface Sound {
  play(): void;
}

const SILENT: Sound = { play: () => undefined };

/** Loads an app file, e.g. `assets/audio/click.mp3`. */
export async function loadSound(rt: ExperienceRuntimeContext, path: string): Promise<Sound> {
  try {
    const response = await fetch(rt.assets.url(path), { signal: rt.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await rt.audio.decodeAudioData(await response.arrayBuffer());
    return {
      play() {
        if (rt.signal.aborted) return;
        const source = rt.audio.createBufferSource();
        source.buffer = buffer;
        source.connect(rt.audio.destination);
        source.start();
      },
    };
  } catch (err) {
    if (!rt.signal.aborted) rt.log.warn(`could not load the sound ${path}`, { err: String(err) });
    return SILENT;
  }
}
