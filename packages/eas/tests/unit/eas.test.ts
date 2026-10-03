/**
 * `easSimulators()` against a fake Expo GraphQL API behind a stubbed
 * `fetch`: the create input, polling to ready and the queue line, the lease
 * and its log lines, stopping on release and after a failed or cancelled
 * start, the token or eas-cli login, the project id from the app config,
 * and the target's `app.appPath`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceReleaseContext, DeviceRequest } from '@e2e-dev/mobile';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  readonly session: string | undefined;
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
    const headers = init.headers as Record<string, string>;
    eas.calls.push({ operation, authorization: headers['Authorization'], session: headers['expo-session'], variables });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A home with no eas-cli login, so no test reads the real `~/.expo`. */
const emptyHome = mkdtempSync(join(tmpdir(), 'e2e-eas-home-'));
const homes: string[] = [emptyHome];

afterAll(() => {
  for (const path of homes) rmSync(path, { recursive: true, force: true });
});

/** A home where eas-cli keeps `state` under `directory`, as `eas login` writes it. */
function homeWith(state: string, directory = '.expo'): string {
  const path = mkdtempSync(join(tmpdir(), 'e2e-eas-home-'));
  homes.push(path);
  mkdirSync(join(path, directory));
  writeFileSync(join(path, directory, 'state.json'), state);
  return path;
}

const login = JSON.stringify({ auth: { sessionSecret: 'session-secret', userId: 'u1', username: 'ada', currentConnection: 'Browser-Flow-Authentication' } });

/** The run's home as the provider reads it on every platform: `HOME`, or `USERPROFILE` on Windows. */
function home(path: string): { HOME: string; USERPROFILE: string } {
  return { HOME: path, USERPROFILE: path };
}

/** An e2e project root holding `files`, each path relative to it; removed with the homes. */
function projectWith(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'e2e-eas-project-'));
  homes.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A project root with no app config, for the tests that pass `projectId`. */
const emptyProject = projectWith();

/**
 * A stand-in for the project's `expo` package whose `expo config` logs its
 * arguments and the `EXPO_NO_DOTENV` and `CI` it got to `expo-calls.txt`, then
 * runs `script`: by default it prints a config with `SHOP_PROJECT_ID` from its
 * environment as the project id.
 */
function fakeExpo(script = "process.stdout.write(JSON.stringify({ name: 'shop', extra: { eas: { projectId: process.env.SHOP_PROJECT_ID } } }));"): Record<string, string> {
  return {
    'node_modules/expo/package.json': JSON.stringify({ name: 'expo', version: '0.0.0' }),
    'node_modules/expo/bin/cli': `require('node:fs').appendFileSync('expo-calls.txt', [...process.argv.slice(2), 'EXPO_NO_DOTENV=' + process.env.EXPO_NO_DOTENV, 'CI=' + process.env.CI].join(' ') + '\\n');\n${script}\n`,
  };
}

const linked = (projectId: string) => JSON.stringify({ expo: { name: 'shop', extra: { eas: { projectId } } } });

const env = { EXPO_TOKEN: 'expo-test', ...home(emptyHome) };

/** Each test's own run: the provider tracks the ready sessions of a run across its instances. */
let runs = 0;

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    platform: 'ios',
    runId: `run-${++runs}`,
    targetName: 'ios',
    slot: 0,
    slots: 2,
    app: 'com.example.app',
    agentDeviceVersion: '0.21.18',
    projectRoot: emptyProject,
    env,
    signal: new AbortController().signal,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

function releaseContext(runId: string): DeviceReleaseContext {
  return { runId, targetName: 'ios', env, signal: new AbortController().signal, log: () => undefined };
}

const notFound = { message: 'Entity Not Found', extensions: { errorCode: 'NOT_FOUND_ERROR' } };

