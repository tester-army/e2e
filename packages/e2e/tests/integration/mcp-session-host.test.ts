/**
 * The session host in-process on the fake engine: the headed flag reaches the
 * engine, an idle session closes itself, the TTL ends a session through the
 * step's own deadline, sessions open side by side up to the limit, hold their
 * engine and config until their attempt is gone, and share one app process,
 * a shutdown waits for sessions still opening, an `open_session` that fails
 * after the attempt opened tears the attempt down and leaves the host ready
 * for the next one, and a session records video only when the agent asks.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine, type FakeEngineBehavior, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { gate } from '../helpers/gate.ts';
import { startupLog, writeStartupScripts } from '../helpers/startup-scripts.ts';
import type { RecordingMode } from '../../src/types.ts';

const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');
const resolveModule = new URL('../../dist/config/resolve.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve.ts');
const secretsModule = new URL('../../dist/secrets.js', import.meta.url).href;
const { credentials, secrets } = (await import(secretsModule)) as typeof import('../../src/secrets.ts');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fake engines made one per loaded config, as a config file loaded afresh
 * makes them: the nth load gets the nth behavior, the last one repeating.
 */
function engines(...behaviors: FakeEngineBehavior[]): { readonly next: () => FakeEngineHandle; readonly made: FakeEngineHandle[] } {
  const made: FakeEngineHandle[] = [];
  const next = (): FakeEngineHandle => {
    const handle = createFakeEngine(behaviors[Math.min(made.length, behaviors.length - 1)] ?? {});
    made.push(handle);
    return handle;
  };
  return { next, made };
}

