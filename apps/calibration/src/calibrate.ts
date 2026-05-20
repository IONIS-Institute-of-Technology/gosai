/**
 * Calibration wizard entry. Loaded in *both* the projector (fullscreen) and
 * control windows; we branch on the `role` URL param and delegate to the
 * appropriate module.
 *
 *   ?role=control  -> orchestrates the step machine and UI
 *   anything else  -> passive projector renderer
 *
 * Both roles use `rt.events` to coordinate. The dashboard listens for the
 * same events to hide / show the control window during the background step
 * and to close both windows when the wizard finishes.
 */

import { defineExperience } from '@gosai/sdk';
import { detectRole } from './shared.js';
import {
  initProjectorState,
  startProjector,
  stopProjector,
  type ProjectorState,
} from './projector.js';
import {
  initControlState,
  startControl,
  stopControl,
  type ControlState,
} from './control.js';

type State =
  | { role: 'projector'; projector: ProjectorState }
  | { role: 'control'; control: ControlState };

export default defineExperience<State>({
  slug: 'calibrate',
  name: 'Calibration Wizard',
  description: 'Full camera-projector calibration walked through end-to-end.',

  init(): State {
    const role = detectRole();
    if (role === 'control') {
      return { role, control: initControlState() };
    }
    return { role, projector: initProjectorState() };
  },

  async start(rt, state) {
    if (state.role === 'control') {
      await startControl(rt, state.control);
    } else {
      await startProjector(rt, state.projector);
    }
  },

  async stop(_rt, state) {
    if (state.role === 'control') {
      await stopControl(state.control);
    } else {
      await stopProjector(state.projector);
    }
  },
});
