/**
 * `browserstack().record()` against a fake App Automate API behind a stubbed
 * `fetch`: the build and session it finds by name, the start time it takes
 * from it, the video it links once the session ends, the endpoint override,
 * and the failures it names without leaking credentials or signed URLs.
 */

import type { DeviceLease } from '@e2e-dev/mobile';
import type { ProviderRecordContext } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserstack, type BrowserStackOptions } from '../../src/index.ts';

const API = 'https://api-cloud.browserstack.com/app-automate';
const VIDEO = 'https://app-automate.browserstack.com/sessions/S2/video?token=secret-token';
const options: BrowserStackOptions = { device: 'Google Pixel 9', osVersion: '16.0', app: 'bs://APP1' };
const env = { BROWSERSTACK_USERNAME: 'ada', BROWSERSTACK_ACCESS_KEY: 'bs-key' };
const lease: DeviceLease = {
  id: 'lease-1',
  client: { stateDir: '/work/state', tenant: 'browserstack', runId: 'run-1', leaseId: 'lease-1', providerBuild: 'run-1', providerSessionName: 'e2e-run-1-android-2' },
};

interface Call {
  readonly url: URL;
  readonly authorization: string | undefined;
}

const api = {
  calls: [] as Call[],
  /** Every build, newest first, as the list returns them. */
  builds: [] as Record<string, unknown>[],
  /** Each build's sessions by `hashed_id`, newest first. */
  sessions: {} as Record<string, Record<string, unknown>[]>,
  /** A response the next request gets instead of the fake's own. */
  override: undefined as (() => Response | Promise<Response>) | undefined,
};

function page<T>(rows: T[], url: URL): T[] {
  const limit = Number(url.searchParams.get('limit'));
  const offset = Number(url.searchParams.get('offset'));
  return rows.slice(offset, offset + limit);
}

