import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  connectEngine,
  defineEngine,
  describeEngine,
  ENGINE_METHODS,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  EngineError,
  loopbackTransport,
  spawnTransport,
  TestError,
  type Engine,
  type EngineAttemptContext,
  type EngineHandle,
  type EngineInitInfo,
  type OperationContext,
  type SemanticNode,
} from '../../src/engine/index.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { ConfigurationError, TestTimeoutError } from '../../src/internal/errors.ts';
import { isEngineClient } from '../../src/engine/protocol/client.ts';
import { Connection } from '../../src/engine/protocol/connection.ts';
import type { EngineTransport } from '../../src/engine/protocol/transport.ts';
import { secretHandle } from '../../src/secrets.ts';

const node = (id: string, name: string, role = 'button'): SemanticNode => ({ ref: { id, revision: '' }, role, name });

const ROOT: SemanticNode = { ref: { id: 'root', revision: '' }, role: 'root', children: [node('n1', 'Save'), node('n2', 'Cancel')] };

const operation = (signal: AbortSignal = new AbortController().signal): OperationContext => ({
  signal,
  timeoutMs: 1000,
  runId: 'run',
  attemptId: 'attempt-1',
  origin: 'test',
});

const initInfo = (log: (line: string) => void = () => {}): EngineInitInfo => ({
  runId: 'run',
  targetName: 'toy',
  projectRoot: process.cwd(),
  app: {},
  env: process.env,
  headed: false,
  workerSlot: 0,
  signal: new AbortController().signal,
  log,
});

const cleanup = { signal: new AbortController().signal, timeoutMs: 1000 };

/** Serves `engine` in this process and returns the client handle over it. */
function overLoopback(engine: Engine, extra: Partial<Parameters<typeof connectEngine>[0]> = {}): { local: EngineHandle; remote: EngineHandle } {
  const local = defineEngine(engine);
  return { local, remote: connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local), ...extra }) };
}

const toy = (extra: Partial<Engine> = {}): Engine => ({
  name: 'toy',
  version: '1.0.0',
  spiVersion: 1,
  observe: async () => ({ root: ROOT, viewport: { width: 1280, height: 720 } }),
  ...extra,
});

