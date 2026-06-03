/**
 * Hands overlay: draws both hand skeletons from the mirrored feed.
 *
 * Ports the legacy `hands` app (components/hand.js) onto Canvas2D.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawHand } from '../shared/mirror.js';
import type { Layer } from '../shared/types.js';

export function createHandsLayer(deps: LayerDeps): Layer {
  return {
    render({ ctx }): void {
      const m = deps.feed.mirror.data;
      drawHand(ctx, m.right_hand_pose, { color: '#ffffff', weight: 4 });
      drawHand(ctx, m.left_hand_pose, { color: '#ffffff', weight: 4 });
    },
  };
}
