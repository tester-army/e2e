/**
 * `testmu().record()` against a fake TestMu AI sessions API behind a stubbed
 * `fetch`: the session it finds by build and name, the start time it takes
 * from it, the video it links, the endpoint override, and the failures it
 * names without leaking credentials or signed URLs.
 */

import type { DeviceLease } from '@e2e-dev/mobile';
import type { ProviderRecordContext } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testmu, type TestmuOptions } from '../../src/index.ts';

vi.mock('agent-device', () => ({
  createAgentDeviceClient: () => {
    throw new Error('recording starts no daemon');
  },
}));

const API = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';
const VIDEO = 'https://videos.example.com/orgId-1/T2/video/video.mp4?X-Amz-Signature=secret-signature';
const options: TestmuOptions = { device: 'Galaxy S22 Ultra 5G', osVersion: '14', app: 'lt://APP1' };
const env = { LT_USERNAME: 'ada', LT_ACCESS_KEY: 'lt-key' };
const lease: DeviceLease = {
  id: 'lease-1',
  client: { stateDir: '/work/.e2e/testmu/run-1', tenant: 'testmu', runId: 'run-1', leaseId: 'lease-1', providerBuild: 'run-1', providerSessionName: 'e2e-run-1-android-2' },
};

interface Call {
  readonly url: URL;
  readonly authorization: string | undefined;
}

const api = {
  calls: [] as Call[],
  /** Every session the build holds, newest first, as the list returns them. */
  sessions: [] as Record<string, unknown>[],
  /** Each session's details by `test_id`. */
  details: {} as Record<string, Record<string, unknown>>,
  /** A response the next request gets instead of the fake's own. */
  override: undefined as (() => Response | Promise<Response>) | undefined,
};