describe('engine protocol', () => {
  it('declares the same capabilities over the protocol as the engine itself', () => {
    const { local, remote } = overLoopback(
      toy({
        actions: ['tap', 'fill'],
        perform: async () => {},
        keyboard: { type: async () => {}, press: async () => {} },
        session: { open: async () => {}, reset: async () => {} },
      }),
    );
    expect([...remote.capabilities].toSorted()).toEqual([...local.capabilities].toSorted());
    expect(remote.actions).toEqual(['tap', 'fill']);
    expect(Object.keys(remote.session ?? {}).toSorted()).toEqual(['open', 'reset']);
  });

  it('carries a snapshot with its pixels byte for byte', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]);
    const { remote } = overLoopback(
      toy({
        observe: async () => ({ root: ROOT, viewport: { width: 10, height: 10 }, pixels: { data, mediaType: 'image/png', width: 20, height: 20, scale: 2 } }),
      }),
    );
    await remote.init!(initInfo());
    const snapshot = await remote.observe!(operation());
    expect(snapshot.root).toEqual(ROOT);
    expect(snapshot.pixels?.data).toEqual(data);
    expect(snapshot.pixels?.scale).toBe(2);
    await remote.dispose!(cleanup);
  });

  it('rethrows an engine error with its code and retryability, and a harness error with its category', async () => {
    let throwing: unknown;
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async () => {
          throw throwing;
        },
      }),
    );
    await remote.init!(initInfo());
    const ref = { id: 'n1', revision: '' };
    throwing = new EngineError('NODE_STALE', 'gone', { retryable: true });
    await expect(remote.perform!(ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ name: 'EngineError', code: 'NODE_STALE', retryable: true, message: 'gone' });
    throwing = new TestError('ACTION_FAILED', 'blocked', { details: { locator: 'x' } });
    await expect(remote.perform!(ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ category: 'test', code: 'ACTION_FAILED', details: { locator: 'x' } });
    throwing = new Error('plain');
    const plain = await remote.perform!(ref, { kind: 'tap' }, operation()).catch((cause: unknown) => cause);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(EngineError);
    expect((plain as Error).message).toBe('plain');
    await remote.dispose!(cleanup);
  });

  it('aborts the server-side signal when the client aborts, including one already aborted', async () => {
    const seen: AbortSignal[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          seen.push(context.signal);
          if (context.signal.aborted) return;
          await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        },
      }),
    );
    await remote.init!(initInfo());
    const controller = new AbortController();
    const pending = remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await pending;
    expect(seen[0]?.aborted).toBe(true);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    expect(seen[1]?.aborted).toBe(true);
    await remote.dispose!(cleanup);
  });

  it('carries the abort reason, so an engine rethrowing it raises what it would in process', async () => {
    const reasons: unknown[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          if (!context.signal.aborted) await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
          reasons.push(context.signal.reason);
        },
      }),
    );
    await remote.init!(initInfo());
    const controller = new AbortController();
    const pending = remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new TestTimeoutError('test timed out after 1000ms'));
    await pending;
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    const bare = new AbortController();
    bare.abort();
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(bare.signal));
    expect(reasons[0]).toMatchObject({ category: 'test', code: 'TEST_TIMEOUT', message: 'test timed out after 1000ms' });
    expect(reasons[1]).toMatchObject({ category: 'test', code: 'TEST_TIMEOUT' });
    expect((reasons[2] as Error).name).toBe('AbortError');
    await remote.dispose!(cleanup);
  });

  it('refuses a call before init instead of opening a connection on its own', async () => {
    const { remote } = overLoopback(toy());
    await expect(remote.observe!(operation())).rejects.toMatchObject({ name: 'EngineError', code: 'INVALID_STATE' });
  });

  it('prepares and finishes each target that shares one handle on its own connection', async () => {
    const finished: string[] = [];
    const { remote } = overLoopback(
      toy({
        async prepare() {},
        async finish(info) {
          finished.push(info.targetName);
        },
      }),
    );
    const prepare = (targetName: string) =>
      remote.prepare!({ runId: 'run', targetName, projectRoot: process.cwd(), app: {}, slots: 1, env: {}, headed: false, signal: new AbortController().signal, log: () => {} });
    await prepare('a');
    await prepare('b');
    const finish = (targetName: string) => remote.finish!({ runId: 'run', targetName, env: {}, log: () => {}, ...cleanup });
    await Promise.all([finish('a'), finish('b')]);
    expect(finished.toSorted()).toEqual(['a', 'b']);
  });

  it('routes attempt callbacks and secret resolution back to the harness', async () => {
    const secret = secretHandle({ name: 'password', purpose: 'generic-secret' });
    const { remote } = overLoopback(
      toy({
        secrets: [secret],
        async startAttempt(context) {
          context.appLog({ source: 'console', level: 'info', text: 'hello' });
          context.navigation('navigated to /home');
          context.environment({ device: 'toy' });
          context.screen?.({ root: ROOT, viewport: { width: 1, height: 1 } });
          const value = await context.resolveSecret(secret, { derived: (plain) => [`b64:${plain}`] });
          context.appLog({ source: 'system', level: 'info', text: `resolved ${value.length}` });
        },
        async endAttempt() {},
      }),
      { secrets: [secret] },
    );
    const received: string[] = [];
    const resolved: { name: string; derived?: readonly string[] }[] = [];
    const context: EngineAttemptContext = {
      attemptId: 'attempt-1',
      artifactsDir: '/tmp',
      signal: new AbortController().signal,
      resolveSecret: async (handle, options) => {
        resolved.push({ name: handle.name, ...(options?.derived === undefined ? {} : { derived: options.derived('hunter22') }) });
        return 'hunter22';
      },
      appLog: (entry) => received.push(`log:${entry.text}`),
      navigation: (line) => received.push(`nav:${line}`),
      environment: (facts) => received.push(`env:${JSON.stringify(facts)}`),
      screen: (snapshot) => received.push(`screen:${snapshot.root.ref.id}`),
    };
    await remote.init!(initInfo());
    await remote.startAttempt!(context);
    await remote.endAttempt!(cleanup);
    expect(received).toEqual(['log:hello', 'nav:navigated to /home', 'env:{"device":"toy"}', 'screen:root', 'log:resolved 8']);
    expect(resolved).toEqual([{ name: 'password' }, { name: 'password', derived: ['b64:hunter22'] }]);
    await remote.dispose!(cleanup);
  });

  it('runs prepare and finish on a run connection and init again after dispose', async () => {
    const calls: string[] = [];
    const { remote } = overLoopback(
      toy({
        async prepare(info) {
          info.log('preparing');
          return { workers: 1, env: { TOY: '1' } };
        },
        async finish() {
          calls.push('finish');
        },
        async init(info) {
          info.log(`init ${String(info.workerSlot)}`);
        },
        async dispose() {
          calls.push('dispose');
        },
      }),
    );
    const logs: string[] = [];
    const result = await remote.prepare!({
      runId: 'run',
      targetName: 'toy',
      projectRoot: process.cwd(),
      app: {},
      slots: 1,
      env: {},
      headed: false,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ workers: 1, env: { TOY: '1' } });
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.dispose!(cleanup);
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.dispose!(cleanup);
    await remote.finish!({ runId: 'run', targetName: 'toy', env: {}, log: () => {}, ...cleanup });
    expect(logs).toEqual(['preparing', 'init 0', 'init 0']);
    expect(calls).toEqual(['dispose', 'dispose', 'finish']);
  });

  it('answers locators on the client from observations when asked to', async () => {
    const { remote } = overLoopback(toy(), { resolveLocators: true });
    expect(remote.capabilities.has('location')).toBe(true);
    await remote.init!(initInfo());
    const nodes = await remote.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Cancel', exact: true } } }, operation());
    expect(nodes.map((match) => match.ref.id)).toEqual(['n2']);
    await remote.dispose!(cleanup);
  });

  it('refuses a server whose manifest differs from the declared one', async () => {
    const local = defineEngine(toy({ version: '2.0.0' }));
    const remote = connectEngine({ manifest: { ...describeEngine(local), version: '1.0.0' }, transport: loopbackTransport(local) });
    await expect(remote.init!(initInfo())).rejects.toThrow(/version is "2.0.0", declared "1.0.0"/);
  });

  it('describes an engine with a manifest the published schema accepts, and the schema names every method and kind', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../schema/engine-manifest-v1.schema.json', import.meta.url)), 'utf8')) as {
      properties: Record<string, { items?: { enum: string[] } }>;
    };
    expect(schema.properties['methods']?.items?.enum).toEqual([...ENGINE_METHODS]);
    expect(schema.properties['actions']?.items?.enum).toEqual([...LOCATOR_ACTION_KINDS]);
    expect(schema.properties['pointerActions']?.items?.enum).toEqual([...POINTER_ACTION_KINDS]);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const { local } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async () => {},
        pointerActions: ['tap'],
        performAt: async () => {},
        keyboard: { type: async () => {}, press: async () => {} },
        init: async () => {},
      }),
    );
    expect(validate(describeEngine(local))).toBe(true);
    const base = { name: 'x', version: '1', spiVersion: 1 };
    for (const refused of [
      { ...base, methods: ['engine/observe'], actions: ['tap'] },
      { ...base, methods: ['engine/observe'], tapModifiers: true },
      { ...base, methods: ['engine/observe'], pointerActions: ['tap'] },
      { ...base, methods: ['engine/locate'] },
      { ...base, methods: ['engine/observe', 'keyboard/type'] },
      { ...base, methods: ['state/capture'] },
      { ...base, methods: ['artifacts/screenshot', 'artifacts/startVideo'] },
    ]) {
      expect(validate(refused), JSON.stringify(refused)).toBe(false);
      expect(() => connectEngine({ manifest: refused as never, transport: loopbackTransport(local) }), JSON.stringify(refused)).toThrow(ConfigurationError);
    }
  });

  it('serves every in-process target through one protocol client and leaves a connected engine as declared', () => {
    const engine = defineEngine(toy());
    const { remote } = overLoopback(toy());
    const config = resolveConfig(
      { targets: [{ name: 'toy', platform: 'toy', engine }, { name: 'remote', platform: 'toy', engine: remote }] },
      { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv },
    );
    const served = config.targets[0]?.engine;
    expect(served).not.toBe(engine);
    expect(isEngineClient(served!)).toBe(true);
    expect(served?.name).toBe('toy');
    expect([...(served?.capabilities ?? [])]).toEqual([...engine.capabilities]);
    expect(config.targets[1]?.engine).toBe(remote);
    expect(resolveConfig({ targets: [{ name: 'toy', platform: 'toy', engine }] }, { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv }).targets[0]?.engine).toBe(served);
  });

  it('rejects a malformed manifest at config load', () => {
    const transport = loopbackTransport(defineEngine(toy()));
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/teleport' as never] }, transport })).toThrow(ConfigurationError);
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/perform'] }, transport })).toThrow(/perform without observe/);
  });
});