beforeEach(() => {
  Object.assign(api, {
    calls: [],
    builds: [
      { automation_build: { name: 'run-2', hashed_id: 'B3' } },
      { automation_build: { name: 'run-1', hashed_id: 'B2' } },
      { automation_build: { name: 'run-1', hashed_id: 'B1' } },
    ],
    sessions: {
      B2: [
        { automation_session: { name: 'e2e-run-1-android-1', hashed_id: 'S3', created_at: '2026-10-21T09:58:05.000Z', video_url: 'https://app-automate.browserstack.com/sessions/S3/video' } },
        { automation_session: { name: 'e2e-run-1-android-2', hashed_id: 'S2', created_at: '2026-10-21T09:58:07.000Z', video_url: VIDEO } },
      ],
      B1: [{ automation_session: { name: 'e2e-run-1-android-2', hashed_id: 'S1', created_at: '2026-10-20T08:00:00.000Z', video_url: 'https://example.com/old' } }],
    },
    override: undefined,
  });
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    api.calls.push({ url, authorization: (init.headers as Record<string, string> | undefined)?.['Authorization'] });
    init.signal?.throwIfAborted();
    const override = api.override;
    if (override !== undefined) {
      api.override = undefined;
      return override();
    }
    if (url.pathname.endsWith('/builds.json')) return Response.json(page(api.builds, url));
    const build = /\/builds\/([^/]+)\/sessions\.json$/.exec(url.pathname)?.[1];
    if (build !== undefined) return Response.json(page(api.sessions[build] ?? [], url));
    return Response.json({ message: 'not found' }, { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

function context(overrides: Partial<ProviderRecordContext> = {}): ProviderRecordContext {
  return { env, signal: new AbortController().signal, ...overrides } as ProviderRecordContext;
}

async function record(target = lease, ctx = context()) {
  return browserstack(options).record!(target, ctx);
}

describe('browserstack().record()', () => {
  it("finds the newest build and the slot's session by name, and starts the video when the session did", async () => {
    const recording = await record();
    expect(recording.startedAt).toBe('2026-10-21T09:58:07.000Z');
    await expect(recording.stop({ signal: new AbortController().signal, dir: '/tmp' })).resolves.toEqual({ url: VIDEO, mediaType: 'video/mp4' });
    expect(api.calls.map(({ url }) => `${url.pathname}?${url.searchParams.toString()}`)).toEqual([
      '/app-automate/builds.json?limit=50&offset=0',
      '/app-automate/builds/B2/sessions.json?limit=50&offset=0',
      '/app-automate/builds.json?limit=50&offset=0',
      '/app-automate/builds/B2/sessions.json?limit=50&offset=0',
    ]);
    expect(new Set(api.calls.map(({ authorization }) => authorization))).toEqual(new Set([`Basic ${Buffer.from('ada:bs-key').toString('base64')}`]));
  });

  it('finds the session in an older build of the same name, as another project of the run holds it', async () => {
    api.sessions['B2'] = [];
    const recording = await record();
    expect(recording.startedAt).toBe('2026-10-20T08:00:00.000Z');
    expect(api.calls.map(({ url }) => url.pathname)).toEqual(['/app-automate/builds.json', '/app-automate/builds/B2/sessions.json', '/app-automate/builds/B1/sessions.json']);
  });

  it('reads further pages of builds until it finds the one named', async () => {
    api.builds = [...Array.from({ length: 50 }, (_, i) => ({ automation_build: { name: `other-${i}`, hashed_id: `X${i}` } })), ...api.builds];
    await expect(record()).resolves.toMatchObject({ startedAt: '2026-10-21T09:58:07.000Z' });
    expect(api.calls.filter(({ url }) => url.pathname.endsWith('/builds.json')).map(({ url }) => url.searchParams.get('offset'))).toEqual(['0', '50']);
  });

  it('reads the video when the session ends, not when recording starts', async () => {
    const [, second] = api.sessions['B2']!;
    (second!['automation_session'] as Record<string, unknown>)['video_url'] = null;
    const recording = await record();
    (second!['automation_session'] as Record<string, unknown>)['video_url'] = VIDEO;
    await expect(recording.stop({ signal: new AbortController().signal, dir: '/tmp' })).resolves.toEqual({ url: VIDEO, mediaType: 'video/mp4' });
  });

  it('names the session that reports no video', async () => {
    (api.sessions['B2']![1]!['automation_session'] as Record<string, unknown>)['video_url'] = 'not a url';
    const recording = await record();
    await expect(recording.stop({ signal: new AbortController().signal, dir: '/tmp' })).rejects.toThrow('BrowserStack session S2 ("e2e-run-1-android-2", build "run-1") reports no video URL');
  });

  it('takes the moment recording was asked for when the session has no start time', async () => {
    (api.sessions['B2']![1]!['automation_session'] as Record<string, unknown>)['created_at'] = null;
    const before = Date.now();
    const { startedAt } = await record();
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before);
  });

  it('names a build or session it cannot find', async () => {
    await expect(record({ ...lease, client: { ...lease.client, providerBuild: 'run-9' } })).rejects.toThrow('BrowserStack has no build named "run-9"');
    await expect(record({ ...lease, client: { ...lease.client, providerSessionName: 'nope' } })).rejects.toThrow('BrowserStack has no session named "nope" in build "run-1"');
  });

  it('refuses a lease without the build and session name acquire put on it', async () => {
    await expect(record({ id: 'lease-9', client: { stateDir: '/x' } })).rejects.toThrow('lease lease-9 carries no BrowserStack build and session name to find its recording by');
  });

  it('reports an HTTP failure with the status and message, never the credentials', async () => {
    api.override = () => Response.json({ message: 'Unauthorized' }, { status: 401 });
    const error = await record().then(() => new Error('resolved'), (cause: unknown) => cause as Error);
    expect(error.message).toBe('BrowserStack build lookup for "run-1" failed: HTTP 401 (Unauthorized)');
    expect(error.message).not.toContain('bs-key');
  });

  it('reports a response that is not JSON or not a list', async () => {
    api.override = () => new Response('<html>', { status: 502 });
    await expect(record()).rejects.toThrow('BrowserStack build lookup for "run-1" failed: HTTP 502, not JSON');
    api.override = () => Response.json({ builds: [] });
    await expect(record()).rejects.toThrow('BrowserStack build lookup for "run-1" failed: no list in the response');
  });

  it('fails before any request without credentials', async () => {
    await expect(record(lease, context({ env: {} }))).rejects.toThrow('BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are not set');
    expect(api.calls).toEqual([]);
  });

  it('uses BROWSERSTACK_API_ENDPOINT when set, and refuses one that is not http(s) or carries credentials', async () => {
    await record(lease, context({ env: { ...env, BROWSERSTACK_API_ENDPOINT: 'https://proxy.example.com/app-automate/' } }));
    expect(api.calls[0]!.url.href).toBe('https://proxy.example.com/app-automate/builds.json?limit=50&offset=0');
    await expect(record(lease, context({ env: { ...env, BROWSERSTACK_API_ENDPOINT: 'ftp://x' } }))).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'BROWSERSTACK_API_ENDPOINT is not an http(s) URL' }),
    );
    await expect(record(lease, context({ env: { ...env, BROWSERSTACK_API_ENDPOINT: 'https://u:p@proxy.example.com' } }))).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('must not carry a username or password') }),
    );
    expect(API).toBe('https://api-cloud.browserstack.com/app-automate');
  });

  it('stops looking once the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(record(lease, context({ signal: controller.signal }))).rejects.toThrow('BrowserStack build lookup for "run-1" cancelled');
  });
});

