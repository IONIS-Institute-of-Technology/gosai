/**
 * The two things the wizard needs a browser for: decoding a camera frame and
 * repeating a tick.
 *
 * It binds no keys and no pointer: the mirror has neither, so every command
 * arrives from the control window over `rt.events`. Behind this interface the
 * phase machine and the whole conversation with the drivers can be driven in a
 * test without a document, and a test can step the timers itself instead of
 * waiting for them.
 */

import type { CameraFrame } from './render.js';

export interface WizardUi {
  /** Decodes a base64 JPEG frame, calling back when it can be drawn. */
  decodeFrame(jpegBase64: string, ready: (frame: CameraFrame) => void): void;
  /** Runs `tick` every `ms`. Returns what stops it. */
  every(ms: number, tick: () => void): () => void;
}

export const browserUi: WizardUi = {
  decodeFrame(jpegBase64: string, ready: (frame: CameraFrame) => void): void {
    const image = new Image();
    image.onload = () => ready({ image, width: image.naturalWidth, height: image.naturalHeight });
    image.src = `data:image/jpeg;base64,${jpegBase64}`;
  },

  every(ms: number, tick: () => void): () => void {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};
