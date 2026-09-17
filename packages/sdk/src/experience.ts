import type { ExperienceDefinition } from './types.js';

/**
 * Declares an experience. Export the result as the default export of the
 * module the manifest names as the experience's `entry`.
 */
export function defineExperience<TState = void>(
  definition: ExperienceDefinition<TState>,
): ExperienceDefinition<TState> {
  return definition;
}
