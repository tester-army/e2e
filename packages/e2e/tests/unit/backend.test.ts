import { describe, expect, it } from 'vitest';
import {
  defineBackend,
  isBackendHandle,
  type Backend,
  type BackendCleanupContext,
  type BackendSnapshot,
} from '../../src/backend/index.ts';
import { createBackendSession } from '../../src/backend/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { OperationContext, SemanticNode } from '../../src/backend/surface.ts';

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

function observingBackend(extra: Partial<Backend> = {}): Backend {
  return {
    name: 'toy',
    version: '1.0.0',
    spiVersion: 1,
    observe: async () => ({ nodes: [node('n1', 'Save'), node('n2', 'Cancel')] }),
    ...extra,
  };
}

describe('defineBackend', () => {
  it('computes the capability set from declared members: perform is the actions capability', () => {
    const handle = defineBackend(observingBackend({ perform: async () => undefined }));
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    expect(isBackendHandle(handle)).toBe(true);
  });

  it('rejects perform, locate, and swipe without observe: their refs are observation refs', () => {
    const bare = { name: 'toy', version: '1', spiVersion: 1 as const };
    expect(() => defineBackend({ ...bare, perform: async () => undefined })).toThrow(/perform without observe/);
    expect(() => defineBackend({ ...bare, locate: async () => [] })).toThrow(/locate without observe/);
    expect(() => defineBackend({ ...bare, swipe: async () => undefined })).toThrow(/swipe without observe/);
  });

  it('rejects unknown keys, pointing tools at the agent', () => {
    expect(() =>
      defineBackend({ ...observingBackend(), tools: [] } as unknown as Backend),
    ).toThrow(/tools belong on the agent/);
  });

  it('rejects unknown keys inside nested manifests: the grammar is closed', () => {
    expect(() =>
      defineBackend(observingBackend({ app: { tap: async () => undefined } as never })),
    ).toThrow(/app has unknown key "tap"/);
    expect(() =>
      defineBackend(observingBackend({ artifacts: { screenshot: async () => 'x', video: 1 } as never })),
    ).toThrow(/artifacts has unknown key "video"/);
    expect(() =>
      defineBackend(observingBackend({ state: { capture: async () => ({}) } as never })),
    ).toThrow(/state.restore must be a function/);
  });

  it('requires a version: provenance and the trace cache key depend on it', () => {
    expect(() => defineBackend({ ...observingBackend(), version: '' })).toThrow(/version/);
    expect(() =>
      defineBackend({ name: 'toy', spiVersion: 1 } as unknown as Backend),
    ).toThrow(/version must be a non-empty string/);
  });

  it('rejects unsupported spiVersion values', () => {
    expect(() => defineBackend({ ...observingBackend(), spiVersion: 2 as never })).toThrow(
      /spiVersion 2/,
    );
  });

  it('accepts a class instance: prototype methods are found and bound to the body', async () => {
    let boundToApp = false;
    const app = {
      async navigate(this: unknown) {
        boundToApp = this === app;
      },
    };
    class Toy implements Backend {
      readonly name = 'class-toy';
      readonly version = '2.0.0';
      readonly spiVersion = 1 as const;
      /** Own state: a class body may carry fields a literal may not. */
      observed = 0;
      readonly app = app;
      async observe(): Promise<BackendSnapshot> {
        this.observed += 1;
        return { nodes: [] };
      }
      async perform(): Promise<void> {
        this.observed += 10;
      }
    }
    const toy = new Toy();
    const handle = defineBackend(toy);
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    await handle.observe!(OP);
    await handle.perform!({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await handle.app!.navigate!('https://example.test/', OP);
    expect(toy.observed).toBe(11);
    expect(boundToApp).toBe(true);
  });
});

describe('createBackendSession', () => {
  it('mints revisions and stamps them onto every ref', async () => {
    const session = createBackendSession({
      backend: defineBackend(observingBackend()),
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
    const session = createBackendSession({
      backend: defineBackend(
        observingBackend({
          perform: async (ref, action) => void calls.push(`${action.kind}:${ref.id}`),
        }),
      ),
      targetName: 'toy-target',
    });
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'tap' }, OP);
    await session.perform({ id: 'n1', revision: 'b1' }, { kind: 'press', key: 'Enter' }, OP);
    expect(calls).toEqual(['tap:n1', 'press:n1']);
    await expect(session.swipe('down', undefined, OP)).rejects.toThrow(/no backend capability for swipe/);
    await expect(session.locate({ kind: 'query' } as never, OP)).rejects.toThrow(/locators/);
    await expect(session.artifacts.screenshot(undefined, OP)).rejects.toThrow(/screenshots/);
    await expect(session.app.open('https://example.test/', OP)).rejects.toThrow(/navigation/);
  });

  it('declares the grammar verbs its backend can honor', () => {
    const verbs = (extra: Partial<Backend>) =>
      [...createBackendSession({ backend: defineBackend(observingBackend(extra)), targetName: 't' }).verbs].toSorted();
    expect(verbs({})).toEqual([]);
    expect(verbs({ perform: async () => undefined })).toEqual(['press', 'select', 'tap', 'type', 'typeSecret']);
    expect(verbs({ swipe: async () => undefined })).toEqual(['scroll']);
    expect(verbs({ app: { navigate: async () => undefined } })).toEqual(['navigate']);
  });

  it('rejects a superseded located ref but lets observation refs through to the backend', async () => {
    const performed: string[] = [];
    const session = createBackendSession({
      backend: defineBackend(
        observingBackend({
          locate: async () => [node('n1', 'Save')],
          perform: async (ref) => void performed.push(ref.revision),
        }),
      ),
      targetName: 'toy-target',
    });
    const [first] = await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await session.locate({ kind: 'selector', selector: 'x' }, OP);
    await expect(session.perform(first!, { kind: 'tap' }, OP)).rejects.toMatchObject({ code: 'NODE_STALE' });
    // The same id from an observation is the backend's to check, not the adapter's.
    const observed = await session.observe(OP);
    await session.perform({ id: 'n1', revision: observed.revision }, { kind: 'tap' }, OP);
    expect(performed).toEqual([observed.revision]);
  });

  it('ends the attempt exactly once, handing endAttempt the cleanup budget', async () => {
    const contexts: BackendCleanupContext[] = [];
    const session = createBackendSession({
      backend: defineBackend(
        observingBackend({
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
    const session = createBackendSession({
      backend: undefined,
      targetName: 'bare',
    });
    await expect(session.observe(OP)).rejects.toThrow(/no backend capability for observation/);
    expect(session.verbs.size).toBe(0);
  });
});

describe('createBackendSession pixels-only observation', () => {
  it('accepts a snapshot with no nodes and pixels: a vision-only body is observable', async () => {
    const pixels = { data: new Uint8Array(8), mediaType: 'image/png' as const, width: 4, height: 2, scale: 1 };
    const session = createBackendSession({
      backend: defineBackend({
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

describe('backend targets in config', () => {
  const ROOT = '/tmp/e2e-backend-config';

  it('resolves a backend target on any platform without an app url', () => {
    const backend = defineBackend(observingBackend());
    const config = resolveConfig(
      { targets: [{ name: 'ios-simulator', platform: 'ios', backend }] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    const target = config.targets[0];
    expect(target?.backend?.name).toBe('toy');
    expect(target?.platform).toBe('ios');
    expect(config.app.allowedOrigins).toEqual([]);
  });

  it('rejects a non-handle backend value', () => {
    expect(() =>
      resolveConfig(
        { targets: [{ name: 'ios', platform: 'ios', backend: { name: 'raw' } as never }] },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/defineBackend/);
  });

  it('rejects the retired video artifact kind', () => {
    expect(() =>
      resolveConfig(
        { targets: [{ name: 'ios', platform: 'ios' }], artifacts: ['video'] as never },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/unknown artifact kind "video"/);
  });

  it('accepts agent options alongside an executor', () => {
    const executor = { name: 'custom-brain', runStep: async () => ({ status: 'passed' as const, summary: 'ok' }) };
    const config = resolveConfig(
      {
        targets: [{ name: 'ios', platform: 'ios' }],
        agent: { executor, maxModelCalls: 40, context: 'device hints' },
      },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    expect(config.agent.executor?.name).toBe('custom-brain');
    expect(config.agent.maxModelCalls).toBe(40);
    expect(config.agent.context).toBe('device hints');
  });
});
