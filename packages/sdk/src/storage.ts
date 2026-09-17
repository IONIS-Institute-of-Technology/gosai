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
 * `GET/POST/DELETE /v1/apps/<slug>/storage/<key>`, authorized with the
 * connection's token.
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

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T>(key: string, fallback: T): Promise<T>;
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    const res = await fetch(this.keyUrl(key), { headers: this.headers() });
    if (res.status === 404) return fallback;
    if (!res.ok) throw new Error(`storage.get(${key}) -> ${res.status}`);
    return (await res.json()) as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const res = await fetch(this.keyUrl(key), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`storage.set(${key}) -> ${res.status}`);
  }

  async remove(key: string): Promise<void> {
    const res = await fetch(this.keyUrl(key), { method: 'DELETE', headers: this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`storage.remove(${key}) -> ${res.status}`);
  }

  async list(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/apps/${this.appSlug}/storage`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`storage.list -> ${res.status}`);
    const data = (await res.json()) as { keys: string[] };
    return data.keys;
  }

  private keyUrl(key: string): string {
    return `${this.baseUrl}/v1/apps/${this.appSlug}/storage/${encodeURIComponent(key)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.server.authToken;
    return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
  }
}