describe('easSimulators()', () => {
  it('starts an agent-device session named after the slot, tagged with the run, on the engine\'s agent-device, with the idle backstop', async () => {
    await easSimulators({ projectId: 'p1', buildId: 'b1', device: 'iPhone 17 Pro', tags: ['nightly'] }).acquire(request({ slot: 1, runId: 'run-1' }));
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
          packageVersion: '0.21.18',
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
    const req = request();
    const lease = await provider.acquire(req);
    await provider.release(lease, releaseContext(req.runId));
    expect(eas.calls.at(-1)).toEqual({ operation: 'stop', authorization: 'Bearer expo-test', variables: { id: 's1' } });
    eas.errors.stop = notFound;
    await expect(provider.release(lease, releaseContext(req.runId))).resolves.toBeUndefined();
    eas.errors.stop = { message: 'Internal error', extensions: { errorCode: 'INTERNAL_SERVER_ERROR' } };
    await expect(provider.release(lease, releaseContext(req.runId))).rejects.toThrow('EAS: Internal error');
  });

  it('cancels the job of a session stopped while queued, which would otherwise start later and hold a concurrent session', async () => {
    const provider = easSimulators({ projectId: 'p1' });
    const req = request();
    const lease = await provider.acquire(req);
    eas.stopJob = { id: 'j1', status: 'IN_QUEUE' };
    await provider.release(lease, releaseContext(req.runId));
    expect(eas.calls.slice(-2)).toEqual([
      { operation: 'stop', authorization: 'Bearer expo-test', variables: { id: 's1' } },
      { operation: 'cancel', authorization: 'Bearer expo-test', variables: { id: 'j1' } },
    ]);
    eas.calls = [];
    eas.stopJob = { id: 'j1', status: 'FINISHED' };
    await provider.release(lease, releaseContext(req.runId));
    expect(eas.calls.map((call) => call.operation)).toEqual(['stop']);
  });

  it('stops a session that ends before it is ready, and names it', async () => {
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'ERRORED' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow(`simulator session s1 did not become ready: session job errored; stopped it, ${SESSION_URL}`);
    expect(eas.calls.at(-1)?.operation).toBe('stop');
    eas.states = [{ ...READY, turtleJobRun: { status: 'FINISHED' } }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('did not become ready: session job finished; stopped it');
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

  it('gives up on a session still queued once another session of the run, from any target, has idled to the limit', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const ios = request({ runId: 'run-idle' });
    const iosProvider = easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 });
    const lease = await iosProvider.acquire(ios);
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 }).acquire(request({ runId: 'run-idle', platform: 'android', targetName: 'android', slots: 1 }))).rejects.toThrow(
      'simulator session s1 did not become ready: still queued while another session of this run idled to its `maxIdleTimeMinutes`, where EAS stops it; lower `workers` or raise `maxIdleTimeMinutes`; stopped it',
    );
    expect(eas.calls.at(-1)?.operation).toBe('stop');
    await iosProvider.release(lease, releaseContext('run-idle'));
  });

  it('measures a ready session by its own idle limit, not the queued one\'s', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const patient = easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 30 });
    const lease = await patient.acquire(request({ runId: 'run-limits' }));
    const queued = { status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null };
    eas.states = [...Array.from({ length: 10 }, () => queued), READY];
    await expect(easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 2 }).acquire(request({ runId: 'run-limits' }))).resolves.toMatchObject({ id: 's1' });
    await patient.release(lease, releaseContext('run-limits'));
  });

  it('keeps waiting however long it queues while no session of the run is ready, or after they were released', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    const queued = { status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null };
    eas.states = [...Array.from({ length: 20 }, () => queued), READY];
    await expect(easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 }).acquire(request())).resolves.toMatchObject({ id: 's1' });
    const provider = easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 5 });
    eas.states = [READY];
    const lease = await provider.acquire(request({ runId: 'run-released' }));
    await provider.release(lease, releaseContext('run-released'));
    eas.states = [...Array.from({ length: 20 }, () => queued), READY];
    await expect(provider.acquire(request({ runId: 'run-released' }))).resolves.toMatchObject({ id: 's1' });
  });

  it('keeps the idle limit below a short duration, as EAS requires, and pins the agent-device an option names', async () => {
    await easSimulators({ projectId: 'p1', maxDurationMinutes: 5, agentDeviceVersion: '0.22.0' }).acquire(request());
    expect(eas.calls[0]?.variables['input']).toMatchObject({ maxRunTimeMinutes: 5, maxIdleTimeMinutes: 4, packageVersion: '0.22.0' });
    eas.calls = [];
    await easSimulators({ projectId: 'p1', maxDurationMinutes: 1 }).acquire(request());
    expect(eas.calls[0]?.variables['input']).not.toHaveProperty('maxIdleTimeMinutes');
    expect(() => easSimulators({ projectId: 'p1', maxIdleTimeMinutes: 10, maxDurationMinutes: 10 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('`maxIdleTimeMinutes` must be below `maxDurationMinutes`') }),
    );
  });

  it('gives up on a session that boots for fifteen minutes after leaving the queue', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    eas.states = [{ status: 'NEW', turtleJobRun: { status: 'IN_QUEUE' }, remoteConfig: null }, { status: 'NEW', turtleJobRun: { status: 'IN_PROGRESS' }, remoteConfig: null }];
    await expect(easSimulators({ projectId: 'p1' }).acquire(request())).rejects.toThrow('did not become ready: still starting after 15 minutes; stopped it');
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

  it('fails without EXPO_TOKEN or an eas-cli login', async () => {
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: { EXPO_TOKEN: ' ', ...home(emptyHome) } }))).rejects.toThrow(
      'EXPO_TOKEN is not set and eas-cli is not logged in; run `eas login` or set EXPO_TOKEN',
    );
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: home(homeWith(JSON.stringify({ auth: null }))) }))).rejects.toThrow('eas-cli is not logged in');
    expect(eas.calls).toEqual([]);
  });

  it('authenticates with the eas-cli login when EXPO_TOKEN is not set', async () => {
    const loggedIn = home(homeWith(login));
    const provider = easSimulators({ projectId: 'p1' });
    const lease = await provider.acquire(request({ env: loggedIn }));
    await provider.release(lease, { ...releaseContext('run-login'), env: loggedIn });
    expect(eas.calls.map(({ operation, authorization, session }) => ({ operation, authorization, session }))).toEqual([
      { operation: 'create', authorization: undefined, session: 'session-secret' },
      { operation: 'state', authorization: undefined, session: 'session-secret' },
      { operation: 'stop', authorization: undefined, session: 'session-secret' },
    ]);
  });

  it('prefers EXPO_TOKEN to the eas-cli login', async () => {
    await easSimulators({ projectId: 'p1' }).acquire(request({ env: { EXPO_TOKEN: 'expo-test', ...home(homeWith(login)) } }));
    expect(eas.calls[0]).toMatchObject({ authorization: 'Bearer expo-test', session: undefined });
  });

  it("reads only eas-cli's production login, the one api.expo.dev accepts", async () => {
    const staging = home(homeWith(login, '.expo-staging'));
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: { EXPO_STAGING: '1', ...staging } }))).rejects.toThrow('eas-cli is not logged in');
    await easSimulators({ projectId: 'p1' }).acquire(request({ env: { EXPO_STAGING: '1', ...home(homeWith(login)) } }));
    expect(eas.calls[0]).toMatchObject({ operation: 'create', session: 'session-secret' });
  });

  it('stops a session as the login that started it, after eas logout', async () => {
    const provider = easSimulators({ projectId: 'p1' });
    const lease = await provider.acquire(request({ env: home(homeWith(login)) }));
    await provider.release(lease, { ...releaseContext('run-logout'), env: home(emptyHome) });
    expect(eas.calls.at(-1)).toMatchObject({ operation: 'stop', session: 'session-secret' });
  });

  it('keeps the login that started a session for a release that is tried again', async () => {
    const provider = easSimulators({ projectId: 'p1' });
    const lease = await provider.acquire(request({ env: home(homeWith(login)) }));
    eas.errors.stop = { message: 'Internal server error', extensions: { errorCode: 'INTERNAL_SERVER_ERROR' } };
    await expect(provider.release(lease, { ...releaseContext('run-release-retry'), env: home(emptyHome) })).rejects.toThrow('Internal server error');
    delete eas.errors.stop;
    await provider.release(lease, { ...releaseContext('run-release-retry'), env: home(emptyHome) });
    expect(eas.calls.filter((call) => call.operation === 'stop').map((call) => call.session)).toEqual(['session-secret', 'session-secret']);
  });

  it('names an eas-cli state file that is not JSON', async () => {
    const brokenHome = homeWith('{ "auth": "session-secret');
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: home(brokenHome) }))).rejects.toThrow(
      `the eas-cli login at ${join(brokenHome, '.expo', 'state.json')} is not valid JSON; run \`eas login\` again, or set EXPO_TOKEN`,
    );
    // The parse error quotes the text it failed on, the secret included, so it is not kept as the cause.
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ env: home(brokenHome) }))).rejects.toSatisfy((error: Error) => error.cause === undefined);
    expect(eas.calls).toEqual([]);
  });

  it('reads the project id from app.json when easSimulators() names none, once per run', async () => {
    const projectRoot = projectWith({ 'app.json': linked('from-app-json') });
    const provider = easSimulators({});
    await provider.acquire(request({ projectRoot, runId: 'run-once' }));
    writeFileSync(join(projectRoot, 'app.json'), linked('relinked'));
    await provider.acquire(request({ projectRoot, runId: 'run-once', slot: 1 }));
    await provider.acquire(request({ projectRoot, runId: 'run-next' }));
    expect(eas.calls.filter((call) => call.operation === 'create').map((call) => (call.variables['input'] as { appId: string }).appId)).toEqual(['from-app-json', 'from-app-json', 'relinked']);
  });

  it('reads the app config again after a read that failed, in the same run', async () => {
    const projectRoot = projectWith({ 'app.json': JSON.stringify({ expo: { name: 'shop' } }) });
    const provider = easSimulators({});
    await expect(provider.acquire(request({ projectRoot, runId: 'run-config-retry' }))).rejects.toThrow('has no `extra.eas.projectId`');
    writeFileSync(join(projectRoot, 'app.json'), linked('after-eas-init'));
    await provider.acquire(request({ projectRoot, runId: 'run-config-retry', slot: 1 }));
    expect(eas.calls[0]?.variables['input']).toMatchObject({ appId: 'after-eas-init' });
  });

  it('stops reading the app config when the run is interrupted', async () => {
    await expect(easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.json': linked('p1') }), signal: AbortSignal.abort() }))).rejects.toThrow(
      'could not read the Expo app config at',
    );
    expect(eas.calls).toEqual([]);
  });

  it('names the engine to upgrade when it passes no project root', async () => {
    await expect(easSimulators({}).acquire(request({ projectRoot: undefined as unknown as string }))).rejects.toThrow(
      'reading `projectId` from the app config needs an @e2e-dev/mobile that passes `projectRoot` to device providers; upgrade it, or pass `projectId`',
    );
    expect(eas.calls).toEqual([]);
  });

  it('reads app.config.json before app.json, and a config without an expo key as the whole config', async () => {
    const projectRoot = projectWith({ 'app.config.json': JSON.stringify({ extra: { eas: { projectId: ' flat ' } } }), 'app.json': linked('from-app-json') });
    await easSimulators({}).acquire(request({ projectRoot }));
    expect(eas.calls[0]?.variables['input']).toMatchObject({ appId: 'flat' });
  });

  it('prefers the projectId option to the app config', async () => {
    await easSimulators({ projectId: 'p1' }).acquire(request({ projectRoot: projectWith({ 'app.json': linked('from-app-json') }) }));
    expect(eas.calls[0]?.variables['input']).toMatchObject({ appId: 'p1' });
  });

  it("evaluates a dynamic app config with the project's own expo config, in the run's environment without .env files, once per run across targets", async () => {
    const projectRoot = projectWith({ 'app.config.ts': 'export default {};', 'app.json': linked('stale'), ...fakeExpo() });
    const runEnv = { ...env, SHOP_PROJECT_ID: 'from-expo-config' };
    // Two targets of one run, each with its own provider, and two slots of the first.
    const [ios, android] = [easSimulators({}), easSimulators({})];
    await Promise.all([
      ios.acquire(request({ projectRoot, env: runEnv, runId: 'run-dynamic', slot: 0 })),
      ios.acquire(request({ projectRoot, env: runEnv, runId: 'run-dynamic', slot: 1 })),
      android.acquire(request({ projectRoot, env: runEnv, runId: 'run-dynamic', platform: 'android', targetName: 'android' })),
    ]);
    expect(eas.calls.filter((call) => call.operation === 'create').map((call) => (call.variables['input'] as { appId: string }).appId)).toEqual(['from-expo-config', 'from-expo-config', 'from-expo-config']);
    expect(readFileSync(join(projectRoot, 'expo-calls.txt'), 'utf8')).toBe('config --json --type public EXPO_NO_DOTENV=1 CI=undefined\n');
  });

  it('names what is missing when the app config links no project, and starts no session', async () => {
    const pass = 'pass `projectId` to easSimulators(), or run `eas init` to link the app to an EAS project';
    const empty = projectWith();
    await expect(easSimulators({}).acquire(request({ projectRoot: empty }))).rejects.toThrow(`no Expo app config (app.json or app.config.*) in ${empty}; ${pass}`);
    await expect(easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.json': JSON.stringify({ expo: { name: 'shop' } }) }) }))).rejects.toThrow(
      `app.json has no \`extra.eas.projectId\`; ${pass}`,
    );
    await expect(easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.json': '{ "expo": ' }) }))).rejects.toThrow('could not read the Expo app config at');
    await expect(easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.config.js': 'module.exports = {};' }) }))).rejects.toThrow(
      'is dynamic and `expo` is not installed there to evaluate it',
    );
    await expect(easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.config.js': '', ...fakeExpo("process.stdout.write('{}');") }) }))).rejects.toThrow(
      `app.config.js (through \`expo config\`) has no \`extra.eas.projectId\`; ${pass}`,
    );
    await expect(
      easSimulators({}).acquire(request({ projectRoot: projectWith({ 'app.config.js': '', ...fakeExpo("process.stderr.write('Cannot find module ./secret'); process.exit(1);") }) })),
    ).rejects.toThrow('`expo config` failed in');
    expect(eas.calls).toEqual([]);
  });

  it("refuses the target's app.appPath for an app EAS already installs, and two app sources", async () => {
    await expect(easSimulators({ projectId: 'p1', buildId: 'b1' }).acquire(request({ appPath: '/builds/App.app' }))).rejects.toThrow("leave the target's `app.appPath` out");
    expect(eas.calls).toEqual([]);
    await expect(easSimulators({ projectId: 'p1' }).acquire(request({ appPath: '/builds/App.app' }))).resolves.toMatchObject({ id: 's1' });
    expect(() => easSimulators({ projectId: 'p1', buildId: 'b1', applicationArchiveUrl: 'https://example.com/App.tar.gz' })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('not both') }),
    );
  });

  it('rejects an option it does not know, naming the nearest', () => {
    expect(() => easSimulators({ projectId: 'p1', buildID: 'b1' } as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: 'easSimulators() has unknown key "buildID"; did you mean "buildId"?' }),
    );
  });
});
