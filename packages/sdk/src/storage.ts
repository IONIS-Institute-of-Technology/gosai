import type { ServerConnection, StorageClient } from './types.js';

/**
 * Storage for `appSlug`. An app token only reaches its own app's storage. The
 * third argument, a server base URL from when storage went over HTTP, is
 * ignored.
 */
export function createStorageClient(
  appSlug: string,
  server: ServerConnection,
  _baseUrl?: string,
): StorageClient {
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

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T>(key: string, fallback: T): Promise<T>;
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
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
