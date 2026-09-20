/**
 * The few numbers the operator types before a run, and the rules they have to
 * pass.
 *
 * Both windows use this file: the control window draws the form from
 * {@link MEASURE_FIELDS} and sends back what was typed, the mirror checks it
 * with {@link parseMeasurements}. The rules therefore live in one place, and
 * the window with the keyboard never decides on its own what a valid screen
 * size is.
 *
 * The screen size and the mirror-to-pixel gap set the scale of the whole
 * projection; the camera height lets a visitor's feet set their size; the
 * operator's pupil distance sets the scale of the head their eye position is
 * read from during the run. They are typed rather than fitted on purpose:
 * fitting them together with the mirror pose would let a wrong screen size
 * hide inside a wrong pose.
 */

import type { RigMeasurements } from '../shared/config.js';

export type Eye = 'left' | 'right';

/** Everything the operator types before the run starts. */
export interface MeasurementInput {
  readonly measurements: RigMeasurements;
  /**
   * Pupil distance of the operator, used for this run only. It is not a
   * setting: the mirror stands in a public space and measures nobody.
   */
  readonly ipdMm: number;
  /** The eye that stays open during the whole run. */
  readonly eye: Eye;
}

export type MeasureKey =
  'screen_width_mm' | 'screen_height_mm' | 'gap_mm' | 'camera_height_mm' | 'ipd_mm';

export interface MeasureField {
  readonly key: MeasureKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  /** An empty value is allowed, and turns off what the number feeds. */
  readonly optional?: boolean;
  readonly help: string;
}

/** What the operator's pupil distance starts at, for the one run they measure. */
export const DEFAULT_OPERATOR_IPD_MM = 63;

export const MEASURE_FIELDS: readonly MeasureField[] = [
  {
    key: 'screen_width_mm',
    label: 'Active screen width (mm)',
    min: 100,
    max: 3000,
    help: 'The lit area behind the mirror, not the frame around it.',
  },
  {
    key: 'screen_height_mm',
    label: 'Active screen height (mm)',
    min: 100,
    max: 3000,
    help: 'Measured on the same lit area. The mirror window must fill that display.',
  },
  {
    key: 'gap_mm',
    label: 'Mirror to pixel plane (mm)',
    min: 0,
    max: 50,
    help: 'From the mirror surface to the pixels. Approximate is fine: under 10 mm this is a secondary effect.',
  },
  {
    key: 'camera_height_mm',
    label: 'Camera lens above the floor (mm)',
    min: 300,
    max: 3000,
    optional: true,
    help: 'Optional but worth measuring: it lets the mirror size up visitors, children included, from their feet on the floor. It assumes the mirror hangs plumb. Leave it empty to turn that off.',
  },
  {
    key: 'ipd_mm',
    label: 'Your pupil distance (mm)',
    min: 45,
    max: 80,
    help: 'Hold a ruler against the mirror, look at one eye at a time and read the distance between the pupils. Typical adults are 58 to 68 mm. Yours is used for this run only.',
  },
];

/** The form as it travels: one string per field, plus `eye`. */
export type MeasureValues = Readonly<Record<string, string>>;

export type MeasureResult =
  | { readonly ok: true; readonly value: MeasurementInput }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The typed values, or every rule that was missed. */
export function parseMeasurements(values: MeasureValues): MeasureResult {
  const errors: string[] = [];
  const numbers = new Map<MeasureKey, number>();
  for (const field of MEASURE_FIELDS) {
    const raw = String(values[field.key] ?? '')
      .replace(',', '.')
      .trim();
    if (raw === '' && field.optional) continue;
    const parsed = Number(raw);
    if (raw === '' || !Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
      errors.push(`${field.label}: enter a number between ${field.min} and ${field.max}`);
      continue;
    }
    numbers.set(field.key, parsed);
  }
  const width = numbers.get('screen_width_mm');
  const height = numbers.get('screen_height_mm');
  const gap = numbers.get('gap_mm');
  const ipd = numbers.get('ipd_mm');
  const cameraHeight = numbers.get('camera_height_mm');
  if (width === undefined || height === undefined || gap === undefined || ipd === undefined) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      measurements: {
        screen_width_mm: width,
        screen_height_mm: height,
        gap_mm: gap,
        ...(cameraHeight === undefined ? {} : { camera_height_mm: cameraHeight }),
      },
      ipdMm: ipd,
      eye: values['eye'] === 'left' ? 'left' : 'right',
    },
  };
}

/** Prefilled values: the last run's measurements, and the defaults for the rest. */
export function measureDefaults(
  previous: RigMeasurements | null,
  ipdMm: number,
  eye: Eye,
): MeasureValues {
  return {
    screen_width_mm: previous ? String(previous.screen_width_mm) : '',
    screen_height_mm: previous ? String(previous.screen_height_mm) : '',
    gap_mm: previous ? String(previous.gap_mm) : '5',
    camera_height_mm:
      previous?.camera_height_mm === undefined ? '' : String(previous.camera_height_mm),
    ipd_mm: String(ipdMm),
    eye,
  };
}
