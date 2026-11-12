/**
 * `notte()` against a mocked `notte-sdk`: the start body, the progress
 * line, stop on release and after a cancelled request, a session Notte
 * already closed, and one SDK client per API key and API URL.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { notte } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  class NotteAPIError extends Error {
    constructor(readonly statusCode: number, message: string) {
      super(message);
    }
  }
  const state = {
    clients: [] as unknown[],
    started: [] as { body: unknown; signal: AbortSignal | undefined }[],
    stopped: [] as { id: string; signal: AbortSignal | undefined }[],
    counter: 0,
    start: async (_body: unknown): Promise<unknown> => {
      state.counter += 1;
      return { session_id: `s${state.counter}`, status: 'active', cdp_url: `wss://notte/s${state.counter}`, viewer_url: `https://view/s${state.counter}` };
    },
    stop: async (id: string): Promise<unknown> => ({ session_id: id, status: 'closed' }),
  };
  class NotteClient {
    constructor(config: unknown) {
      state.clients.push(config);
    }
    sessions = {
      start: async (body: unknown, options?: { signal?: AbortSignal }) => {
        state.started.push({ body, signal: options?.signal });
        return state.start(body);
      },
      stop: async (id: string, _query: unknown, options?: { signal?: AbortSignal }) => {
        state.stopped.push({ id, signal: options?.signal });
        return state.stop(id);
      },
    };
  }
  return { state, NotteClient, NotteAPIError };
});

vi.mock('notte-sdk', () => ({ NotteClient: sdk.NotteClient, NotteAPIError: sdk.NotteAPIError }));

const defaultStart = sdk.state.start;
const defaultStop = sdk.state.stop;

beforeEach(() => {
  Object.assign(sdk.state, { clients: [], started: [], stopped: [], counter: 0, start: defaultStart, stop: defaultStop });
});

const env = { NOTTE_API_KEY: 'n-test' };

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'run-1',
    targetName: 'web',
    slot: 0,
    slots: 2,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(): BrowserReleaseContext {
  return { runId: 'run-1', targetName: 'web', env, signal: new AbortController().signal, log: () => undefined };
}

describe('notte()', () => {
  it('starts a session with the options as given and logs its id, never the token-bearing viewer URL', async () => {
    const req = request({ attemptId: 'a1' });
    const provider = notte({ solve_captchas: true, idle_timeout_minutes: 5 });
    const lease = await provider.acquire(req);
    expect(lease).toEqual({ id: 's1', cdpEndpoint: 'wss://notte/s1' });
    expect(sdk.state.started).toEqual([{ body: { solve_captchas: true, idle_timeout_minutes: 5 }, signal: undefined }]);
    expect(req.lines).toEqual(['session s1']);
  });

  it('leases one session per attempt, since a Notte session refuses new browser contexts', () => {
    expect(notte().scope).toBe('attempt');
  });

  it('fails a session that started without a CDP URL', async () => {
    sdk.state.start = async () => ({ session_id: 's9', status: 'active', cdp_url: null });
    await expect(notte().acquire(request())).rejects.toThrow('session s9 started without a CDP URL');
  });

  it('stops the session on release, and a session Notte already closed counts as stopped', async () => {
    const provider = notte();
    const lease = await provider.acquire(request());
    const context = releaseContext();
    await provider.release(lease, context);
    expect(sdk.state.stopped).toEqual([{ id: 's1', signal: context.signal }]);
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(404, 'session not found');
    };
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(400, 'Session s1 is already closed');
    };
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
  });

  it('surfaces any other stop failure, and a stop that left the session open', async () => {
    const provider = notte();
    const lease = await provider.acquire(request());
    sdk.state.stop = async () => {
      throw new sdk.NotteAPIError(500, 'internal');
    };
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('internal');
    sdk.state.stop = async (id) => ({ session_id: id, status: 'active' });
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('session s1 is still active after stop');
  });

  it('stops a session that arrived after the request was cancelled', async () => {
    const controller = new AbortController();
    sdk.state.start = async (body) => {
      controller.abort();
      return defaultStart(body);
    };
    await expect(notte().acquire(request({ signal: controller.signal }))).rejects.toThrow('session s1 arrived after the request was cancelled; stopped');
    expect(sdk.state.stopped.map((stop) => stop.id)).toEqual(['s1']);
  });

  it('starts nothing for a request already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('interrupted'));
    await expect(notte().acquire(request({ signal: controller.signal }))).rejects.toThrow('interrupted');
    expect(sdk.state.started).toEqual([]);
  });

  it('says so when a session that arrived after cancellation could not be stopped', async () => {
    const controller = new AbortController();
    sdk.state.start = async (body) => {
      controller.abort();
      return defaultStart(body);
    };
    sdk.state.stop = async () => {
      throw new Error('503 unavailable');
    };
    await expect(notte().acquire(request({ signal: controller.signal }))).rejects.toThrow(
      'session s1 arrived after the request was cancelled; stopping it failed, so Notte ends it after idle_timeout_minutes: 503 unavailable',
    );
  });

  it('fails without an API key in the run environment and reuses one SDK client per key and API URL', async () => {
    const provider = notte();
    await expect(provider.acquire(request({ env: { NOTTE_API_KEY: '  ' } }))).rejects.toThrow('NOTTE_API_KEY is not set');
    await provider.acquire(request());
    await provider.acquire(request({ slot: 1 }));
    await provider.acquire(request({ env: { NOTTE_API_KEY: 'n-other' } }));
    await provider.acquire(request({ env: { NOTTE_API_KEY: 'n-test', NOTTE_API_URL: 'https://staging.notte.cc' } }));
    expect(sdk.state.clients).toEqual([{ apiKey: 'n-test' }, { apiKey: 'n-other' }, { apiKey: 'n-test', baseUrl: 'https://staging.notte.cc' }]);
  });
});