describe('uploadAppFromUrl()', () => {
  it('posts the URL as a form to the upload endpoint and returns the bs:// id', async () => {
    const { uploadAppFromUrl } = await import('../../src/sessions.ts');
    const seen: { url: string; method: string | undefined; field: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(input), method: init.method, field: (init.body as FormData).get('url') });
      return Response.json({ app_url: 'bs://NEW' });
    });
    await expect(uploadAppFromUrl(API, { username: 'ada', accessKey: 'bs-key' }, 'https://example.com/app.apk', new AbortController().signal)).resolves.toBe('bs://NEW');
    expect(seen).toEqual([{ url: `${API}/upload`, method: 'POST', field: 'https://example.com/app.apk' }]);
  });

  it('reports a rejected upload with its message, and an answer without a bs:// id', async () => {
    const { uploadAppFromUrl } = await import('../../src/sessions.ts');
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Invalid file format' }, { status: 422 }));
    await expect(uploadAppFromUrl(API, { username: 'ada', accessKey: 'bs-key' }, 'https://example.com/x', new AbortController().signal)).rejects.toThrow('BrowserStack app upload from a URL failed: HTTP 422 (Invalid file format)');
    vi.stubGlobal('fetch', async () => Response.json({ app_url: 'https://nope' }));
    await expect(uploadAppFromUrl(API, { username: 'ada', accessKey: 'bs-key' }, 'https://example.com/x', new AbortController().signal)).rejects.toThrow('BrowserStack app upload from a URL failed: no bs:// app id in the response');
  });

  it('never repeats a signed app URL the API echoes in an error', async () => {
    const { uploadAppFromUrl } = await import('../../src/sessions.ts');
    const signed = 'https://bucket.example.com/app.apk?X-Amz-Signature=secret-signature&X-Amz-Expires=600';
    vi.stubGlobal('fetch', async () => Response.json({ error: `Could not download ${signed} (${encodeURIComponent(signed)})` }, { status: 422 }));
    const error = await uploadAppFromUrl(API, { username: 'ada', accessKey: 'bs-key' }, signed, new AbortController().signal).then(() => new Error('resolved'), (cause: unknown) => cause as Error);
    expect(error.message).toBe('BrowserStack app upload from a URL failed: HTTP 422 (Could not download <app URL> (<app URL>))');
    expect(error.message).not.toContain('secret-signature');
  });

  it('keeps a signed app URL out of a transport error and its cause', async () => {
    const { uploadAppFromUrl } = await import('../../src/sessions.ts');
    const signed = 'https://bucket.example.com/app.apk?X-Amz-Signature=secret-signature';
    vi.stubGlobal('fetch', async () => { throw new TypeError(`fetch failed for ${signed}`); });
    const error = await uploadAppFromUrl(API, { username: 'ada', accessKey: 'bs-key' }, signed, new AbortController().signal).then(() => new Error('resolved'), (cause: unknown) => cause as Error);
    expect(error.message).toBe('BrowserStack app upload from a URL failed: fetch failed for <app URL>');
    expect(String((error.cause as Error).message)).toBe('fetch failed for <app URL>');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('secret-signature');
  });
});

