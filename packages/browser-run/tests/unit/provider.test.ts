import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserRequest } from '@e2e-dev/web';
import { browserRun } from '../../src/index.ts';
import { LeaseJournal } from '../../src/journal.ts';

const id = '11111111-1111-4111-8111-111111111111';
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-secret' };
let runId: string;

beforeEach(() => { runId = randomUUID(); });

const context = (overrides: Partial<BrowserRequest> = {}): BrowserRequest => ({
  runId, targetName: 'cloudflare', slot: 0, slots: 1, env,
  signal: new AbortController().signal, log: vi.fn(), ...overrides,
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const journal = new LeaseJournal(env.CLOUDFLARE_ACCOUNT_ID, runId, 'cloudflare');

  for (const receipt of await journal.outstanding()) await journal.forget(receipt);
  await journal.prune();
});

describe('browserRun', () => {
  it('reads credentials from the run and returns a token-free endpoint with handshake headers', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: id, webSocketDebuggerUrl: 'wss://untrusted.example' }));
    vi.stubGlobal('fetch', fetch);
    const provider = browserRun({ keepAlive: 100_000, lab: true });
    const request = context();
    const lease = await provider.acquire(request);
    expect(lease.cdpEndpoint).toBe(`wss://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/devtools/browser/${id}`);
    expect(lease.cdpHeaders).toEqual({ Authorization: 'Bearer synthetic-secret' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('keep_alive=100000&lab=true'), expect.objectContaining({
      method: 'POST', redirect: 'error', headers: lease.cdpHeaders, signal: expect.any(AbortSignal),
    }));
    expect(request.log).toHaveBeenCalledWith(`browser ${id}`);
    expect(JSON.stringify(vi.mocked(request.log).mock.calls)).not.toContain(env.CLOUDFLARE_API_TOKEN);
  });

  it('accepts an API envelope and supports attempt scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ success: true, result: { sessionId: id } })));
    const provider = browserRun({ scope: 'attempt' });
    expect(provider.scope).toBe('attempt');
    expect((await provider.acquire(context())).id).toBe(id);
  });

  it('validates options without credentials or network access', () => {
    expect(() => browserRun()).not.toThrow();

    for (const keepAlive of [0, 9999, 1_200_001, NaN, 10000.1]) expect(() => browserRun({ keepAlive })).toThrow(/keepAlive/);
    expect(() => browserRun({ keepAlive: 10_000 })).not.toThrow();
    expect(() => browserRun({ keepAlive: 1_200_000 })).not.toThrow();
  });

  it('rejects missing or malformed credentials without echoing their value', async () => {
    for (const invalid of [{}, { ...env, CLOUDFLARE_API_TOKEN: ' ' }, { ...env, CLOUDFLARE_ACCOUNT_ID: 'bad-account' }]) {
      await expect(browserRun().acquire(context({ env: invalid }))).rejects.toThrow(/CLOUDFLARE_/);
    }
  });

  it.each([401, 403, 500])('surfaces HTTP %s without copying response bodies or retrying creation', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('synthetic-secret upstream body', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(browserRun().acquire(context())).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects malformed session responses without exposing them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ sessionId: 'secret' })));
    await expect(browserRun().acquire(context())).rejects.toThrow('returned no valid sessionId');
  });

  it('does not expose response text in a JSON parsing error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('synthetic-secret is not JSON')));
    await expect(browserRun().acquire(context())).rejects.toThrow('Cloudflare Browser Run returned invalid JSON');
  });

  it('deletes a session that arrives after cancellation using a fresh cleanup signal', async () => {
    const controller = new AbortController();

    const fetch = vi.fn().mockImplementationOnce(async () => {
      controller.abort();

      return Response.json({ sessionId: id });
    }).mockResolvedValue(Response.json({ status: 'closed' }));

    vi.stubGlobal('fetch', fetch);
    await expect(browserRun().acquire(context({ signal: controller.signal }))).rejects.toThrow(/cancelled; session released/);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(false);
  });

  it('treats expired sessions as released, but propagates deletion failures', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const provider = browserRun();
    const lease = { id, cdpEndpoint: 'wss://unused' };
    await provider.release(lease, context());
    await expect(provider.release(lease, context())).rejects.toThrow(/DELETE failed.*503/);
  });

  it('sweeps receipts written by another provider instance, without touching another run or target', async () => {
    const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) =>
      init.method === 'POST' ? Response.json({ sessionId: id }) : Response.json({ status: 'closed' }));

    vi.stubGlobal('fetch', fetch);
    await browserRun({ scope: 'attempt' }).acquire(context());
    const parent = browserRun({ scope: 'attempt' });
    expect(await parent.sweep!(context({ runId: 'another-run' }))).toEqual([]);
    expect(await parent.sweep!(context({ targetName: 'another-target' }))).toEqual([]);
    expect(await parent.sweep!(context())).toEqual([id]);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
    expect(await parent.sweep!(context())).toEqual([]);
  });

  it('keeps a failed deletion journaled for a later sweep', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ sessionId: id }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 404 }));

    vi.stubGlobal('fetch', fetch);
    const provider = browserRun();
    await provider.acquire(context());
    await expect(provider.sweep!(context())).rejects.toThrow('receipts kept for retry');
    expect(await provider.sweep!(context())).toEqual([id]);
  });

  it('lets the parent sweep an attempt acquired by a process that was killed', async () => {
    const request = context();

    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { browserRun } from ${JSON.stringify(new URL('../../src/index.ts', import.meta.url).href)};
      globalThis.fetch = async () => Response.json({ sessionId: ${JSON.stringify(id)} });
      await browserRun({ scope: 'attempt' }).acquire({
        ...${JSON.stringify({ ...request, signal: undefined, log: undefined })}, signal: new AbortController().signal, log() {},
      });
      process.stdout.write('leased');
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });

    const exited = once(child, 'exit');

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child acquisition timed out')), 5_000);
        child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('child acquisition failed')); });
        child.once('error', (cause) => { clearTimeout(timer); reject(cause); });
      });
      child.kill('SIGKILL');
      expect(await exited).toEqual([null, 'SIGKILL']);
      const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'closed' }));
      vi.stubGlobal('fetch', fetch);
      expect(await browserRun().sweep!(request)).toEqual([id]);
      expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`/${id}`), expect.objectContaining({ method: 'DELETE' }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('mints a read-only link for the exact page target only when opted in', async () => {
    expect(browserRun().onPage).toBeUndefined();
    const fetch = vi.fn().mockResolvedValue(Response.json({ devtoolsFrontendUrl: 'https://live.browser.run/ui/view?jwt=viewer-token' }));
    vi.stubGlobal('fetch', fetch);
    const page = { ...context(), attemptId: 'attempt', targetId: 'actual-incognito-tab' };
    await browserRun({ liveView: true }).onPage!({ id, cdpEndpoint: 'wss://example' }, page);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      mode: 'tab', targetId: 'actual-incognito-tab', expiresInMs: 300_000, guardrails: { mode: 'readonly' },
    });
    expect(page.log).toHaveBeenCalledWith(expect.stringContaining('watch at https://live.browser.run/'));
  });

  it('makes live-view failures nonfatal and never logs unexpected URL credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ devtoolsFrontendUrl: 'https://evil.example/?token=synthetic-secret' })));
    const page = { ...context(), attemptId: 'attempt', targetId: 'target' };
    await browserRun({ liveView: true }).onPage!({ id, cdpEndpoint: 'wss://example' }, page);
    expect(page.log).toHaveBeenCalledWith(`could not create live view for browser ${id}`);
    expect(JSON.stringify(vi.mocked(page.log).mock.calls)).not.toContain('synthetic-secret');
  });
});
