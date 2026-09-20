/**
 * Second Self's calibration experience, the `experience` of its manifest's
 * `mirror-reflection` calibration. It measures the rig with a printed ChArUco
 * sheet and fits the pose of the screen behind the mirror (calibration/
 * wizard.ts), then saves the app's calibration profile.
 *
 * GOSAI opens it from the dashboard's Calibrate button, in two windows: the
 * projector window on the mirror, which runs the wizard and draws, and a
 * control window on a display with a keyboard and a mouse, which is where
 * every field, button and shortcut lives. `finishCalibration` ends the flow
 * and GOSAI closes both.
 *
 * The mirror alone is not enough, because the mirror takes no input at all. A
 * run started without a control window therefore says where to start it from
 * and goes back to the main experience.
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
import { renderNotice } from './calibration/wizard/render.js';
import {
  CALIBRATION_CANCELLED,
  endCalibration,
  loadLensProfile,
  loadMirrorProfile,
} from './shared/calibration.js';
import { loadConfig } from './shared/config.js';
import { createMirrorFeed, keepLatest } from './shared/feed.js';
import { Projection } from './shared/projection.js';
import { REF_HEIGHT, REF_WIDTH, type Layer } from './shared/types.js';
import { cssViewport } from './shared/ui.js';

const REFERENCE = { width: REF_WIDTH, height: REF_HEIGHT } as const;

/** How long the notice stays up before the mirror goes back to the experience. */
const NOTICE_MS = 10_000;

const NOTICE_LINES: readonly string[] = [
  'Start the calibration from the',
  'GOSAI dashboard.',
  '',
  'It opens a control window for the',
  'keyboard and mouse.',
];

interface Mirror {
  readonly surface: FullscreenCanvas;
  /** Null while the mirror is only showing the notice. */
  readonly wizard: Layer | null;
}

interface State {
  mirror: Mirror | null;
  removeControl: (() => void) | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
}

export default defineExperience<State>({
  init: () => ({ mirror: null, removeControl: null, noticeTimer: null }),

  async start(rt, state): Promise<void> {
    const launch = readCalibrationLaunch(rt);
    const end = (result: CalibrationResult): void => {
      endCalibration(rt, launch, result).catch((err: unknown) => {
        rt.log.error('second-self: could not end the calibration', { err: String(err) });
      });
    };
    rt.log.info('second-self: calibration starting', { ...launch });

    if (launch.role === 'control') {
      state.removeControl = showControl({ rt, cancel: () => end(CALIBRATION_CANCELLED) });
      return;
    }

    const surface = createFullscreenCanvas({
      reference: REFERENCE,
      mode: 'contain',
      signal: rt.signal,
    });

    // Nothing on this display takes a key or a tap, so a run with no control
    // window has no way forward. Say where it is started from instead.
    if (!launch.managed) {
      rt.log.warn('second-self: the calibration needs the control window GOSAI opens with it');
      state.mirror = { surface, wizard: null };
      state.noticeTimer = setTimeout(() => end(CALIBRATION_CANCELLED), NOTICE_MS);
      return;
    }

    const [config, profile, lens] = await Promise.all([
      loadConfig(rt),
      loadMirrorProfile(rt),
      loadLensProfile(rt),
    ]);
    const feed = createMirrorFeed();
    rt.drivers.on('pose_to_mirror', 'mirrored_data', keepLatest(feed.mirror));
    rt.drivers.on('pose', 'raw_data', keepLatest(feed.raw));
    // Nothing here draws a face, so neither stream needs the 478-point mesh on
    // the wire. The wizard's eye positions come from the face data the `pose`
    // driver hands its in-process subscribers, which this does not touch.
    const warn = (what: string) => (err: unknown) =>
      rt.log.warn(`second-self: ${what} failed`, { err: String(err) });
    rt.drivers.execute('pose', 'set_face_mesh', false).catch(warn('pose set_face_mesh'));
    rt.drivers
      .execute('pose_to_mirror', 'set_mirror_config', { face_mesh: false })
      .catch(warn('mirror face mesh'));

    // The drivers may have just started, so give them the saved projection
    // first: it is what the wizard restores when it is left.
    const projection = new Projection(rt, config, profile, lens);
    await projection.apply().catch(warn('set_mirror_config'));

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
    if (!mirror.wizard) {
      renderNotice(ctx, NOTICE_LINES);
      return;
    }
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
    state.mirror?.wizard?.stop?.();
    state.mirror = null;
    if (state.noticeTimer !== null) clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
    state.removeControl?.();
    state.removeControl = null;
  },
});