beforeEach(() => {
  Object.assign(api, {
    calls: [],
    sessions: [
      { test_id: 'T4', name: 'e2e-run-1-android-2', build_name: 'run-1', username: 'grace', start_timestamp: '2026-10-02T09:59:00Z' },
      { test_id: 'T3', name: 'e2e-run-1-android-1', build_name: 'run-1', username: 'ada', start_timestamp: '2026-10-02T09:58:05Z' },
      { test_id: 'T2', name: 'e2e-run-1-android-2', build_name: 'run-1', username: 'ada', start_timestamp: '2026-10-02T09:58:07Z' },
      { test_id: 'T1', name: 'e2e-run-1-android-2', build_name: 'run-1', username: 'ada', start_timestamp: '2026-10-01T08:00:00Z' },
    ],
    details: { T2: { test_id: 'T2', name: 'e2e-run-1-android-2', video_url: VIDEO }, T1: { test_id: 'T1', video_url: 'https://videos.example.com/old.mp4' } },
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
    const base = new URL(API).pathname;
    if (url.pathname === `${base}/sessions`) {
      const build = url.searchParams.get('build');
      const username = url.searchParams.get('username');
      const limit = Number(url.searchParams.get('limit') ?? '10');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const rows = api.sessions.filter((row) => row['build_name'] === build && (username === null || row['username'] === username)).slice(offset, offset + limit);
      // An empty page is Go's nil slice: `data: null`.
      return Response.json({ status: 'success', data: rows.length === 0 ? null : rows, message: 'Retrieve session list was successful', Meta: { result_set: { count: rows.length } } });
    }
    const id = decodeURIComponent(url.pathname.slice(`${base}/sessions/`.length));
    const details = api.details[id];
    if (details === undefined) return Response.json({ status: 'fail', message: 'Not found' }, { status: 404 });
    return Response.json({ status: 'success', data: details, message: 'Retrieve session was successful' });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function context(overrides: Partial<ProviderRecordContext> = {}): ProviderRecordContext {
  return { runId: 'run-1', targetName: 'android', attemptId: 'attempt-1', env, signal: new AbortController().signal, ...overrides };
}

const stopContext = (signal = new AbortController().signal) => ({ dir: '/work/.e2e/artifacts/attempt-1/video', signal });

/** The error `promise` rejects with; fails the test when it resolves. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (cause: unknown) => cause as Error,
  );
}

async function record(recordLease: DeviceLease = lease, recordContext: ProviderRecordContext = context()) {
  const provider = testmu(options);
  if (provider.record === undefined) throw new Error('testmu() records nothing');
  return provider.record(recordLease, recordContext);
}

describe('testmu().record()', () => {
  it("starts at the newest session's start time, found by the slot's name in the lease's build among the user's own, and links its video when it stops", async () => {
    const recording = await record();
    expect(recording.startedAt).toBe('2026-10-02T09:58:07.000Z');
    expect(api.calls.map((call) => call.url.href)).toEqual([`${API}/sessions?build=run-1&username=ada&limit=50&offset=0`]);
    await expect(recording.stop(stopContext())).resolves.toEqual({ url: VIDEO, mediaType: 'video/mp4' });
    expect(api.calls.map((call) => call.url.href)).toEqual([`${API}/sessions?build=run-1&username=ada&limit=50&offset=0`, `${API}/sessions/T2`]);
    expect(api.calls.map((call) => call.authorization)).toEqual([`Basic ${Buffer.from('ada:lt-key').toString('base64')}`, `Basic ${Buffer.from('ada:lt-key').toString('base64')}`]);
  });

  it.each([
    ['2026-10-02T09:58:07.25+05:30', '2026-10-02T04:28:07.250Z'],
    ['2026-10-02 09:58:07', '2026-10-02T09:58:07.000Z'],
  ])('reads the start time %s as %s, a time without a zone as UTC', async (start, iso) => {
    api.sessions[2]!['start_timestamp'] = start;
    expect((await record()).startedAt).toBe(iso);
  });

  it.each([undefined, null, '', 'yesterday', '2026-13-45T99:00:00Z'])('falls back to the moment it is called without a usable start time (%j)', async (start) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
    if (start === undefined) delete api.sessions[2]!['start_timestamp'];
    else api.sessions[2]!['start_timestamp'] = start;
    expect((await record()).startedAt).toBe('2026-10-02T10:00:00.000Z');
  });

  it('reads the lease after a round trip through JSON, as the worker gets it', async () => {
    const recording = await record(JSON.parse(JSON.stringify(lease)) as DeviceLease);
    await expect(recording.stop(stopContext())).resolves.toMatchObject({ url: VIDEO });
  });

  it('pages through a build holding more sessions than one page', async () => {
    api.sessions = [...Array.from({ length: 50 }, (_, index) => ({ test_id: `X${index}`, name: `other-${index}`, build_name: 'run-1', username: 'ada' })), ...api.sessions];
    await expect((await record()).stop(stopContext())).resolves.toMatchObject({ url: VIDEO });
    expect(api.calls.map((call) => call.url.searchParams.get('offset'))).toEqual(['0', '50', null]);
  });

  it('asks the API TESTMU_API_ENDPOINT names', async () => {
    const recording = await record(lease, context({ env: { ...env, TESTMU_API_ENDPOINT: 'https://stage-mobile-api.lambdatest.com/mobile-automation/api/v1/' } }));
    await expect(recording.stop(stopContext())).resolves.toMatchObject({ url: VIDEO });
    expect(api.calls.map((call) => call.url.href)).toEqual([
      'https://stage-mobile-api.lambdatest.com/mobile-automation/api/v1/sessions?build=run-1&username=ada&limit=50&offset=0',
      'https://stage-mobile-api.lambdatest.com/mobile-automation/api/v1/sessions/T2',
    ]);
  });

  it('fails to start, naming the build and the session, when the build has no session by that name', async () => {
    api.sessions = api.sessions.filter((row) => row['name'] !== 'e2e-run-1-android-2');
    await expect(record()).rejects.toThrow('TestMu AI has no session named "e2e-run-1-android-2" in build "run-1"');
  });

  it('names the session when its details carry no video URL', async () => {
    api.details['T2'] = { test_id: 'T2', video_url: 'not a url' };
    await expect((await record()).stop(stopContext())).rejects.toThrow('TestMu AI session T2 ("e2e-run-1-android-2", build "run-1") reports no video URL');
    delete api.details['T2']!['video_url'];
    await expect((await record()).stop(stopContext())).rejects.toThrow('reports no video URL');
  });

  it('reports an HTTP failure with its status and message, never the credentials or the request URL', async () => {
    api.override = () => Response.json({ status: 'fail', message: 'Unauthorized' }, { status: 401 });
    const error = await failure(record());
    expect(error.message).toBe('TestMu AI session lookup for build "run-1" failed: HTTP 401 (Unauthorized)');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('lt-key');
  });

  it('names the session when its details request fails', async () => {
    api.details = {};
    await expect((await record()).stop(stopContext())).rejects.toThrow('TestMu AI session T2 ("e2e-run-1-android-2", build "run-1") details failed: HTTP 404 (Not found)');
  });

  it('reports a response that is not JSON, or not a session list', async () => {
    api.override = () => new Response('<html>Bad gateway</html>', { status: 502 });
    await expect(record()).rejects.toThrow('TestMu AI session lookup for build "run-1" failed: HTTP 502, not JSON');
    api.override = () => Response.json({ status: 'success', data: { sessions: [] } });
    await expect(record()).rejects.toThrow('TestMu AI session lookup for build "run-1" failed: no session list in the response');
  });

  it('gives up on a request TestMu AI does not answer within 15 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
      api.calls.push({ url: new URL(input), authorization: undefined });
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    });
    const started = failure(record());
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await started).message).toBe('TestMu AI session lookup for build "run-1" got no answer within 15 s');
  });

  it('stops asking once the attempt or the stop is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(record(lease, context({ signal: controller.signal }))).rejects.toThrow('TestMu AI session lookup for build "run-1" cancelled');
    await expect((await record()).stop(stopContext(controller.signal))).rejects.toThrow('TestMu AI session T2 ("e2e-run-1-android-2", build "run-1") details cancelled');
  });

  it('refuses to start for a lease without a build and a session name', async () => {
    await expect(record({ id: 'other', client: { stateDir: '/tmp/x', providerBuild: 'run-1' } })).rejects.toThrow(
      'lease other carries no TestMu AI build and session name to find its recording by',
    );
  });

  it('refuses to start without credentials or with an endpoint that is not a URL', async () => {
    await expect(record(lease, context({ env: {} }))).rejects.toThrow('LT_USERNAME and LT_ACCESS_KEY are not set');
    await expect(record(lease, context({ env: { ...env, TESTMU_API_ENDPOINT: 'mobile-api' } }))).rejects.toThrow('TESTMU_API_ENDPOINT is not an http(s) URL');
    expect(api.calls).toEqual([]);
  });

  it('refuses an endpoint carrying credentials, without repeating them', async () => {
    for (const endpoint of ['https://ada:lt-key@mobile-api.lambdatest.com/mobile-automation/api/v1', 'https://lt-key@mobile-api.lambdatest.com']) {
      const error = await failure(record(lease, context({ env: { ...env, TESTMU_API_ENDPOINT: endpoint } })));
      expect(error).toMatchObject({ code: 'INVALID_CONFIG', message: 'TESTMU_API_ENDPOINT must not carry a username or password; set LT_USERNAME and LT_ACCESS_KEY instead' });
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('lt-key');
    }
    expect(api.calls).toEqual([]);
  });
});
