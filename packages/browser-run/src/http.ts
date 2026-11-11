/** Bounded requests and retries only for explicitly rejected, rate-limited calls. */

/** Waits without keeping abort listeners after a retry or cancellation. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const finish = (): void => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, Math.min(ms, 2_147_483_647));
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };

    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Supports both Retry-After formats, falling back to exponential backoff with jitter. */
function retryDelay(value: string | null, retry: number): number {
  if (value !== null && value.trim() !== '') {
    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

    if (!Number.isFinite(seconds)) {
      const date = Date.parse(value);

      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
  }

  return 1_000 * 2 ** retry + Math.floor(Math.random() * 250);
}

/** A single 30-second budget covers all four possible requests and their waits. */
export async function request(url: string, method: 'POST' | 'DELETE', headers: Record<string, string>, caller: AbortSignal, body?: string): Promise<Response> {
  const signal = AbortSignal.any([caller, AbortSignal.timeout(30_000)]);
  const init: RequestInit = { method, headers: { ...headers }, signal, redirect: 'error' };

  if (body !== undefined) {
    init.headers = { ...headers, 'Content-Type': 'application/json' };
    init.body = body;
  }

  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    const response = await fetch(url, init);

    if (response.status === 429 && retry < 3) {
      const delay = retryDelay(response.headers.get('Retry-After'), retry);
      await response.body?.cancel().catch(() => undefined);
      await pause(delay, signal);
      continue;
    }

    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      await response.body?.cancel().catch(() => undefined);

      const hint = response.status === 401 || response.status === 403
        ? '; check the account and Browser Rendering - Edit token permission'
        : response.status === 429 ? '; browser acquisition rate or concurrency limit reached after retries, lower workers or retry later' : '';

      throw new Error(`Cloudflare Browser Run ${method} failed (HTTP ${response.status})${hint}`);
    }

    return response;
  }
}

interface CloudflareEnvelope {
  readonly result: unknown;
}

/** Recognizes the API envelope before reading its unparsed result. */
function isEnvelope(value: unknown): value is CloudflareEnvelope {
  return value !== null && typeof value === 'object' && 'result' in value;
}

/** Validates either response format at the HTTP boundary without exposing response text. */
export async function resultOf<T>(response: Response, valid: (value: unknown) => value is T, message: string): Promise<T> {
  const body: unknown = await response.json().catch(() => { throw new Error('Cloudflare Browser Run returned invalid JSON'); });
  const result = isEnvelope(body) ? body.result : body;

  if (!valid(result)) throw new Error(message);

  return result;
}
