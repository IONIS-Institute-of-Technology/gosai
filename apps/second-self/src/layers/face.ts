/**
 * Face overlay: draws the MediaPipe face-mesh wireframe from the mirrored feed.
 *
 * Ports the legacy `face` app (components/face.js).
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawFace } from '../shared/mirror.js';
import type { Layer } from '../shared/types.js';

export function createFaceLayer(deps: LayerDeps): Layer {
  return {
    render({ ctx }): void {
      drawFace(ctx, deps.feed.mirror.data.face_mesh, { color: '#ffffff', weight: 2 });
    },
  };
}