describe('engine protocol over a child process', () => {
  const server = fileURLToPath(new URL('../fixtures/protocol-server.ts', import.meta.url));
  const manifest = {
    name: 'toy-server',
    version: '1.0.0',
    spiVersion: 1 as const,
    platform: 'toy',
    methods: ['engine/observe', 'engine/perform', 'lifecycle/init'] as const,
    actions: ['tap'] as const,
  };

  it('drives an engine in its own process and stops it on dispose', async () => {
    const remote = connectEngine({ manifest: { ...manifest, methods: [...manifest.methods], actions: [...manifest.actions] }, transport: spawnTransport({ command: process.execPath, args: [server] }) });
    const logs: string[] = [];
    await remote.init!(initInfo((line) => logs.push(line)));
    const snapshot = await remote.observe!(operation());
    expect(snapshot.location).toMatch(/^pid:\d+$/);
    expect(snapshot.location).not.toBe(`pid:${String(process.pid)}`);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation());
    expect(logs).toEqual(['init slot 0']);
    await remote.dispose!(cleanup);
    const pid = Number(snapshot.location?.slice('pid:'.length));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('fails a request with the server stderr when the process dies mid-call', async () => {
    const remote = connectEngine({
      manifest: { ...manifest, methods: [...manifest.methods], actions: [...manifest.actions] },
      transport: spawnTransport({ command: process.execPath, args: [server] }),
      initializationOptions: { crashOnObserve: true },
    });
    await remote.init!(initInfo());
    await expect(remote.observe!(operation())).rejects.toThrow(/closed the connection[\s\S]*crashing on purpose/);
    await remote.dispose!(cleanup);
  });
});

describe('engine protocol against a server written from the messages alone', () => {
  /** A server that speaks raw JSON-RPC, as one in another language would: no `serveEngine`, no engine handle. */
  function handWritten(): { transport: EngineTransport; received: string[] } {
    const received: string[] = [];
    const transport: EngineTransport = {
      label: 'hand-written',
      async open() {
        const toServer = new PassThrough();
        const toClient = new PassThrough();
        const manifest = { name: 'hand', version: '1', spiVersion: 1, methods: ['engine/observe', 'artifacts/screenshot', 'lifecycle/startAttempt'] };
        const record = (method: string) => async (params: unknown) => {
          received.push(method);
          return params;
        };
        const server: Connection = new Connection(
          { input: toServer, output: toClient },
          {
            requests: {
              initialize: async () => ({ protocolVersion: 1, manifest }),
              shutdown: record('shutdown'),
              'lifecycle/startAttempt': async (params) => {
                received.push('lifecycle/startAttempt');
                server.notify('attempt/environment', { attemptId: (params as { attemptId: string }).attemptId, facts: { written: 'by hand' } });
                return null;
              },
              'engine/observe': async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } }),
              'artifacts/screenshot': async () => ({ data: Buffer.from('png bytes').toString('base64'), mediaType: 'image/png' }),
            },
            notifications: { exit: () => server.close('exit') },
          },
        );
        return { input: toClient, output: toServer, close: async () => void toServer.end() };
      },
    };
    return { transport, received };
  }

  it('drops a malformed notification instead of crashing', async () => {
    const toClient = new PassThrough();
    const logs: string[] = [];
    const transport: EngineTransport = {
      label: 'malformed',
      async open() {
        const toServer = new PassThrough();
        const server: Connection = new Connection(
          { input: toServer, output: toClient },
          {
            requests: {
              initialize: async () => {
                server.notify('engine/log');
                server.notify('engine/log', { line: 'still here' });
                return { protocolVersion: 1, manifest: { name: 'bad', version: '1', spiVersion: 1, methods: ['engine/observe'] } };
              },
              'engine/observe': async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } }),
            },
          },
        );
        return { input: toClient, output: toServer, close: async () => void toServer.end() };
      },
    };
    const remote = connectEngine({ manifest: { name: 'bad', version: '1', spiVersion: 1, methods: ['engine/observe'] }, transport });
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.observe!(operation());
    expect(logs).toEqual(['still here']);
    await remote.dispose!(cleanup);
  });

  it('writes a screenshot a server returned as bytes into the attempt directory', async () => {
    const { transport, received } = handWritten();
    const remote = connectEngine({ manifest: { name: 'hand', version: '1', spiVersion: 1, methods: ['engine/observe', 'artifacts/screenshot', 'lifecycle/startAttempt'] }, transport });
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protocol-'));
    const facts: Record<string, string>[] = [];
    await remote.init!(initInfo());
    await remote.startAttempt!({
      attemptId: 'attempt-1',
      artifactsDir,
      signal: new AbortController().signal,
      resolveSecret: async () => '',
      appLog: () => {},
      navigation: () => {},
      environment: (entry) => facts.push({ ...entry }),
    });
    const relative = await remote.artifacts!.screenshot('after login', operation());
    expect(relative).toBe(path.join('screenshots', '001-after_login.png'));
    expect(readFileSync(path.join(artifactsDir, relative), 'utf8')).toBe('png bytes');
    expect(facts).toEqual([{ written: 'by hand' }]);
    await remote.dispose!(cleanup);
    expect(received).toEqual(['lifecycle/startAttempt', 'shutdown']);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('refuses a screenshot path outside the attempt directory', async () => {
    const local = defineEngine(toy({ artifacts: { screenshot: async () => '../../elsewhere.png' }, startAttempt: async () => {} }));
    const remote = connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local) });
    await remote.init!(initInfo());
    await remote.startAttempt!({ attemptId: 'attempt-1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} });
    await expect(remote.artifacts!.screenshot(undefined, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await remote.dispose!(cleanup);
  });
});
