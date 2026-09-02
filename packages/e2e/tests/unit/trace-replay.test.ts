/** Zero-turn replay: typed dispatch, relocation backoff, divergence (RFC0001 cache-in). */

import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorActions } from '../../src/agent/executor.ts';
import { replayTrace, type ReplayHost } from '../../src/agent/replay.ts';
import type { ActionTrace, RecordedAction } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/backend/surface.ts';

const upgrade: SemanticNode = { ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Upgrade' };
const email: SemanticNode = { ref: { id: 'n2', revision: 'r1' }, role: 'textbox', name: 'Email' };

function trace(actions: RecordedAction[]): ActionTrace {
  return { actions, executor: { name: 'test' }, summary: 'done' };
}

const tapUpgrade: RecordedAction = {
  name: 'tap',
  summary: 'tap button "Upgrade"',
  target: { role: 'button', name: 'Upgrade' },
};

function makeHost(options: {
  nodes?: SemanticNode[];
  onAction?: (name: string, detail: unknown) => void | Promise<void>;
}): ReplayHost & { calls: string[] } {
  const calls: string[] = [];
  const act = (name: string, detail?: unknown) => {
    calls.push(name);
    return Promise.resolve(options.onAction?.(name, detail)).then(() => undefined);
  };
  const actions: ExecutorActions = {
    tap: (t) => act('tap', t),
    type: (t, value) => act('type', { t, value }),
    typeSecret: (t, name) => act('typeSecret', { t, name }),
    press: (t, key) => act('press', { t, key }),
    select: (t, value) => act('select', { t, value }),
    scroll: (direction, t) => act('scroll', { direction, t }),
    navigate: (url) => act('navigate', url),
  };
  return {
    calls,
    observeNodes: async () => new Map((options.nodes ?? [upgrade, email]).map((n) => [n.ref.id, n])),
    latestShape: () => 'stable',
    actions,
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    redact: (text) => text,
    testIdAttribute: 'data-testid',
  };
}

describe('replayTrace', () => {
  it('replays a full trace and reports completion', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([
        { name: 'navigate', summary: 'navigate to "/"', url: '/' },
        tapUpgrade,
        { name: 'type', summary: 'type "x"', target: { role: 'textbox', name: 'Email' }, value: 'x' },
        { name: 'scroll', summary: 'scroll down', direction: 'down' },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 4, total: 4 });
    expect(host.calls).toEqual(['navigate', 'tap', 'type', 'scroll']);
    expect(outcome.summaries).toHaveLength(4);
  });

  it('ends the prefix at a gap without executing it', async () => {
    const host = makeHost({});
    const outcome = await replayTrace(
      host,
      trace([tapUpgrade, { name: 'tool', summary: 'tool seed_cart' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'gap' });
    expect(host.calls).toEqual(['tap']);
  });

  it('diverges with target-not-found when relocation never matches', async () => {
    const host = makeHost({ nodes: [email] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, executed: 0, stopReason: 'target-not-found' });
  }, 15_000);

  it('relocates by semantic identity when a recorded test id churned', async () => {
    const churned: SemanticNode = {
      ref: { id: 'n5', revision: 'r1' },
      role: 'button',
      name: 'Activate plan',
      attributes: { 'data-testid': 'toggle-zz9-r4-0' },
    };
    const host = makeHost({ nodes: [churned, email] });
    const outcome = await replayTrace(
      host,
      trace([
        {
          name: 'tap',
          summary: 'tap button "Activate plan"',
          target: { role: 'button', name: 'Activate plan', testId: 'toggle-aa1-r0-0' },
        },
      ]),
    );
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(host.calls).toEqual(['tap']);
  });

  it('diverges immediately on ambiguity', async () => {
    const twin: SemanticNode = { ref: { id: 'n9', revision: 'r1' }, role: 'button', name: 'Upgrade' };
    const host = makeHost({ nodes: [upgrade, twin] });
    const outcome = await replayTrace(host, trace([tapUpgrade]));
    expect(outcome).toMatchObject({ completed: false, stopReason: 'target-ambiguous' });
    expect(host.calls).toEqual([]);
  });

  it('absorbs an action failure as divergence, never as a step failure', async () => {
    const host = makeHost({
      onAction: (name) => {
        if (name === 'tap') throw new AgentError('ACTION_FAILED', 'element detached');
      },
    });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'navigate', summary: 'navigate', url: '/' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({ completed: false, executed: 1, stopReason: 'action-failed' });
  });

  it('surfaces an unknown commit state as action-uncertain with the action named', async () => {
    const host = makeHost({
      onAction: (name) => {
        if (name === 'tap') {
          const uncertain = new Error('input may have reached the app') as Error & { code: string };
          uncertain.code = 'ACTION_MAY_HAVE_COMMITTED';
          throw new Error('action failed', { cause: uncertain });
        }
      },
    });
    const outcome = await replayTrace(
      host,
      trace([{ name: 'navigate', summary: 'navigate', url: '/' }, tapUpgrade]),
    );
    expect(outcome).toMatchObject({
      completed: false,
      executed: 1,
      stopReason: 'action-uncertain',
      uncertainAction: 'tap button "Upgrade"',
    });
  });

  it('rethrows runtime hard stops untouched', async () => {
    const host = makeHost({
      onAction: () => {
        throw new AgentError('STEP_BUDGET_EXHAUSTED', 'out of actions');
      },
    });
    await expect(replayTrace(host, trace([tapUpgrade]))).rejects.toMatchObject({
      code: 'STEP_BUDGET_EXHAUSTED',
    });
  });
});
