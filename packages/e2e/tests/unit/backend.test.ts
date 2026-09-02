import { describe, expect, it } from 'vitest';
import { defineBackend, isBackendHandle, type Backend } from '../../src/backend/index.ts';
import { createBackendSession } from '../../src/backend/session.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import type { OperationContext, SemanticNode } from '../../src/driver/index.ts';

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
    spiVersion: 1,
    observe: async () => ({ nodes: [node('n1', 'Save'), node('n2', 'Cancel')] }),
    ...extra,
  };
}

describe('defineBackend', () => {
  it('computes the capability set from declared members', () => {
    const handle = defineBackend(observingBackend({ actions: { tap: async () => undefined } }));
    expect([...handle.capabilities].toSorted()).toEqual(['actions', 'observation']);
    expect(isBackendHandle(handle)).toBe(true);
  });

  it('rejects actions without observe: targets are observation refs', () => {
    expect(() =>
      defineBackend({ name: 'toy', spiVersion: 1, actions: { tap: async () => undefined } }),
    ).toThrow(/actions without observe/);
  });

  it('rejects unknown keys, pointing tools at the agent', () => {
    expect(() =>
      defineBackend({ ...observingBackend(), tools: [] } as unknown as Backend),
    ).toThrow(/tools belong on the agent/);
  });

  it('rejects unknown action verbs: the grammar is closed', () => {
    expect(() =>
      defineBackend(
        observingBackend({ actions: { swipe: async () => undefined } as never }),
      ),
    ).toThrow(/unknown action verb "swipe"/);
  });

  it('rejects unsupported spiVersion values', () => {
    expect(() => defineBackend({ ...observingBackend(), spiVersion: 2 as never })).toThrow(
      /spiVersion 2/,
    );
  });

  it('rejects an empty actions object', () => {
    expect(() => defineBackend(observingBackend({ actions: {} }))).toThrow(/no verbs/);
  });
});

describe('createBackendSession', () => {
  it('mints revisions and stamps them onto every ref', async () => {
    const session = createBackendSession({
      backend: defineBackend(observingBackend()),
      targetName: 'toy-target',
      baseHref: 'http://127.0.0.1:1/',
    });
    const first = await session.observe(OP);
    const second = await session.observe(OP);
    expect(first.revision).not.toBe(second.revision);
    expect(second.tree.children?.[0]?.ref.revision).toBe(second.revision);
    expect(second.redaction.complete).toBe(true);
  });

  it('routes grammar verbs to backend actions and fails loud on the rest', async () => {
    const calls: string[] = [];
    const session = createBackendSession({
      backend: defineBackend(
        observingBackend({
          actions: {
            tap: async (target) => void calls.push(`tap:${target.ref.id}`),
            press: async (target, key) => void calls.push(`press:${target.ref.id}:${key}`),
          },
        }),
      ),
      targetName: 'toy-target',
      baseHref: 'http://127.0.0.1:1/',
    });
    await session.actions.tap({ ref: { id: 'n1', revision: 'b1' } }, OP);
    await session.screen.perform({ id: 'n1', revision: 'b1' }, { kind: 'press', key: 'Enter' }, OP);
    expect(calls).toEqual(['tap:n1', 'press:n1:Enter']);
    await expect(
      session.actions.type({ ref: { id: 'n1', revision: 'b1' } }, 'x', false, OP),
    ).rejects.toThrow(/no backend capability for type/);
    await expect(session.screen.resolve({ kind: 'query' } as never, OP)).rejects.toThrow(
      /locators/,
    );
    await expect(session.artifacts.screenshot(undefined, OP)).rejects.toThrow(/screenshots/);
  });

  it('reports missing observation as an unsupported capability', async () => {
    const session = createBackendSession({
      backend: undefined,
      targetName: 'bare',
      baseHref: 'http://127.0.0.1:1/',
    });
    await expect(session.observe(OP)).rejects.toThrow(/no backend capability for observation/);
  });
});

describe('backend targets in config', () => {
  const ROOT = '/tmp/e2e-backend-config';

  it('resolves a backend target without driver, browser, or app url', () => {
    const backend = defineBackend(observingBackend());
    const config = resolveConfig(
      { targets: [{ name: 'ios-simulator', platform: 'ios', backend }] },
      { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
    );
    const target = config.targets[0];
    expect(target?.driver).toBeUndefined();
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

  it('still requires an app url when any driver target exists', () => {
    expect(() =>
      resolveConfig(
        { targets: [{ name: 'web', platform: 'web' }] },
        { projectRoot: ROOT, env: {} as NodeJS.ProcessEnv },
      ),
    ).toThrow(/app URL is required/);
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
