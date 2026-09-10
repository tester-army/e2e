import { describe, expect, it } from 'vitest';
import {
  defineEngine,
  isEngineHandle,
  type Engine,
  type EngineCleanupContext,
  type EngineSnapshot,
} from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { OperationContext, SemanticNode } from '../../src/engine/surface.ts';

const OP: OperationContext = {
  signal: new AbortController().signal,
  timeoutMs: 1_000,
  runId: 'run',
  attemptId: 'attempt',
};

const node = (id: string, name: string): SemanticNode => ({
  ref: { id, revision: '' },
  role: 'button',
  name,
});

function observingEngine(extra: Partial<Engine> = {}): Engine {
  return {
    name: 'toy',
    version: '1.0.0',
    spiVersion: 1,
    observe: async () => ({ nodes: [node('n1', 'Save'), node('n2', 'Cancel')] }),
    ...extra,
  };
}

describe('defineEngine', () => {
  it('computes the capability set from declared members: perform is the actions capability', () => {
    const handle = defineEngine(observingEngine({ perform: async () => undefined }));
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    expect(isEngineHandle(handle)).toBe(true);
  });

  it('rejects perform, locate, and swipe without observe: their refs are observation refs', () => {
    const bare = { name: 'toy', version: '1', spiVersion: 1 as const };
    expect(() => defineEngine({ ...bare, perform: async () => undefined })).toThrow(/perform without observe/);
    expect(() => defineEngine({ ...bare, locate: async () => [] })).toThrow(/locate without observe/);
    expect(() => defineEngine({ ...bare, swipe: async () => undefined })).toThrow(/swipe without observe/);
    expect(() => defineEngine({ ...bare, tapAt: async () => undefined })).toThrow(/tapAt without observe/);
  });

  it('computes the pointer capability from tapAt', () => {
    const handle = defineEngine(observingEngine({ tapAt: async () => undefined }));
    expect([...handle.capabilities].toSorted()).toEqual(['observation', 'pointer']);
  });

  it('rejects unknown keys, pointing tools at the agent', () => {
    expect(() =>
      defineEngine({ ...observingEngine(), tools: [] } as unknown as Engine),
    ).toThrow(/tools belong on the agent/);
  });

  it('rejects unknown keys inside nested manifests: the grammar is closed', () => {
    expect(() =>
      defineEngine(observingEngine({ app: { tap: async () => undefined } as never })),
    ).toThrow(/app has unknown key "tap"/);
    expect(() =>
      defineEngine(observingEngine({ artifacts: { screenshot: async () => 'x', video: 1 } as never })),
    ).toThrow(/artifacts has unknown key "video"/);
    expect(() =>
      defineEngine(observingEngine({ artifacts: { screenshot: async () => 'x', startVideo: async () => undefined } })),
    ).toThrow(/artifacts.startVideo and stopVideo must be declared together/);
    expect(() =>
      defineEngine(observingEngine({ state: { capture: async () => ({}) } as never })),
    ).toThrow(/state.restore must be a function/);
    // An array has no unknown keys, so it must be refused by shape, not by key.
    expect(() => defineEngine(observingEngine({ app: [] as never }))).toThrow(/app must be an object/);
    expect(() => defineEngine(observingEngine({ app: { url: async () => 'x' } as never }))).toThrow(
      /app.url is a declaration, not a hook/,
    );
  });

  it('copies a declared workers bound and rejects one that is not a positive integer', () => {
    expect(defineEngine(observingEngine({ workers: 2 })).workers).toBe(2);
    expect(defineEngine(observingEngine()).workers).toBeUndefined();
    for (const workers of [0, -1, 1.5, Number.NaN, '2' as never]) {
      expect(() => defineEngine(observingEngine({ workers }))).toThrow(/workers must be a positive safe integer/);
    }
  });

  it('requires a version: provenance and the trace cache key depend on it', () => {
    expect(() => defineEngine({ ...observingEngine(), version: '' })).toThrow(/version/);
    expect(() =>
      defineEngine({ name: 'toy', spiVersion: 1 } as unknown as Engine),
    ).toThrow(/version must be a non-empty string/);
  });

  it('rejects unsupported spiVersion values', () => {
    expect(() => defineEngine({ ...observingEngine(), spiVersion: 2 as never })).toThrow(
      /spiVersion 2/,
    );
  });

  it('binds prepare like every other lifecycle hook', async () => {
    let boundToSpec = false;
    const spec: Engine = observingEngine({
      async prepare(this: unknown) {
        boundToSpec = this === spec;
      },
    });
    const handle = defineEngine(spec);
    await handle.prepare?.({
      runId: 'run',
      targetName: 'toy',
      slots: 1,
      env: {},
      signal: new AbortController().signal,
      log: () => {},
    });
    expect(boundToSpec).toBe(true);
  });

  it('accepts a class instance: prototype methods are found and bound to the body', async () => {
    let boundToApp = false;
    const app = {
      async navigate(this: unknown) {
        boundToApp = this === app;
      },
    };
    class Toy implements Engine {
      readonly name = 'class-toy';
      readonly version = '2.0.0';
      readonly spiVersion = 1 as const;
      /** Own state: a class body may carry fields a literal may not. */
      observed = 0;
      readonly app = app;
      async observe(): Promise<EngineSnapshot> {
        this.observed += 1;
        return { nodes: [] };
      }
      async perform(): Promise<void> {
        this.observed += 10;
      }
    }
    const toy = new Toy();
    const handle = defineEngine(toy);
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    await handle.observe!(OP);
    await handle.perform!({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await handle.app!.navigate!('https://example.test/', OP);
    expect(toy.observed).toBe(11);
    expect(boundToApp).toBe(true);
  });
});

describe('createEngineSession', () => {
  it('mints revisions and stamps them onto every ref', async () => {
    const session = createEngineSession({
      engine: defineEngine(observingEngine()),
      targetName: 'toy-target',
    });
    const first = await session.observe(OP);
    const second = await session.observe(OP);
    expect(first.revision).not.toBe(second.revision);
    expect(second.tree.children?.[0]?.ref.revision).toBe(second.revision);
    expect(second.redaction).toEqual({ secureNodeCount: 0, maskedRegionCount: 0 });
  });

  it('routes every node action through perform and fails loud on undeclared members', async () => {
    const calls: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          perform: async (ref, action) => void calls.push(`${action.kind}:${ref.id}`),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'press', key: 'Enter' }, OP);
    expect(calls).toEqual(['tap:n1', 'press:n1']);
    await expect(session.swipe('down', undefined, OP)).rejects.toThrow(/no engine capability for swipe/);
    await expect(session.locate({ kind: 'query' } as never, OP)).rejects.toThrow(/locators/);
    await expect(session.artifacts.screenshot(undefined, OP)).rejects.toThrow(/screenshots/);
    await expect(session.app.open('https://example.test/', OP)).rejects.toThrow(/navigation/);
  });

  it('declares the grammar verbs its engine can honor', () => {
    const verbs = (extra: Partial<Engine>) =>
      [...createEngineSession({ engine: defineEngine(observingEngine(extra)), targetName: 't' }).verbs].toSorted();
    expect(verbs({})).toEqual([]);
    expect(verbs({ perform: async () => undefined })).toEqual(['press', 'select', 'tap', 'type', 'typeSecret']);
    expect(verbs({ swipe: async () => undefined })).toEqual(['scroll']);
    expect(verbs({ tapAt: async () => undefined })).toEqual(['tapAt']);
    expect(verbs({ app: { navigate: async () => undefined } })).toEqual(['navigate']);
  });

  it('rejects a superseded located ref but lets observation refs through to the engine', async () => {
    const performed: string[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          locate: async () => [node('n1', 'Save')],
          perform: async (ref) => void performed.push(ref.revision),
        }),
      ),
      targetName: 'toy-target',
    });
    const [first] = await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await expect(session.perform(first!, { kind: 'tap' }, OP)).rejects.toMatchObject({ code: 'NODE_STALE' });
    // The same id from an observation is the engine's to check, not the adapter's.
    const observed = await session.observe(OP);
    await session.perform({ id: 'n1', revision: observed.revision }, { kind: 'tap' }, OP);
    expect(performed).toEqual([observed.revision]);
  });

  it('ends the attempt exactly once, handing endAttempt the cleanup budget', async () => {
    const contexts: EngineCleanupContext[] = [];
    const session = createEngineSession({
      engine: defineEngine(
        observingEngine({
          endAttempt: async (context) => void contexts.push(context),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.close({ ...OP, timeoutMs: 7_000 });
    await session.close({ ...OP, timeoutMs: 7_000 });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual({ signal: OP.signal, timeoutMs: 7_000 });
  });

  it('reports missing observation as an unsupported capability', async () => {
    const session = createEngineSession({
      engine: undefined,
      targetName: 'bare',
    });
    await expect(session.observe(OP)).rejects.toThrow(/no engine capability for observation/);
    expect(session.verbs.size).toBe(0);
  });
});

describe('createEngineSession pixels-only observation', () => {
  it('accepts a snapshot with no nodes and pixels: a vision-only body is observable', async () => {
    const pixels = { data: new Uint8Array(8), mediaType: 'image/png' as const, width: 4, height: 2, scale: 1 };
    const session = createEngineSession({
      engine: defineEngine({
        name: 'vision',
        version: '1.0.0',
        spiVersion: 1,
        observe: async () => ({ nodes: [], pixels, maskedRegionCount: 0 }),
      }),
      targetName: 'desktop',
    });
    const observation = await session.observe(OP, { pixels: true });
    expect(observation.tree.role).toBe('root');
    expect(observation.tree.children ?? []).toHaveLength(0);
    expect(observation.pixels).toBe(pixels);
    expect(observation.redaction).toEqual({ secureNodeCount: 0, maskedRegionCount: 0 });
  });
});

describe('engine targets in config', () => {
  const ROOT = '/tmp/e2e-engine-config';

  it('rejects an empty platform declaration', () => {
    expect(() => defineEngine({ name: 'x', version: '1', spiVersion: 1, platform: ' ' })).toThrow(
      'platform must be a non-empty string when declared',
    );
  });

  it('resolves an engine target on any platform without an app url', () => {
    const engine = defineEngine(observingEngine());
    const config = resolveConfig(
      { targets: [{ name: 'ios-simulator', platform: 'ios', engine }] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    const target = config.targets[0];
    expect(target?.engine?.name).toBe('toy');
    expect(target?.platform).toBe('ios');
    expect(target?.app).toMatchObject({ base: undefined, allowedOrigins: [], identity: undefined });
  });

  it('rejects a non-handle engine value', () => {
    expect(() =>
      resolveConfig(
        { targets: [{ name: 'ios', platform: 'ios', engine: { name: 'raw' } as never }] },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/defineEngine/);
  });

  it('accepts the video artifact kind on a target without an engine; the runner grades it later', () => {
    const config = resolveConfig(
      { targets: [{ name: 'ios', platform: 'ios' }], artifacts: ['video'] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    expect([...config.artifacts]).toEqual([['video', 'required']]);
  });

  it('accepts agent options alongside an executor', () => {
    const executor = { name: 'custom-brain', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }) };
    const config = resolveConfig(
      {
        targets: [{ name: 'ios', platform: 'ios' }],
        agents: { default: { executor, maxModelCalls: 40, context: 'device hints' } },
      },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    expect(config.agent.executor?.name).toBe('custom-brain');
    expect(config.agent.maxModelCalls).toBe(40);
    expect(config.agent.context).toBe('device hints');
  });
});
