/**
 * Second Self's calibration experience, the `experience` of its manifest's
 * `mirror-reflection` calibration. It runs the mirror wizard
 * (calibration/wizard.ts), which saves the app's calibration profile.
 *
 * - GOSAI opens it from the dashboard's Calibrate button or a kiosk: the
 *   projector window on the mirror runs the wizard, and the control window
 *   can cancel. `finishCalibration` ends the flow and GOSAI closes both.
 * - The menu, and main on a mirror rig without a profile, switch to it with
 *   `rt.router.switchTo`. It then runs in one window and switches back to
 *   main when the wizard ends.
 *
 * See shared/calibration.ts for the profile and for how each run ends.
 */

import {
  createFullscreenCanvas,
  defineExperience,
  readCalibrationLaunch,
  type CalibrationResult,
  type FrameInfo,
  type FullscreenCanvas,
} from '@gosai/sdk';

import { showControl } from './calibration/control.js';
import { createMirrorWizard } from './calibration/wizard.js';
import { CALIBRATION_CANCELLED, endCalibration, loadMirrorProfile } from './shared/calibration.js';
import { loadConfig } from './shared/config.js';
import { createMirrorFeed, keepLatest } from './shared/feed.js';
import { Projection } from './shared/projection.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from './shared/types.js';
import { cssViewport } from './shared/ui.js';

const REFERENCE = { width: REF_WIDTH, height: REF_HEIGHT } as const;

interface Mirror {
  readonly surface: FullscreenCanvas;
  readonly wizard: Layer;
}

interface State {
  mirror: Mirror | null;
  removeControl: (() => void) | null;
}

export default defineExperience<State>({
  init: () => ({ mirror: null, removeControl: null }),

  async start(rt, state): Promise<void> {
    const launch = readCalibrationLaunch(rt);
    const end = (result: CalibrationResult): void => {
      endCalibration(rt, launch, result).catch((err: unknown) => {
        rt.log.error('second-self: could not end the calibration', { err: String(err) });
      });
    };
    rt.log.info('second-self: calibration starting', { ...launch });

    if (launch.role === 'control') {
      state.removeControl = showControl(() => end(CALIBRATION_CANCELLED), rt.signal);
      return;
    }

    const [config, profile] = await Promise.all([loadConfig(rt), loadMirrorProfile(rt)]);
    const feed = createMirrorFeed();
    rt.drivers.on('pose_to_mirror', 'mirrored_data', keepLatest(feed.mirror));
    rt.drivers.on('pose', 'raw_data', keepLatest(feed.raw));
    // Nothing here draws a face, so neither stream needs the 478-point mesh.
    const warn = (what: string) => (err: unknown) =>
      rt.log.warn(`second-self: ${what} failed`, { err: String(err) });
    rt.drivers.execute('pose', 'set_face_mesh', false).catch(warn('pose set_face_mesh'));
    rt.drivers
      .execute('pose_to_mirror', 'set_mirror_config', { face_mesh: false })
      .catch(warn('mirror face mesh'));

    // The drivers may have just started, so give them the saved projection
    // first: it is what the wizard restores when it is left.
    const projection = new Projection(rt, config, profile);
    await projection.apply().catch(warn('set_mirror_config'));

    const surface = createFullscreenCanvas({
      reference: REFERENCE,
      mode: 'contain',
      signal: rt.signal,
    });
    const wizard = createMirrorWizard({ rt, feed, projection, finish: end });
    wizard.start?.();
    state.mirror = { surface, wizard };
  },

  render(_rt, state, frame: FrameInfo): void {
    const mirror = state.mirror;
    if (!mirror) return;
    const { ctx, canvas } = mirror.surface;
    const fit = mirror.surface.fit();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    const viewport = cssViewport(
      fit,
      REFERENCE,
      canvas.width > 0 ? canvas.clientWidth / canvas.width : 1,
    );
    mirror.wizard.render?.({
      ctx,
      timestamp: frame.timestamp,
      deltaMs: frame.deltaMs,
      viewport,
    });
  },

  stop(_rt, state): void {
    state.mirror?.wizard.stop?.();
    state.mirror = null;
    state.removeControl?.();
    state.removeControl = null;
  },
});
