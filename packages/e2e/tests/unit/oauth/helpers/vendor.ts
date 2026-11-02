import { vi } from 'vitest';
import { CREDENTIALS_ENV } from '../../../../src/oauth/store.ts';
import type { OAuthCredentials } from '../../../../src/oauth/types.ts';

/** A fake JWT with the given payload; signatures are never checked by the package. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

/** A fake vendor that echoes what it was sent. */
export async function echoUpstream(input: string | URL | Request): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input);
  return new Response(JSON.stringify({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.text() }));
}

export interface Echo {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const realFetch = globalThis.fetch;

/**
 * Puts a local server in a vendor's place for a constructor test: `logins`
 * is what `E2E_OAUTH_CREDENTIALS` supplies, and every request the process
 * sends reaches `vendor` with its path and query kept, whatever host it
 * named. Both stand-ins are undone after each test.
 */
export function useVendor(afterEach: (fn: () => void) => void) {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  return (vendor: { url: string }, logins: Record<string, OAuthCredentials>): void => {
    vi.stubEnv(CREDENTIALS_ENV, JSON.stringify(logins));
    // A key in the developer's shell would replace the stored login under test.
    vi.stubEnv('OPENCODE_API_KEY', '');
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
      return realFetch(new URL(`${url.pathname}${url.search}`, vendor.url), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(body === undefined ? {} : { body }),
      });
    });
  };
}
