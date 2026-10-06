/** Stable engine node identity: live agent actions must not retarget replacements. */

import { expect, it } from 'vitest';
import type { EngineSnapshot, SemanticNode } from '../../src/engine/index.ts';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { defineEngine, ENGINE_SPI_VERSION, engineFailure } from '../helpers/engine-runtime.ts';
import { runProject, resultByTitle } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const button = (id: string, name: string): SemanticNode => ({
  ref: { id, revision: '' },
  role: 'button',
  name,
});

interface IdentityCase {
  readonly title: string;
  readonly stable: boolean;
  readonly first: SemanticNode;
  readonly second: SemanticNode;
  readonly triggerStale: boolean;
  readonly observeReplacementBeforeAction?: boolean;
  readonly expectedPerformIds: readonly string[];
}

/** Builds a capture sequence whose first action races a capture change. */
function identityEngine(testCase: IdentityCase): { readonly engine: ReturnType<typeof defineEngine>; readonly performed: string[] } {
  const performed: string[] = [];
  let observations = 0;
  const captures: readonly EngineSnapshot[] = [
    snapshot([testCase.first], testCase.stable ? { nodeIdentity: 'stable' } : {}),
    snapshot([testCase.first], testCase.stable ? { nodeIdentity: 'stable' } : {}),
    snapshot([testCase.second], testCase.stable ? { nodeIdentity: 'stable' } : {}),
  ];
  return {
    engine: defineEngine({
      name: 'stable-identity-test',
      version: '1.0.0',
      spiVersion: ENGINE_SPI_VERSION,
      platform: 'test',
      actions: ['tap'],
      observe: async () => captures[Math.min(observations++, captures.length - 1)]!,
      perform: async (ref) => {
        performed.push(ref.id);
        if (testCase.triggerStale && performed.length === 1) {
          throw engineFailure('NODE_STALE', 'the capture moved before the action', true);
        }
      },
    }),
    performed,
  };
}

/** Uses the public executor actions surface so the harness owns stale recovery. */
function executor(observeReplacementBeforeAction: boolean): StepExecutor {
  return {
    name: 'stable-identity-test-executor',
    version: '1.0.0',
    async runStep(context) {
      const observation = await context.observe();
      const id = /#([^\s]+) button/.exec(observation.text)?.[1];
      if (id === undefined) return { status: 'failed', summary: 'the opening observation did not list a button' };
      if (observeReplacementBeforeAction) await context.observe();
      try {
        await context.actions.tap({ id });
        return { status: 'passed', summary: 'the button action completed' };
      } catch (cause) {
        return {
          status: 'passed',
          summary: `the stale action was rejected: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    },
  };
}

it.each<IdentityCase>([
  {
    title: 'stable identity rejects a replacement Save with a reused descriptor',
    stable: true,
    first: button('save-old', 'Save'),
    second: button('save-new', 'Save'),
    triggerStale: true,
    expectedPerformIds: ['save-old'],
  },
  {
    title: 'stable identity does not resolve a missing Save id by descriptor',
    stable: true,
    first: button('save-old', 'Save'),
    second: button('save-new', 'Save'),
    triggerStale: false,
    observeReplacementBeforeAction: true,
    expectedPerformIds: [],
  },
  {
    title: 'stable identity recovers when the same Save id is present after a stale action',
    stable: true,
    first: button('save', 'Save'),
    second: button('save', 'Save'),
    triggerStale: true,
    expectedPerformIds: ['save', 'save'],
  },
  {
    title: 'legacy identity keeps descriptor relocation for a renumbered Delete',
    stable: false,
    first: button('delete-old', 'Delete'),
    second: button('delete-new', 'Delete'),
    triggerStale: true,
    expectedPerformIds: ['delete-old', 'delete-new'],
  },
])('$title', async (testCase) => {
  const { engine, performed } = identityEngine(testCase);
  const suite = `import { test } from 'e2e';\n\ntest(${JSON.stringify(testCase.title)}, async ({ agent }) => {\n  await agent.act('tap the button');\n});\n`;
  const { outcome, project } = await runProject(
    { 'tests/identity.e2e.ts': suite },
    {
      config: {
        targets: [{ name: 'identity', platform: 'test', engine, app: { bundleId: 'identity.test' } }],
        tests: 'tests/**/*.e2e.ts',
        cache: 'off',
        agents: { default: { executor: executor(testCase.observeReplacementBeforeAction === true) } },
      },
    },
  );
  try {
    expect(resultByTitle(outcome, testCase.title).status).toBe('passed');
    expect(performed).toEqual(testCase.expectedPerformIds);
  } finally {
    project.cleanup();
  }
});
