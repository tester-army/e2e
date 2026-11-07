/**
 * `e2bBrowsers()` against a mocked `e2b` SDK, tunnel, and `fetch`: the create
 * body and its metadata, a sandbox closed to public traffic with its Host
 * masked as localhost, Chromium started on the sandbox's loopback, the tunnel
 * that carries the traffic token and the bare loopback endpoint it gives,
 * kill and tunnel close on release and after a failed start, sweep by run
 * and target, downloads read back from the sandbox, and refused options.
 */

import type { BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { e2bBrowsers } from '../../src/web.ts';

const sdk = vi.hoisted(() => {
  class CommandExitError extends Error {
    constructor(readonly exitCode: number, readonly stdout: string, readonly stderr: string) {
      super(`exit ${exitCode}`);
    }
  }
  const state = {
    /** Commands run to completion, as opposed to `started` ones left running. */
    ran: [] as string[],
    /** Whether the template lacks Playwright's Chromium: the lookup then runs for real, here, where `/ms-playwright` does not exist. */
    noChromium: false,
    /** What the Chromium lookup prints. */
    chromiumPath: '/ms-playwright/chromium-1248/chrome-linux64/chrome',
    created: [] as { template: string; opts: Record<string, unknown> }[],
    started: [] as { command: string; opts: Record<string, unknown> }[],
    read: [] as { id: string; path: string }[],
    killed: [] as string[],
    disconnected: [] as string[],
    listed: [] as unknown[],
    running: [] as string[],
    /** What `tail` of a log in the sandbox prints. */
    log: '',
    /** Ids whose kill fails. */
    killFails: [] as string[],
    counter: 0,
  };
  const handle = (sandboxId: string) => ({
    sandboxId,
    trafficAccessToken: `tat-${sandboxId}`,
    getHost: (port: number) => `${port}-${sandboxId}.e2b.test`,
    commands: {
      run: async (command: string, opts: Record<string, unknown>) => {
        if (opts['background'] !== true) {
          state.ran.push(command);
          if (!command.includes('find /ms-playwright')) return { exitCode: 0, stdout: state.log };
          if (state.noChromium) {
            const { spawnSync } = await import('node:child_process');
            const lookup = spawnSync('bash', ['-c', command.replaceAll('/tmp/e2e-downloads', '"$(mktemp -d)"')], { encoding: 'utf8' });
            if (lookup.status !== 0) throw new CommandExitError(lookup.status ?? 1, lookup.stdout, lookup.stderr);
            return { exitCode: 0, stdout: lookup.stdout };
          }
          return { exitCode: 0, stdout: state.chromiumPath };
        }
        state.started.push({ command, opts });
        return { wait: async () => ({ exitCode: 0 }), kill: async () => true, disconnect: async () => void state.disconnected.push(command) };
      },
    },
    files: {
      read: async (path: string) => {
        state.read.push({ id: sandboxId, path });
        return new TextEncoder().encode('file bytes');
      },
    },
  });
  const Sandbox = {
    create: async (template: string, opts: Record<string, unknown>) => {
      state.created.push({ template, opts });
      state.counter += 1;
      return handle(`sbx${state.counter}`);
    },
    connect: async (id: string) => handle(id),
    kill: async (id: string) => {
      if (state.killFails.includes(id)) throw new Error('E2B unavailable');
      state.killed.push(id);
      return id !== 'gone';
    },
    list: (opts: Record<string, unknown>) => {
      state.listed.push(opts);
      let done = false;
      return {
        get hasNext() {
          return !done;
        },
        nextItems: async (_opts?: { signal?: AbortSignal }) => {
          done = true;
          return state.running.map((sandboxId) => ({ sandboxId }));
        },
      };
    },
  };
  return { state, Sandbox, CommandExitError };
});

vi.mock('e2b', () => ({ Sandbox: sdk.Sandbox, CommandExitError: sdk.CommandExitError, ConnectionConfig: { setIntegration: () => {} } }));

const tunnels = vi.hoisted(() => ({
  open: new Map<string, { host: string; trafficToken: string }>(),
  closed: [] as string[],
}));

vi.mock('../../src/tunnel.ts', () => ({
  openTunnel: async (target: { host: string; trafficToken: string }) => {
    const url = `http://tunnel.${target.host}`;
    tunnels.open.set(url, target);
    return { url, close: async () => void tunnels.closed.push(target.host) };
  },
}));

/** Answers `/json/version` the way Chromium does behind the masked Host: its WebSocket URL on localhost. */
async function chromiumVersion(): Promise<Response> {
  return Response.json({ Browser: 'HeadlessChrome', webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/b1' });
}

const version = vi.fn(chromiumVersion);

function request(overrides: Partial<BrowserRequest> = {}): BrowserRequest {
  return { runId: 'run1', targetName: 'web', slot: 0, slots: 1, env: { E2B_API_KEY: 'key' }, signal: new AbortController().signal, log: () => {}, ...overrides };
}

function context(): BrowserReleaseContext {
  return { runId: 'run1', targetName: 'web', env: { E2B_API_KEY: 'key' }, signal: new AbortController().signal, log: () => {} };
}

beforeEach(() => {
  for (const list of [sdk.state.created, sdk.state.started, sdk.state.read, sdk.state.killed, sdk.state.disconnected, sdk.state.listed, sdk.state.running]) list.length = 0;
  sdk.state.counter = 0;
  sdk.state.ran.length = 0;
  sdk.state.noChromium = false;
  sdk.state.chromiumPath = '/ms-playwright/chromium-1248/chrome-linux64/chrome';
  sdk.state.log = '';
  sdk.state.killFails.length = 0;
  tunnels.open.clear();
  tunnels.closed.length = 0;
  version.mockReset();
  version.mockImplementation(chromiumVersion);
  vi.stubGlobal('fetch', version);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('e2bBrowsers()', () => {
  it('leases a browser sandbox with its Host masked as localhost', async () => {
    const lines: string[] = [];
    const lease = await e2bBrowsers().acquire(request({ slot: 1, attemptId: 'a1', log: (line) => lines.push(line) }));

    expect(sdk.state.created).toEqual([
      {
        template: 'e2e-chromium',
        opts: expect.objectContaining({
          apiKey: 'key',
          timeoutMs: 3_600_000,
          metadata: { e2e_run: 'run1', e2e_target: 'web', e2e_slot: '1', e2e_attempt: 'a1' },
          network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
        }),
      },
    ]);
    expect(sdk.state.ran).toEqual([expect.stringContaining('find /ms-playwright')]);
    expect(sdk.state.started.map((started) => started.command)).toEqual([expect.stringMatching(/^exec \/ms-playwright\/chromium-1248\/chrome-linux64\/chrome .*--remote-debugging-port=9222/)]);
    // Chromium keeps running; only the SDK's output stream for it is closed.
    expect(sdk.state.disconnected).toEqual(sdk.state.started.map((started) => started.command));
    expect([...tunnels.open.values()]).toEqual([{ host: '9222-sbx1.e2b.test', trafficToken: 'tat-sbx1' }]);
    expect(lease).toEqual({ id: 'sbx1', cdpEndpoint: 'ws://tunnel.9222-sbx1.e2b.test/devtools/browser/b1' });
    expect(JSON.stringify(lease)).not.toContain('tat-sbx1');
    expect(lines).toEqual(['browser sandbox sbx1']);
  });

  it('fails at once, naming what is missing, when the template has no Playwright Chromium', async () => {
    sdk.state.noChromium = true;
    await expect(e2bBrowsers().acquire(request())).rejects.toThrow(/exited 1: Playwright Chromium is missing from the sandbox template/);
    expect(sdk.state.started).toEqual([]);
    expect(version).not.toHaveBeenCalled();
    expect(sdk.state.killed).toEqual(['sbx1']);
    expect(tunnels.closed).toEqual(['9222-sbx1.e2b.test']);
  });

  it.each(['', '/ms-playwright/x/chrome; rm -rf /', '/usr/bin/chrome'])('refuses %j as the Chromium path before starting anything', async (path) => {
    sdk.state.chromiumPath = path;
    await expect(e2bBrowsers().acquire(request())).rejects.toThrow(/unexpected Chromium path/);
    expect(sdk.state.started).toEqual([]);
    expect(sdk.state.killed).toEqual(['sbx1']);
  });

  it('waits for Chromium to answer through the tunnel', async () => {
    version.mockResolvedValueOnce(new Response('', { status: 502 })).mockRejectedValueOnce(new Error('ECONNRESET'));
    await e2bBrowsers().acquire(request());
    expect(version).toHaveBeenCalledTimes(3);
  });

  it.each(['not a url', 'ws://localhost:9222/devtools/page/p1'])('refuses %s as the browser endpoint, and kills the sandbox', async (endpoint) => {
    version.mockImplementation(async () => Response.json({ webSocketDebuggerUrl: endpoint }));
    const controller = new AbortController();
    const pending = e2bBrowsers().acquire(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('interrupted')), 1_200);
    await expect(pending).rejects.toThrow(/no WebSocket endpoint/);
    expect(sdk.state.killed).toEqual(['sbx1']);
    expect(tunnels.closed).toEqual(['9222-sbx1.e2b.test']);
  });

  it('names the end of Chromium\'s log when it never answers', async () => {
    version.mockImplementation(async () => new Response('', { status: 502 }));
    sdk.state.log = 'error while loading shared libraries: libnss3.so';
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('interrupted')), 1_200);
    await expect(e2bBrowsers().acquire(request({ signal: controller.signal }))).rejects.toThrow(/did not answer.*\/tmp\/e2e-chromium\.log: error while loading shared libraries/);
    expect(sdk.state.killed).toEqual(['sbx1']);
  });

  it('passes the template, scope, and lifetime through', async () => {
    const provider = e2bBrowsers({ template: 'my-chromium', scope: 'attempt', timeoutMs: 600_000 });
    expect(provider.scope).toBe('attempt');
    await provider.acquire(request());
    expect(sdk.state.created[0]).toMatchObject({ template: 'my-chromium', opts: { timeoutMs: 600_000 } });
  });

  it('kills the sandbox when the progress line throws', async () => {
    await expect(e2bBrowsers().acquire(request({ log: () => { throw new Error('reporter gone'); } }))).rejects.toThrow('reporter gone');
    expect(sdk.state.killed).toEqual(['sbx1']);
  });

  it('kills the sandbox on release', async () => {
    const provider = e2bBrowsers();
    await provider.release(await provider.acquire(request()), context());
    expect(sdk.state.killed).toEqual(['sbx1']);
    expect(tunnels.closed).toEqual(['9222-sbx1.e2b.test']);
  });

  it('sweeps the running sandboxes of the run and target', async () => {
    sdk.state.running.push('left1', 'left2');
    expect(await e2bBrowsers().sweep!(context())).toEqual(['left1', 'left2']);
    expect(sdk.state.listed).toEqual([expect.objectContaining({ query: { metadata: { e2e_run: 'run1', e2e_target: 'web' }, state: ['running'] } })]);
    expect(sdk.state.killed).toEqual(['left1', 'left2']);
  });

  it('names what a sweep could not kill, and leaves out what E2B no longer knew', async () => {
    sdk.state.running.push('left1', 'gone', 'stuck');
    sdk.state.killFails.push('stuck');
    await expect(e2bBrowsers().sweep!(context())).rejects.toThrow('killed left1; could not kill stuck (E2B unavailable), so E2B ends them after timeoutMs');
  });

  it('reads a download back from the sandbox', async () => {
    const provider = e2bBrowsers();
    expect(provider.downloads!.dir).toBe('/tmp/e2e-downloads');
    const bytes = await provider.downloads!.read({ id: 'sbx9', cdpEndpoint: 'wss://x' }, '/tmp/e2e-downloads/report.csv', { ...context() });
    expect(new TextDecoder().decode(bytes)).toBe('file bytes');
    expect(sdk.state.read).toEqual([{ id: 'sbx9', path: '/tmp/e2e-downloads/report.csv' }]);
  });

  it('refuses unknown options, a bad lifetime, and a missing key', async () => {
    expect(() => e2bBrowsers({ headless: false } as never)).toThrow(/headless/);
    expect(() => e2bBrowsers({ timeoutMs: -1 })).toThrow(/timeoutMs/);
    expect(() => e2bBrowsers({ template: ' ' })).toThrow(/template/);
    await expect(e2bBrowsers().acquire(request({ env: {} }))).rejects.toThrow(/E2B_API_KEY/);
  });
});
