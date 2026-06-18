import { createCameraProjectorSurfaceCalibration } from '@gosai/sdk';

export default createCameraProjectorSurfaceCalibration({
  slug: 'interactive-pool-surface',
  name: 'Interactive Pool Calibration',
  description: 'Camera/projector calibration for the pool table surface.',
  surfaceSize: { width: 1920, height: 1080 },
  cornerLabels: ['TL', 'TR', 'BR', 'BL'],
  stepCopy: {
    markers: {
      title: 'Step 1 - ArUco Markers',
      help: 'Aim the camera so all 9 markers are visible. Use arrow keys to pan and the scroll wheel to zoom the pattern to fit the pool table. Press Space or Next when ready.',
    },
    'pool-corners': {
      title: 'Step 2 - Pool Corners',
      help: 'Click the pool table corners in order: top-left, top-right, bottom-right, bottom-left. Drag a corner to adjust it. Press r to reset.',
    },
    compute: {
      title: 'Step 3 - Compute Homography',
      help: 'Computing the camera/projector homography for the pool table surface.',
    },
    preview: {
      title: 'Step 4 - Preview',
      help: 'Check that the projected preview lands on the pool table. Press Space or Done to save the calibration.',
    },
  },
  projectorMessages: {
    poolCorners: 'pick pool table corners on the control window',
    compute: 'computing pool table homography...',
    done: 'interactive-pool calibration complete',
    abort: 'interactive-pool calibration aborted',
  },
});
