import type { ServerConnection, StorageClient } from './types.js';

export function createStorageClient(
  appSlug: string,
  server: ServerConnection,
  baseUrl: string,
): StorageClient {
  return new StorageClientImpl(appSlug, server, baseUrl);
}

/**
 * App-scoped key/value store. Backed by REST endpoints on the server:
 * `GET/POST/DELETE /v1/apps/<slug>/storage/<key>`.
 *
 * Keys are normalised to safe filename characters by the server. Values are
 * stored as JSON; only JSON-serializable values are supported.
 */
export class StorageClientImpl implements StorageClient {
  constructor(
    private readonly appSlug: string,
    private readonly server: ServerConnection,
    private readonly baseUrl: string,
  ) {}

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const res = await fetch(
      `${this.baseUrl}/v1/apps/${this.appSlug}/storage/${encodeURIComponent(key)}`,
    );
    if (res.status === 404) return fallback;
    if (!res.ok) throw new Error(`storage.get(${key}) -> ${res.status}`);
    return (await res.json()) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/v1/apps/${this.appSlug}/storage/${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      },
    );
    if (!res.ok) throw new Error(`storage.set(${key}) -> ${res.status}`);
  }

  async remove(key: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/v1/apps/${this.appSlug}/storage/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
      },
    );
    if (!res.ok && res.status !== 404) throw new Error(`storage.remove(${key}) -> ${res.status}`);
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/apps/${this.appSlug}/storage`);
    if (!res.ok) throw new Error(`storage.list -> ${res.status}`);
    const data = (await res.json()) as { keys: string[] };
    return data.keys;
  }

  // `server` is held in case future variants want to use WS RPC instead.
  protected getServer(): ServerConnection {
    return this.server;
  }
}
