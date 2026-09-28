/**
 * `kernel()` against a mocked `@onkernel/sdk`: the create body and its tags,
 * the live view line, delete on release and after a cancelled request, a
 * browser Kernel no longer knows, and one SDK client per API key.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '../../src/kernel/index.ts';

const sdk = vi.hoisted(() => {
  class NotFoundError extends Error {}
  const state = {
    apiKeys: [] as string[],
    created: [] as { body: unknown; signal: AbortSignal | undefined }[],
    deleted: [] as string[],
    create: async (_body: unknown): Promise<unknown> => {
      state.counter += 1;
      return { session_id: `b${state.counter}`, cdp_ws_url: `wss://kernel/b${state.counter}`, browser_live_view_url: `https://view/b${state.counter}` };
    },
    deleteByID: async (_id: string): Promise<void> => undefined,
    counter: 0,
  };
  class Kernel {
    constructor({ apiKey }: { apiKey: string }) {
      state.apiKeys.push(apiKey);
    }
    browsers = {
      create: async (body: unknown, options?: { signal?: AbortSignal }) => {
        state.created.push({ body, signal: options?.signal });
        return state.create(body);
      },
      deleteByID: async (id: string) => {
        state.deleted.push(id);
        return state.deleteByID(id);
      },
    };
  }
  return { state, Kernel, NotFoundError };
});

vi.mock('@onkernel/sdk', () => ({ Kernel: sdk.Kernel, NotFoundError: sdk.NotFoundError }));

const defaultCreate = sdk.state.create;
const defaultDelete = sdk.state.deleteByID;

beforeEach(() => {
  Object.assign(sdk.state, { apiKeys: [], created: [], deleted: [], counter: 0, create: defaultCreate, deleteByID: defaultDelete });
});

const env = { KERNEL_API_KEY: 'k-test' };

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

describe('kernel()', () => {
  it('is a browser provider named kernel with the scope it was given', () => {
    expect(kernel().name).toBe('kernel');
    expect(kernel().scope).toBeUndefined();
    expect(kernel({ scope: 'attempt' }).scope).toBe('attempt');
  });

  it('creates a browser with the run tags and the idle timeout backstop, and logs its live view', async () => {
    const req = request({ slot: 1 });
    const lease = await kernel({ stealth: true, tags: { team: 'qa' } }).acquire(req);
    expect(lease).toEqual({ id: 'b1', cdpEndpoint: 'wss://kernel/b1' });
    expect(sdk.state.created).toEqual([
      { body: { stealth: true, timeout_seconds: 600, tags: { team: 'qa', e2e_run: 'run-1', e2e_target: 'web', e2e_slot: '1' } }, signal: req.signal },
    ]);
    expect(req.lines).toEqual(['browser b1, watch at https://view/b1']);
  });

  it('keeps an explicit idle timeout, tags a per-attempt lease with its attempt, and never passes scope to Kernel', async () => {
    await kernel({ scope: 'attempt', timeout_seconds: 60 }).acquire(request({ attemptId: 'a7' }));
    expect(sdk.state.created[0]?.body).toEqual({ timeout_seconds: 60, tags: { e2e_run: 'run-1', e2e_target: 'web', e2e_slot: '0', e2e_attempt: 'a7' } });
  });

  it('logs the session alone when Kernel has no live view for it', async () => {
    sdk.state.create = async () => ({ session_id: 'headless', cdp_ws_url: 'wss://kernel/headless' });
    const req = request();
    await kernel({ headless: true }).acquire(req);
    expect(req.lines).toEqual(['browser headless']);
  });

  it('deletes the browser on release, and a browser Kernel no longer knows counts as deleted', async () => {
    const provider = kernel();
    const lease = await provider.acquire(request());
    await provider.release(lease, releaseContext());
    expect(sdk.state.deleted).toEqual(['b1']);
    sdk.state.deleteByID = async () => {
      throw new sdk.NotFoundError('gone');
    };
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
  });

  it('surfaces any other delete failure', async () => {
    const provider = kernel();
    const lease = await provider.acquire(request());
    sdk.state.deleteByID = async () => {
      throw new Error('500 internal');
    };
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('500 internal');
  });

  it('deletes a browser that arrived after the request was cancelled', async () => {
    const controller = new AbortController();
    sdk.state.create = async (body) => {
      controller.abort();
      return defaultCreate(body);
    };
    await expect(kernel().acquire(request({ signal: controller.signal }))).rejects.toThrow('browser b1 arrived after the request was cancelled; deleted');
    expect(sdk.state.deleted).toEqual(['b1']);
  });

  it('says so when a browser that arrived after cancellation could not be deleted', async () => {
    const controller = new AbortController();
    sdk.state.create = async (body) => {
      controller.abort();
      return defaultCreate(body);
    };
    sdk.state.deleteByID = async () => {
      throw new Error('503 unavailable');
    };
    await expect(kernel().acquire(request({ signal: controller.signal }))).rejects.toThrow(
      'browser b1 arrived after the request was cancelled; deleting it failed, so Kernel ends it after timeout_seconds: 503 unavailable',
    );
  });

  it('fails without an API key in the run environment and reuses one SDK client per key', async () => {
    const provider = kernel();
    await expect(provider.acquire(request({ env: { KERNEL_API_KEY: '  ' } }))).rejects.toThrow('KERNEL_API_KEY is not set');
    await provider.acquire(request());
    await provider.acquire(request({ slot: 1 }));
    await provider.acquire(request({ env: { KERNEL_API_KEY: 'k-other' } }));
    expect(sdk.state.apiKeys).toEqual(['k-test', 'k-other']);
  });

  it('surfaces a Kernel failure as is', async () => {
    sdk.state.create = async () => {
      throw new Error('401 invalid api key');
    };
    await expect(kernel().acquire(request())).rejects.toThrow('401 invalid api key');
  });
});
