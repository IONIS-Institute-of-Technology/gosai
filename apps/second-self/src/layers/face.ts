/**
 * Face overlay: draws the face-mesh wireframe from the mirrored feed. The
 * mirrored stream only carries the mesh while this layer runs.
 */

import type { LayerDeps } from '../shared/deps.js';
import { drawFace } from '../shared/mirror.js';
import type { Layer } from '../shared/types.js';

export function createFaceLayer(deps: LayerDeps): Layer {
  return {
    start(): void {
      deps.setFaceMesh('mirrored', true);
    },

    render({ ctx }): void {
      drawFace(ctx, deps.feed.mirror.data.face_mesh, { color: '#ffffff', weight: 2 });
    },

    stop(): void {
      deps.setFaceMesh('mirrored', false);
    },
  };
}
