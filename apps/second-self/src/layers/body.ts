/**
 * Body overlay: draws the torso/limb skeleton from the mirrored feed.
 *
 * Ports the legacy `body` app (components/body.js). Head and wrist detail are
 * hidden by default for a cleaner mirror, matching the legacy defaults.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawBody, isValid } from '../shared/mirror.js';
import { strokeLine } from '../shared/canvas.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from '../shared/types.js';

export function createBodyLayer(deps: LayerDeps): Layer {
  return {
    render({ ctx }): void {
      const pose = deps.feed.mirror.data.body_pose;
      drawBody(ctx, pose, { color: '#ffffff', weight: 4, showHead: false, showWrist: false });
      drawOffscreenIndicators(ctx, pose);
    },
  };
}

/** Arrow hints toward a user who has stepped off the left/right edge. */
function drawOffscreenIndicators(ctx: CanvasRenderingContext2D, pose: number[][]): void {
  const nose = pose[0];
  if (!isValid(nose)) return;
  const off = 20;
  const len = 50;
  if (nose[0]! < -20) {
    strokeLine(ctx, off + len, REF_HEIGHT - off, off, REF_HEIGHT - (off + len), off, '#fff');
    strokeLine(
      ctx,
      off,
      REF_HEIGHT - (off + len),
      off + len,
      REF_HEIGHT - (off + 2 * len),
      off,
      '#fff',
    );
  } else if (nose[0]! > REF_WIDTH + 20) {
    strokeLine(
      ctx,
      REF_WIDTH - (off + len),
      REF_HEIGHT - off,
      REF_WIDTH - off,
      REF_HEIGHT - (off + len),
      off,
      '#fff',
    );
    strokeLine(
      ctx,
      REF_WIDTH - off,
      REF_HEIGHT - (off + len),
      REF_WIDTH - (off + len),
      REF_HEIGHT - (off + 2 * len),
      off,
      '#fff',
    );
  }
}
