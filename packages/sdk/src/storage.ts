import type { ServerConnection, StorageClient } from './types.js';

export function createStorageClient(appSlug: string, server: ServerConnection): StorageClient {
  return new StorageClientImpl(appSlug, server);
}

/**
 * App-scoped key/value store, backed by the server's `storage:*` commands.
 * Values are stored as JSON; only JSON-serializable values are supported.
 * Keys use letters, digits, `.`, `_` and `-`.
 */
export class StorageClientImpl implements StorageClient {
  constructor(
    private readonly appSlug: string,
    private readonly server: ServerConnection,
  ) {}

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const stored = await this.server.request('storage:get', { appSlug: this.appSlug, key });
    return stored.found ? (stored.value as T) : fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.server.request('storage:set', { appSlug: this.appSlug, key, value });
  }

  async remove(key: string): Promise<void> {
    await this.server.request('storage:remove', { appSlug: this.appSlug, key });
  }

  async list(): Promise<string[]> {
    const { keys } = await this.server.request('storage:list', { appSlug: this.appSlug });
    return keys;
  }
}
