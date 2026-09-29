/**
 * `easSimulators()` against a fake Expo GraphQL API behind a stubbed
 * `fetch`: the create input, polling to ready and the queue line, the lease
 * and its log lines, stopping on release and after a failed or cancelled
 * start, the token, and `appPath`.
 */

import type { DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { easSimulators } from '../../src/index.ts';

vi.mock('node:timers/promises', () => ({
  setTimeout: async (_ms: number, value: unknown, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    return value;
  },
}));

type Operation = 'create' | 'state' | 'stop' | 'cancel';

interface Call {
  readonly operation: Operation;
  readonly authorization: string | undefined;
  readonly variables: Record<string, unknown>;
}

const READY = {
  status: 'IN_PROGRESS',
  turtleJobRun: { status: 'IN_PROGRESS' },
  remoteConfig: {
    agentDeviceRemoteSessionUrl: 'https://agent-device-s1.eas-simulator.ngrok.dev',
    agentDeviceRemoteSessionToken: 'daemon-token',
    webPreviewUrl: 'https://expo.dev/simulator-preview/s1',
  },
};

const eas = {
  calls: [] as Call[],
  /** What each state query returns, in order; the last one repeats. */
  states: [] as Record<string, unknown>[],
  /** A GraphQL error an operation answers with instead of data. */
  errors: {} as Partial<Record<Operation, { message: string; extensions: { errorCode: string } }>>,
  onState: undefined as (() => void) | undefined,
  onCreate: undefined as (() => void) | undefined,
  /** State polls that answer with a 502 page before the fake answers again. */
  stateOutages: 0,
  /** The session's job as the stop mutation reports it. */
  stopJob: { id: 'j1', status: 'IN_PROGRESS' } as { id: string; status: string } | null,
};

const SESSION_URL = 'https://expo.dev/accounts/acme/projects/shop/simulator-sessions/s1';

beforeEach(() => {
  Object.assign(eas, { calls: [], states: [READY], errors: {}, onState: undefined, onCreate: undefined, stateOutages: 0, stopJob: { id: 'j1', status: 'IN_PROGRESS' } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.expo.dev/graphql');
    const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    const operation: Operation = query.includes('createDeviceRunSession')
      ? 'create'
      : query.includes('ensureDeviceRunSessionStopped')
        ? 'stop'
        : query.includes('cancelJobRun')
          ? 'cancel'
          : 'state';
    eas.calls.push({ operation, authorization: (init.headers as Record<string, string>)['Authorization'], variables });
    init.signal?.throwIfAborted();
    const error = eas.errors[operation];
    if (error !== undefined) return Response.json({ errors: [error], data: null });
    if (operation === 'create') eas.onCreate?.();
    if (operation === 'state' && eas.stateOutages > 0) {
      eas.stateOutages -= 1;
      return new Response('Bad gateway', { status: 502 });
    }
    if (operation === 'create') return Response.json({ data: { deviceRunSession: { createDeviceRunSession: { id: 's1', app: { slug: 'shop', ownerAccount: { name: 'acme' } } } } } });
    if (operation === 'stop') return Response.json({ data: { deviceRunSession: { ensureDeviceRunSessionStopped: { turtleJobRun: eas.stopJob } } } });
    if (operation === 'cancel') return Response.json({ data: { jobRun: { cancelJobRun: { id: variables['id'] } } } });
    eas.onState?.();
    const next = eas.states.length > 1 ? eas.states.shift() : eas.states[0];
    return Response.json({ data: { deviceRunSessions: { byId: next } } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = { EXPO_TOKEN: 'expo-test' };

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    platform: 'ios',
    runId: 'run-1',
    targetName: 'ios',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(): DeviceReleaseContext {
  return { runId: 'run-1', targetName: 'ios', env, signal: new AbortController().signal, log: () => undefined };
}

const notFound = { message: 'Entity Not Found', extensions: { errorCode: 'NOT_FOUND_ERROR' } };

describe('easSimulators()', () => {
  it('is a device provider named eas-simulators that leaves recording to agent-device', () => {
    const provider = easSimulators({ projectId: 'p1' });
    expect(provider.name).toBe('eas-simulators');
    expect(provider.record).toBeUndefined();
  });

  it('starts an agent-device session named after the slot, tagged with the run, with the idle backstop', async () => {
    await easSimulators({ projectId: 'p1', buildId: 'b1', device: 'iPhone 17 Pro', tags: ['nightly'] }).acquire(request({ slot: 1 }));
    expect(eas.calls[0]).toEqual({
      operation: 'create',
      authorization: 'Bearer expo-test',
      variables: {
        input: {
          appId: 'p1',
          platform: 'IOS',
          type: 'AGENT_DEVICE',
          name: 'e2e ios 2 of 2',
          tags: ['nightly', 'e2e', 'e2e-run:run-1', 'e2e-target:ios'],
          buildId: 'b1',
          ios: { deviceIdentifier: 'iPhone 17 Pro' },
          maxIdleTimeMinutes: 10,
        },
      },
    });
  });

  it('names an Android emulator under android and passes an archive URL, idle time, and duration through', async () => {
    await easSimulators({ projectId: 'p1', applicationArchiveUrl: 'https://example.com/app.apk', device: 'pixel_9', maxIdleTimeMinutes: 30, maxDurationMinutes: 60 }).acquire(
      request({ platform: 'android' }),
    );
    expect(eas.calls[0]?.variables['input']).toMatchObject({
      platform: 'ANDROID',
      android: { deviceIdentifier: 'pixel_9' },
      applicationArchiveUrl: 'https://example.com/app.apk',
      maxIdleTimeMinutes: 30,
      maxRunTimeMinutes: 60,
    });
    expect(eas.calls[0]?.variables['input']).not.toHaveProperty('ios');
  });

  it('leases a session whose queue was brief without a queue line', async () => {
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'NEW' }, remoteConfig: null }, { status: 'NEW', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: null }, READY];
    const req = request();
    await easSimulators({ projectId: 'p1' }).acquire(req);
    expect(req.lines).toEqual([`simulator session s1, ${SESSION_URL}`, 'watch at https://expo.dev/simulator-preview/s1']);
  });

  it('leaves a preview that needs a token out of the log', async () => {
    eas.states = [{ ...READY, remoteConfig: { ...READY.remoteConfig, webPreviewToken: 'preview-secret' } }];
    const req = request();
    await easSimulators({ projectId: 'p1' }).acquire(req);
    expect(req.lines).toEqual([`simulator session s1, ${SESSION_URL}`]);
  });

  it('polls until the daemon is reachable and leases it, saying once that it has waited in the queue for two minutes', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 50_000));
    const queued = { status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null };
    eas.states = [queued, queued, queued, queued, { status: 'NEW', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: null }, READY];
    const req = request();
    const lease = await easSimulators({ projectId: 'p1' }).acquire(req);
    vi.restoreAllMocks();
    expect(lease).toEqual({ id: 's1', daemon: { baseUrl: 'https://agent-device-s1.eas-simulator.ngrok.dev', authToken: 'daemon-token' } });
    expect(eas.calls.map((call) => call.operation)).toEqual(['create', 'state', 'state', 'state', 'state', 'state', 'state']);
    expect(eas.calls[1]?.variables).toEqual({ id: 's1' });
    expect(req.lines).toEqual([
      `simulator session s1, ${SESSION_URL}`,
      'still queued at EAS after two minutes; tests start once every worker has a simulator',
      'watch at https://expo.dev/simulator-preview/s1',
    ]);
  });

  it('stops the session on release, and one EAS no longer knows counts as stopped', async () => {
    const provider = easSimulators({ projectId: 'p1' });
    const lease = await provider.acquire(request());
    await provider.release(lease, releaseContext());
    expect(eas.calls.at(-1)).toEqual({ operation: 'stop', authorization: 'Bearer expo-test', variables: { id: 's1' } });
    eas.errors.stop = notFound;
    await expect(provider.release(lease, releaseContext())).resolves.toBeUndefined();
    eas.errors.stop = { message: 'Internal error', extensions: { errorCode: 'INTERNAL_SERVER_ERROR' } };
    await expect(provider.release(lease, releaseContext())).rejects.toThrow('EAS: Internal error');
  });

  it('cancels the job of a session stopped while queued, which would otherwise start later and hold a concurrent session', async () => {
    const provider = easSimulators({ projectId: 'p1' });
    const lease = await provider.acquire(request());
    eas.stopJob = { id: 'j1', status: 'IN_QUEUE' };
    await provider.release(lease, releaseContext());
    expect(eas.calls.slice(-2)).toEqual([
      { operation: 'stop', authorization: 'Bearer expo-test', variables: { id: 's1' } },
      { operation: 'cancel', authorization: 'Bearer expo-test', variables: { id: 'j1' } },
    ]);
    eas.calls = [];
    eas.stopJob = { id: 'j1', status: 'FINISHED' };
    await provider.release(lease, releaseContext());
    expect(eas.calls.map((call) => call.operation)).toEqual(['stop']);
  });

  it('stops a session that ends before it is ready, and names it', async () => {
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'ERRORED' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow(`simulator session s1 did not become ready: session job errored; stopped it, ${SESSION_URL}`);
    expect(eas.calls.at(-1)?.operation).toBe('stop');
    eas.states = [{ status: 'ERRORED', turtleJobRun: null, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('did not become ready: session errored; stopped it');
  });

  it('stops a session whose request was cancelled while it started, and says when stopping failed too', async () => {
    const controller = new AbortController();
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null }];
    eas.onState = () => controller.abort();
    eas.errors.stop = { message: 'Service unavailable', extensions: { errorCode: 'INTERNAL_SERVER_ERROR' } };
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ signal: controller.signal }))).rejects.toThrow(
      `simulator session s1 did not become ready: cancelled; stopping it failed, so EAS stops it at its idle or duration limit (EAS: Service unavailable), ${SESSION_URL}`,
    );
    expect(eas.calls.at(-1)?.operation).toBe('stop');
  });

  it('gives up on a session queued longer than the idle limit, which would already have stopped its siblings', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 }).acquire(request())).rejects.toThrow(
      'simulator session s1 did not become ready: still queued after 5 minutes, the idle limit that stops the sessions leased before it; lower `workers` or raise `maxIdleTimeMinutes`; stopped it',
    );
    vi.restoreAllMocks();
    expect(eas.calls.at(-1)?.operation).toBe('stop');
  });

  it('keeps waiting on a lone slot however long it queues, since no sibling goes idle', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const queued = { status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null };
    eas.states = [...Array.from({ length: 20 }, () => queued), READY];
    await expect(easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 }).acquire(request({ slots: 1 }))).resolves.toMatchObject({ id: 's1' });
    vi.restoreAllMocks();
  });

  it('gives up on a session that boots for fifteen minutes after leaving the queue', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null }, { status: 'NEW', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('did not become ready: still starting after 15 minutes; stopped it');
    vi.restoreAllMocks();
  });

  it('rides out a few failed polls, and gives up after more in a row', async () => {
    eas.stateOutages = 3;
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).resolves.toMatchObject({ id: 's1' });
    eas.stateOutages = 4;
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('did not become ready: EAS: HTTP 502, Bad gateway; stopped it');
  });

  it('stops a session EAS created while the request was cancelled', async () => {
    const controller = new AbortController();
    eas.onCreate = () => controller.abort();
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ signal: controller.signal }))).rejects.toThrow('simulator session s1 did not become ready: cancelled; stopped it');
    expect(eas.calls.map((call) => call.operation)).toEqual(['create', 'state', 'stop']);
  });

  it('surfaces an EAS error with its message', async () => {
    eas.errors.create = { message: 'Device run sessions are not enabled for this account', extensions: { errorCode: 'FORBIDDEN' } };
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('EAS: Device run sessions are not enabled for this account');
  });

  it('names a response that is not GraphQL by its status', async () => {
    vi.stubGlobal('fetch', async () => new Response('Bad gateway', { status: 502 }));
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('EAS: HTTP 502, Bad gateway');
  });

  it('fails without EXPO_TOKEN in the run environment', async () => {
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: { EXPO_TOKEN: ' ' } }))).rejects.toThrow('EXPO_TOKEN is not set');
    expect(eas.calls).toEqual([]);
  });

  it('refuses the engine installing an app EAS already installs, and two app sources', async () => {
    await expect(easSimulators({ projectId: 'p1', buildId: 'b1' }).acquire(request({ appPath: '/builds/App.app' }))).rejects.toThrow("leave the engine's `appPath` out");
    expect(eas.calls).toEqual([]);
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ appPath: '/builds/App.app' }))).resolves.toMatchObject({ id: 's1' });
    expect(() => easSimulators({ projectId: 'p1', buildId: 'b1', applicationArchiveUrl: 'https://example.com/App.tar.gz' })).toThrow('not both');
  });
});
