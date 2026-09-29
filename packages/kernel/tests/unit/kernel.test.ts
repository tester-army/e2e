/**
 * `kernel()` against a mocked `@onkernel/sdk`: the create body and its tags,
 * the live view line, delete on release and after a cancelled request, a
 * browser Kernel no longer knows, one SDK client per API key, and replays.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserLease, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import type { ProviderRecordContext } from 'e2e/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kernel } from '../../src/index.ts';

const sdk = vi.hoisted(() => {
  class NotFoundError extends Error {}
  const state = {
    apiKeys: [] as string[],
    created: [] as { body: unknown; signal: AbortSignal | undefined }[],
    deleted: [] as string[],
    replays: [] as string[],
    replaySignals: [] as (AbortSignal | undefined)[],
    downloadFailures: 0,
    create: async (_body: unknown): Promise<unknown> => {
      state.counter += 1;
      return { session_id: `b${state.counter}`, cdp_ws_url: `wss://kernel/b${state.counter}`, browser_live_view_url: `https://view/b${state.counter}` };
    },
    deleteByID: async (_id: string): Promise<void> => undefined,
    files: [] as { id: string; path: string; signal: AbortSignal | undefined }[],
    listed: [] as unknown[],
    active: [] as string[],
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
      list: (query: unknown) => {
        state.listed.push(query);
        return (async function* () {
          for (const id of state.active) yield { session_id: id };
        })();
      },
      deleteByID: async (id: string) => {
        state.deleted.push(id);
        return state.deleteByID(id);
      },
      fs: {
        readFile: async (id: string, query: { path: string }, options?: { signal?: AbortSignal }) => {
          state.files.push({ id, path: query.path, signal: options?.signal });
          return new Response('file bytes');
        },
      },
      replays: {
        start: async (id: string, body: unknown, options?: { signal?: AbortSignal }) => {
          state.replays.push(`start ${id} ${JSON.stringify(body)}`);
          state.replaySignals.push(options?.signal);
          return { replay_id: 'r1' };
        },
        stop: async (replayId: string, params: { id_or_name: string }, options?: { signal?: AbortSignal }) => {
          state.replays.push(`stop ${replayId} ${params.id_or_name}`);
          state.replaySignals.push(options?.signal);
        },
        download: async (replayId: string, params: { id_or_name: string }, options?: { signal?: AbortSignal }) => {
          state.replays.push(`download ${replayId} ${params.id_or_name}`);
          state.replaySignals.push(options?.signal);
          if (state.downloadFailures > 0) {
            state.downloadFailures -= 1;
            throw new Error('503 replay still processing');
          }
          return new Response('mp4 bytes', { headers: { 'content-type': 'video/mp4' } });
        },
      },
    };
  }
  return { state, Kernel, NotFoundError };
});

vi.mock('@onkernel/sdk', () => ({ Kernel: sdk.Kernel, NotFoundError: sdk.NotFoundError }));

const defaultCreate = sdk.state.create;
const defaultDelete = sdk.state.deleteByID;

beforeEach(() => {
  Object.assign(sdk.state, { apiKeys: [], created: [], deleted: [], replays: [], replaySignals: [], files: [], listed: [], active: [], downloadFailures: 0, counter: 0, create: defaultCreate, deleteByID: defaultDelete });
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

  it('trims the newline Kernel ends an error body with, keeping the error', async () => {
    class AuthenticationError extends Error {}
    const failure = new AuthenticationError('401 Invalid or disabled API key\n');
    sdk.state.create = async () => {
      throw failure;
    };
    const rejection = await kernel().acquire(request()).catch((cause: unknown) => cause);
    expect(rejection).toBe(failure);
    expect((rejection as Error).message).toBe('401 Invalid or disabled API key');
  });

  it('has each browser save downloads to its own disk and reads a finished one back through the browser filesystem', async () => {
    const provider = kernel();
    expect(provider.downloads?.dir).toBe('/tmp/e2e-downloads');
    const signal = new AbortController().signal;
    const bytes = await provider.downloads!.read({ id: 'b1', cdpEndpoint: 'wss://kernel/b1' }, '/tmp/e2e-downloads/guid-1', { runId: 'run-1', targetName: 'web', env, signal });
    expect(new TextDecoder().decode(bytes)).toBe('file bytes');
    expect(sdk.state.files).toEqual([{ id: 'b1', path: '/tmp/e2e-downloads/guid-1', signal }]);
  });

  it('sweeps the run\'s active browsers for the target, deletes each, and names only those Kernel still knew', async () => {
    sdk.state.active = ['b7', 'b8'];
    sdk.state.deleteByID = async (id) => {
      if (id === 'b8') throw new sdk.NotFoundError('gone');
    };
    await expect(kernel().sweep!(releaseContext())).resolves.toEqual(['b7']);
    expect(sdk.state.listed).toEqual([{ status: 'active', tags: { e2e_run: 'run-1', e2e_target: 'web' } }]);
    expect(sdk.state.deleted).toEqual(['b7', 'b8']);
  });

  it('deletes every browser the sweep found even when one delete fails, and names both', async () => {
    sdk.state.active = ['b7', 'b8', 'b9'];
    sdk.state.deleteByID = async (id) => {
      if (id === 'b8') throw new Error('500 internal');
    };
    await expect(kernel().sweep!(releaseContext())).rejects.toThrow(
      'deleted b7, b9; could not delete b8 (500 internal), so Kernel ends it after timeout_seconds',
    );
    expect(sdk.state.deleted).toEqual(['b7', 'b8', 'b9']);
  });

  describe('record', () => {
    const lease: BrowserLease = { id: 'b1', cdpEndpoint: 'wss://kernel/b1' };
    const recordContext = (): ProviderRecordContext => ({ runId: 'run-1', targetName: 'web', attemptId: 'a1', env, signal: new AbortController().signal });

    it('records a Kernel replay of the browser and saves it as replay.mp4 in the directory it is given', async () => {
      const before = Date.now();
      const recording = await kernel().record!(lease, recordContext());
      expect(recording).toBeDefined();
      expect(Date.parse(recording!.startedAt)).toBeGreaterThanOrEqual(before - 1);
      const dir = mkdtempSync(path.join(tmpdir(), 'e2e-kernel-replay-'));
      const stopSignal = new AbortController().signal;
      await expect(recording!.stop({ dir, signal: stopSignal })).resolves.toEqual({ file: 'replay.mp4' });
      expect(readFileSync(path.join(dir, 'replay.mp4'), 'utf8')).toBe('mp4 bytes');
      expect(sdk.state.replays).toEqual(['start b1 {}', 'stop r1 b1', 'download r1 b1']);
      // Every Kernel call carries the signal of the step it serves.
      expect(sdk.state.replaySignals.map((signal) => signal instanceof AbortSignal)).toEqual([true, true, true]);
      expect(sdk.state.replaySignals[1]).toBe(stopSignal);
      rmSync(dir, { recursive: true, force: true });
    });

    it('retries a failed download without stopping the replay a second time', async () => {
      sdk.state.downloadFailures = 1;
      const recording = await kernel().record!(lease, recordContext());
      const dir = mkdtempSync(path.join(tmpdir(), 'e2e-kernel-replay-'));
      await expect(recording.stop({ dir, signal: new AbortController().signal })).rejects.toThrow('503 replay still processing');
      await expect(recording.stop({ dir, signal: new AbortController().signal })).resolves.toEqual({ file: 'replay.mp4' });
      expect(sdk.state.replays).toEqual(['start b1 {}', 'stop r1 b1', 'download r1 b1', 'download r1 b1']);
      rmSync(dir, { recursive: true, force: true });
    });

    it('passes the replay options through', async () => {
      await kernel({ replay: { framerate: 20, max_duration_in_seconds: 300 } }).record!(lease, recordContext());
      expect(sdk.state.replays).toEqual(['start b1 {"framerate":20,"max_duration_in_seconds":300}']);
      expect(sdk.state.created).toEqual([]);
    });

    it('does not record with replay: false or for a headless browser, which Kernel cannot replay', () => {
      expect(kernel({ replay: false }).record).toBeUndefined();
      expect(kernel({ headless: true }).record).toBeUndefined();
      expect(kernel({ headless: false }).record).toBeTypeOf('function');
    });

    it('never passes replay to Kernel as a create-browser field', async () => {
      await kernel({ replay: { framerate: 20 } }).acquire(request());
      expect(sdk.state.created[0]?.body).not.toHaveProperty('replay');
    });
  });
});
