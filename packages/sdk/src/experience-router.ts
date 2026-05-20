import type { ExperienceRouter, ServerConnection } from './types.js';

export class ExperienceRouterImpl implements ExperienceRouter {
  private currentSlug: string | null = null;

  constructor(
    private readonly appSlug: string,
    private readonly server: ServerConnection,
  ) {}

  setCurrent(slug: string | null): void {
    this.currentSlug = slug;
  }

  current(): string | null {
    return this.currentSlug;
  }

  async switchTo(experienceSlug: string): Promise<void> {
    if (this.currentSlug && this.currentSlug !== experienceSlug) {
      try {
        await this.server.request('experience:stop', {
          appSlug: this.appSlug,
          experienceSlug: this.currentSlug,
        });
      } catch {
        // best-effort
      }
    }
    await this.server.request('experience:start', {
      appSlug: this.appSlug,
      experienceSlug,
    });
    this.currentSlug = experienceSlug;
  }

  async stop(experienceSlug?: string): Promise<void> {
    const slug = experienceSlug ?? this.currentSlug;
    if (!slug) return;
    await this.server.request('experience:stop', {
      appSlug: this.appSlug,
      experienceSlug: slug,
    });
    if (slug === this.currentSlug) this.currentSlug = null;
  }
}
