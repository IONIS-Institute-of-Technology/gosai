/**
 * Reports a clear message when the server rejects the dashboard token, which
 * happens when the server and the desktop app were started with different
 * tokens (for example `bun run dev:server` and `bun run dev:desktop` in two
 * terminals without a shared GOSAI_DASHBOARD_TOKEN).
 */

const MISMATCH_MESSAGE =
  '[gosai-desktop] the server rejected the dashboard token (HTTP 401). The server and the ' +
  'desktop app were started with different GOSAI_DASHBOARD_TOKEN values, for example by ' +
  'running dev:server and dev:desktop separately. Use `bun run dev`, or set the same ' +
  'GOSAI_DASHBOARD_TOKEN for both processes.';

const PROBE_ATTEMPTS = 30;
const PROBE_INTERVAL_MS = 1000;

let reported = false;

/** Logs the token mismatch message once when `status` is 401. */
export function reportUnauthorized(status: number): void {
  if (status !== 401 || reported) return;
  reported = true;
  console.error(MISMATCH_MESSAGE);
}

/**
 * Checks the token against a server that may still be starting: retries
 * until the server answers, then reports a 401.
 */
export async function checkServerToken(baseUrl: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/v1/info`, {
        headers: { authorization: `Bearer ${token}` },
      });
      reportUnauthorized(res.status);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
  }
}