describe('SessionHost', { timeout: 60_000 }, () => {
  let dir: string;
  let logs: string[];

  interface HostOptions {
    readonly headed?: boolean;
    readonly idleMs?: number;
    readonly ttlMs?: number;
    readonly maxSessions?: number;
    readonly trace?: RecordingMode;
    readonly video?: RecordingMode;
    /** Holds every config load until it settles. */
    readonly loaded?: Promise<void>;
    /** Runs while a config file evaluates, as its top-level code would. */
    readonly evaluate?: (configPath: string) => void;
  }

  /**
   * A host whose configs take their engine from `engine`, called once per
   * load: `() => fake` shares one instance across sessions, as an engine a
   * package creates would; `engines().next` gives each session its own.
   */
  const host = (engine: () => FakeEngineHandle, options: HostOptions = {}) =>
    new SessionHost({
      locateConfig: (requested) => path.join(dir, requested ?? 'e2e.config.ts'),
      loadConfig: async (configPath) => {
        await options.loaded;
        options.evaluate?.(configPath);
        const config = resolveConfig(
          {
            targets: [{ name: 'kiosk', platform: 'kiosk', engine: engine().engine }],
            credentials: { admin: { username: 'admin', password: 'kiosk-pw' } },
            ...(options.trace === undefined ? {} : { trace: options.trace }),
            ...(options.video === undefined ? {} : { video: options.video }),
          } as never,
          { projectRoot: dir, env: {}, configPath },
        );
        return { ...config, configPath };
      },
      env: {},
      headed: options.headed ?? false,
      log: (level, message) => logs.push(`${level}: ${message}`),
      idleMs: options.idleMs,
      ttlMs: options.ttlMs,
      maxSessions: options.maxSessions,
    });

  const sessionId = (text: string): string => /^Session (\S+) open/.exec(text)![1]!;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-host-'));
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('boots the engine headed when asked and headless otherwise', async () => {
    const fake = createFakeEngine();
    const headed = host(() => fake, { headed: true });
    const text = await headed.open({});
    expect(text).toContain('), headed;');
    expect(fake.inits[0]?.headed).toBe(true);
    await headed.close('done');
    const headless = host(() => fake, { headed: false });
    await headless.open({});
    expect(fake.inits[1]?.headed).toBe(false);
    await headless.close('done');
    expect(fake.stats()).toMatchObject({ attemptsStarted: 2, attemptsEnded: 2, disposes: 2 });
  });

  it('closes the schema of every fixed tool: an argument it does not declare fails validation', () => {
    const specs = host(engines().next).toolSpecs();
    expect(specs.map((spec) => spec.name)).toEqual(['open_session', 'tools', 'call', 'close_session']);
    const accepted: Record<string, Record<string, unknown>> = {
      open_session: { target: 'kiosk' },
      tools: { tool: 'tap' },
      call: { tool: 'tap', args: { target: 'n1' } },
      close_session: {},
    };
    for (const spec of specs) {
      expect(spec.inputSchema.safeParse(accepted[spec.name]).success, spec.name).toBe(true);
      const decorated = spec.inputSchema.safeParse({ ...accepted[spec.name], force: true });
      expect(decorated.success, spec.name).toBe(false);
      if (!decorated.success) expect(decorated.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
    }
  });

  it('closes an idle session and disposes the engine', async () => {
    const fakes = engines();
    const idle = host(fakes.next, { idleMs: 300 });
    await idle.open({});
    expect(idle.isOpen).toBe(true);
    await sleep(1_000);
    expect(idle.isOpen).toBe(false);
    expect(logs.some((line) => line.includes('idle for'))).toBe(true);
    expect(fakes.made[0]!.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
  });

  it('ends a session at its TTL through the step deadline', async () => {
    const fakes = engines();
    const short = host(fakes.next, { ttlMs: 1_000 });
    await short.open({});
    await sleep(3_000);
    expect(short.isOpen).toBe(false);
    expect(logs.some((line) => line.includes('exceeded its 1000 ms timeout'))).toBe(true);
    expect(fakes.made[0]!.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
  });

  it('keeps the credential registry of a session opened while the previous one closes', async () => {
    const fake = createFakeEngine();
    const first = host(() => fake);
    await first.open({});
    const closing = first.close('done');
    const second = host(() => fake);
    await second.open({});
    await closing;
    expect(credentials.user('admin').username).toBe('admin');
    await second.close('done');
    expect(() => credentials.user('admin')).toThrow(/only available while the e2e runner is active/);
  });

  it('opens sessions side by side up to the limit, and a call names its session while several are open', async () => {
    const fakes = engines();
    const pair = host(fakes.next, { maxSessions: 2 });
    const opened = await Promise.all([pair.open({}), pair.open({})]);
    const [first, second] = opened.map(sessionId) as [string, string];
    expect(first).not.toBe(second);
    expect(opened[0]).toContain(`Pass session "${first}" to every tools, call, and close_session; with several sessions open, a call without it fails.`);
    await expect(pair.open({})).rejects.toMatchObject({
      code: 'SESSION_OPEN',
      message: `no session slot is free (e2e mcp --max-sessions 2): ${first} on "kiosk", ${second} on "kiosk"; close_session one first`,
    });
    expect(() => pair.catalog(undefined, undefined)).toThrow(`2 sessions are open; pass session to name one: ${first} on "kiosk", ${second} on "kiosk"`);
    expect(pair.catalog(second, undefined)).toContain(`Session ${second} on target "kiosk"`);
    await expect(pair.close('done')).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });

    expect(await pair.close('done', first)).toContain(`Session ${first} closed (done)`);
    expect(() => pair.catalog(first, undefined)).toThrow(`session "${first}" ended: done; call open_session for a new one`);
    expect(pair.catalog(undefined, undefined)).toContain(`Session ${second} on target "kiosk"`);
    expect(await pair.closeAll('server shutdown')).toContain(`Session ${second} closed (server shutdown)`);
    expect(await pair.closeAll('server shutdown')).toBeUndefined();
    const each = expect.objectContaining({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
    expect(fakes.made.map((fake) => fake.stats())).toEqual([each, each]);
  });

  it('counts a session booting its first screen once against the limit', async () => {
    const navigating = gate();
    const held = gate();
    const pair = host(engines({ onNavigate: () => (navigating.open(), held.promise) }, {}).next, { maxSessions: 2 });
    const first = pair.open({});
    await navigating.promise;
    const second = sessionId(await pair.open({}));
    held.open();
    await pair.close('done', sessionId(await first));
    await pair.close('done', second);
  });

  it('refuses a second session on an engine instance another session drives', async () => {
    const fake = createFakeEngine();
    const shared = host(() => fake, { maxSessions: 2 });
    const first = sessionId(await shared.open({}));
    await expect(shared.open({})).rejects.toMatchObject({
      code: 'ENGINE_IN_USE',
      message: `target "kiosk" gets its engine instance from a package, so every session shares it, and session ${first} is driving it; create the engine in the config or a file it imports by path, or close_session ${first} first`,
    });
    await shared.close('done');
    expect(await shared.open({})).toContain('button "Submit"');
    await shared.close('done');
  });

  it('holds the engine of a session that failed to open until its attempt is disposed', async () => {
    const disposing = gate();
    const released = gate();
    let observes = 0;
    let disposes = 0;
    const fake = createFakeEngine({
      observe: () => {
        if (observes++ === 0) throw new Error('screen unavailable');
      },
      onDispose: () => {
        if (disposes++ > 0) return undefined;
        disposing.open();
        return released.promise;
      },
    });
    const shared = host(() => fake, { maxSessions: 2 });
    const failing = shared.open({});
    await disposing.promise;
    await expect(shared.open({})).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
    released.open();
    await expect(failing).rejects.toThrow(/screen unavailable/);
    expect(await shared.open({})).toContain('button "Submit"');
    await shared.close('done');
  });

  it('holds the slot, the engine, and the config of a closing session until its attempt is disposed', async () => {
    const disposing = gate();
    const released = gate();
    const fake = createFakeEngine({
      onDispose: () => {
        disposing.open();
        return released.promise;
      },
    });
    // The first two loads get the closing session's engine; the rest a fresh one each.
    const loads = [fake, fake];
    const single = host(() => loads.shift() ?? createFakeEngine(), { maxSessions: 2 });
    const id = sessionId(await single.open({}));
    const closing = single.close('done', id);
    await disposing.promise;
    const again = single.close('again', id);
    expect(() => single.catalog(id, undefined)).toThrow(`session "${id}" is closing (done)`);
    await expect(single.open({})).rejects.toMatchObject({ code: 'ENGINE_IN_USE' });
    await expect(single.open({ config: 'other.config.ts' })).rejects.toMatchObject({ code: 'CONFIG_IN_USE' });
    released.open();
    expect(await closing).toContain(`Session ${id} closed (done)`);
    expect(await again).toBe(await closing);
    expect(await single.open({})).toContain('button "Submit"');
    await single.close('done');
  });

  it('refuses a session on another config while one is open', async () => {
    const mixed = host(engines().next, { maxSessions: 2 });
    const first = sessionId(await mixed.open({}));
    await expect(mixed.open({ config: 'other.config.ts' })).rejects.toMatchObject({
      code: 'CONFIG_IN_USE',
      message: `session ${first} is open on config ${path.join(dir, 'e2e.config.ts')}; sessions open at once share one config, because credentials and secrets resolve process-wide; open this one on that config, or close every session on it first`,
    });
    await mixed.close('done');
    expect(await mixed.open({ config: 'other.config.ts' })).toContain(`config ${path.join(dir, 'other.config.ts')}`);
    await mixed.close('done');
  });

  it('refuses a session on another config before evaluating it, so its secrets never resolve against the open session\'s', async () => {
    const evaluated: string[] = [];
    const mixed = host(engines().next, {
      maxSessions: 2,
      evaluate: (configPath) => {
        evaluated.push(path.basename(configPath));
        // A config that hands an engine option secrets.get() of a secret only it declares.
        if (configPath.endsWith('other.config.ts')) secrets.get('OTHER_ONLY');
      },
    });
    const first = sessionId(await mixed.open({}));
    await expect(mixed.open({ config: 'other.config.ts' })).rejects.toMatchObject({
      code: 'CONFIG_IN_USE',
      message: expect.stringContaining(`session ${first} is open on config ${path.join(dir, 'e2e.config.ts')}`),
    });
    expect(evaluated).toEqual(['e2e.config.ts']);
    await mixed.close('done');
  });

  it('starts one app process for sessions on the same command and stops it after the last one closes', async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    writeStartupScripts(dir);
    const shared = host(engines({ app: { url, command: { executable: process.execPath, args: ['server.cjs', String(port)] } } }).next, { maxSessions: 3 });
    const [first, second] = (await Promise.all([shared.open({}), shared.open({})])).map(sessionId) as [string, string];
    expect(startupLog(dir)).toBe('app\n');
    await shared.close('done', first);
    expect(await (await fetch(url)).text()).toBe('ready');
    await shared.close('done', second);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('waits for a session still opening before it shuts down, and admits none meanwhile', async () => {
    const loading = gate();
    const fakes = engines();
    const shutting = host(fakes.next, { loaded: loading.promise });
    const opening = shutting.open({});
    let shutDown = false;
    const closed = shutting.closeAll('server shutdown').then((summary) => {
      shutDown = true;
      return summary;
    });
    await expect(shutting.open({})).rejects.toMatchObject({ code: 'SESSION_OPEN', message: 'the server is shutting down; no session can open' });
    await sleep(50);
    expect(shutDown).toBe(false);
    loading.open();
    const id = sessionId(await opening);
    expect(await closed).toContain(`Session ${id} closed (server shutdown)`);
    expect(shutting.isOpen).toBe(false);
    expect(fakes.made.map((fake) => fake.stats())).toEqual([expect.objectContaining({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 })]);
  });

  it('keeps the credential registry of an open session when another fails to open', async () => {
    const pair = host(engines({}, { observe: () => { throw new Error('screen unavailable'); } }).next, { maxSessions: 2 });
    await pair.open({});
    await expect(pair.open({})).rejects.toThrow(/screen unavailable/);
    expect(credentials.user('admin').username).toBe('admin');
    await pair.close('done');
    expect(() => credentials.user('admin')).toThrow(/only available while the e2e runner is active/);
  });

  it('keeps the credential registry while a session is still open after the newer one closes', async () => {
    const both = host(engines().next, { maxSessions: 2 });
    const older = sessionId(await both.open({}));
    const newer = sessionId(await both.open({}));
    await both.close('done', newer);
    expect(credentials.user('admin').username).toBe('admin');
    await both.close('done', older);
    expect(() => credentials.user('admin')).toThrow(/only available while the e2e runner is active/);
  });

  it('tears down an attempt whose first observation failed, then opens the next one', async () => {
    let broken = true;
    const fake = createFakeEngine({
      observe: () => {
        if (broken) throw new Error('screen unavailable');
      },
    });
    const flaky = host(() => fake);
    await expect(flaky.open({})).rejects.toThrow(/screen unavailable/);
    expect(flaky.isOpen).toBe(false);
    expect(fake.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
    broken = false;
    const text = await flaky.open({});
    expect(text).toContain('button "Submit"');
    await flaky.close('done');
    expect(fake.stats()).toMatchObject({ attemptsStarted: 2, attemptsEnded: 2, disposes: 2 });
  });

  it('records only between start_recording and stop_recording, and saves a recording still running at close', async () => {
    const fake = createFakeEngine({ video: true });
    // The config's video mode is for runs: the session must not record from launch.
    const recording = host(() => fake, { video: 'on' });
    const opened = await recording.open({});
    expect(opened).toMatch(/^- start_recording \{name\?\}: Start recording a video of the app, for a person to watch: .*\.$/m);
    expect(opened).toMatch(/^- stop_recording: Stop the running recording and save it: .*\.$/m);
    expect(fake.operations.map((operation) => operation.method)).not.toContain('artifacts.startVideo');
    const id = sessionId(opened);
    const recordings = path.join(dir, '.e2e', 'videos', id);
    const extra = { signal: new AbortController().signal };
    const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? '').join('\n');

    const started = await recording.call(id, 'start_recording', { name: 'demo' }, extra);
    expect(text(started)).toContain('Recording 1 "demo" started.');
    const stopped = await recording.call(id, 'stop_recording', {}, extra);
    expect(text(stopped)).toMatch(/^Recording 1 "demo" stopped after \d+\.\d s\.\n- (\S+)$/);
    expect(text(stopped).endsWith(`- ${path.join(recordings, '1-demo.webm')}`)).toBe(true);
    const nothing = await recording.call(id, 'stop_recording', {}, extra);
    expect(text(nothing)).toBe('Nothing is recording; start_recording starts a recording.');
    const badName = await recording.call(id, 'start_recording', { name: '../escape' }, extra);
    expect(badName.isError).toBe(true);
    expect(text(badName)).toMatch(/^INVALID_ARGUMENT: call start_recording: name: /);

    await recording.call(id, 'start_recording', {}, extra);
    const closed = await recording.close('done');
    expect(closed).toMatch(/^Session \S+ closed \(done\); \d+ tool calls ran\.\nRecording 2 stopped after \d+\.\d s\.\n- \S+$/);
    expect(closed.endsWith(`- ${path.join(recordings, '2.webm')}`)).toBe(true);
    expect(readdirSync(recordings).toSorted()).toEqual(['1-demo.webm', '2.webm']);
    expect(existsSync(path.join(fake.attempts[0]!.artifactsDir, 'video', 'fake.webm'))).toBe(false);
  });

  it('traces the one attempt under on, and records no trace under a retry or retain-on-failure mode', async () => {
    /** The trace operations one session with the config's `trace` ran. */
    const traced = async (trace: RecordingMode | undefined) => {
      const fake = createFakeEngine({ trace: true });
      const session = host(() => fake, trace === undefined ? {} : { trace });
      await session.open({});
      await session.close('done');
      return fake.operations.map((operation) => operation.method).filter((method) => method.includes('Trace'));
    };
    expect(await traced(undefined)).toEqual(['artifacts.startTrace', 'artifacts.stopTrace']);
    expect(await traced('on')).toEqual(['artifacts.startTrace', 'artifacts.stopTrace']);
    for (const mode of ['off', 'on-first-retry', 'on-all-retries', 'retain-on-failure'] as const) expect(await traced(mode)).toEqual([]);
  });

  it('says once that a trace the config asks for is not recorded on an engine that cannot trace', async () => {
    const session = host(engines().next, { trace: 'on' });
    await session.open({});
    await session.close('done');
    expect(logs.filter((line) => line.includes('records no trace'))).toEqual([
      'info: kiosk: trace records only on targets whose engine can record it; target "kiosk" (engine fake) records no trace',
    ]);
  });

  it('lists no recording tools when the engine records no video', async () => {
    const plain = host(engines().next);
    const opened = await plain.open({});
    expect(opened).not.toContain('start_recording');
    const closed = await plain.close('done');
    expect(closed).not.toContain('Recording');
  });
});
