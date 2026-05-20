import type { ExperienceDefinition, ExperienceLifecycle } from './types.js';

/**
 * Type-safe helper for defining an experience. Apps export the result as
 * default from their experience entry module.
 */
export function defineExperience<TState = void>(
  options: {
    slug: string;
    name: string;
    description?: string;
  } & ExperienceLifecycle<TState>,
): ExperienceDefinition<TState> {
  const { slug, name, description, init, start, render, stop } = options;
  return {
    slug,
    name,
    description,
    lifecycle: { init, start, render, stop },
  };
}
