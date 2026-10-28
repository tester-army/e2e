/** A stale fill must re-enter secret authorization, on live actions and cached replay alike. */

import { describe, expect, it } from 'vitest';
import type { StepExecutor } from '../../src/agent/executor.ts';
import { EngineError, type SemanticNode } from 'e2e/engine';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting } from '../helpers/run-project.ts';

const SUITE = `import { test, credentials, expect } from 'e2e';
test('fills the account password', async ({ agent, screen }) => {
  await agent.act('fill the password', { params: { password: credentials.user('member').password } });
  await expect(screen.getByRole('status')).toBeVisible();
});
`;

describe('secret fill stale retry', () => {
  for (const replay of [false, true]) {
    it.each([false, true])(`reauthorizes a changed sink with disabled=%s during ${replay ? 'replay' : 'live execution'}`, async (disabled) => {
      const field: SemanticNode = {
        ref: { id: 'password', revision: '' }, role: 'textbox', name: 'Password',
        testId: 'password', inputPurpose: 'password', states: { secure: true },
        rect: { x: 40, y: 237, width: 322, height: 49 },
      };
      const tree = { ref: { id: 'root', revision: '' }, role: 'document', children: [field] };
      let stale = false;
      let dispatched = 0;
      const origins: string[] = [];
      const fake = createFakeEngine({
        tree,
        onStartAttempt: () => { tree.children = [field]; },
        locate: () => tree.children.filter((node) => node.role === 'status'),
        perform: (_ref, action, operation) => {
          if (action.kind !== 'fill') throw new Error('expected fill');
          origins.push(operation.origin);
          if (stale) {
            stale = false;
            tree.children = [{ ...field, states: { secure: true, disabled }, rect: { x: 40, y: 126, width: 322, height: 49 } }];
            throw new EngineError('NODE_STALE', 'input moved before mutation', { retryable: true });
          }
          dispatched += 1;
          tree.children.push({ ref: { id: 'saved', revision: '' }, role: 'status', name: 'Saved' });
        },
      });
      const executor: StepExecutor = {
        name: 'stale-secret',
        async runStep(context) {
          const observation = await context.observe();
          await context.actions.typeSecret({ id: nodeIdFor(observation.text, /textbox "Password"/) }, 'member.password');
          return { status: 'passed', summary: 'filled' };
        },
      };
      const project = createProject({ 'tests/input.e2e.ts': SUITE });
      const options = {
        config: {
          targets: [{ name: 'fake', platform: 'fake', engine: fake.engine }],
          agents: { default: { executor } },
          credentials: { member: { username: 'example', password: 'private-fixture-value' } },
          cache: 'read-write' as const,
        },
      };
      try {
        if (replay) {
          const recorded = await runExisting(project, options);
          const recording = resultByTitle(recorded, 'fills the account password');
          expect(recording.status).toBe('passed');
          expect(recording.attempts[0]?.steps.find((entry) => entry.api === 'agent.act')?.cache).toMatchObject({ write: 'saved' });
          dispatched = 0;
          origins.length = 0;
        }
        stale = true;
        const outcome = await runExisting(project, options);
        const result = resultByTitle(outcome, 'fills the account password');
        const step = result.attempts[0]!.steps.find((entry) => entry.api === 'agent.act')!;
        expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe(disabled ? 'failed' : 'passed');
        expect(dispatched).toBe(disabled ? 0 : 1);
        expect(origins).toEqual(Array(disabled ? 1 : 2).fill(replay ? 'test' : 'agent'));
        // A denied replay hands off to the executor, whose own denied action also counts.
        expect(step.metrics?.actionSteps).toBe(replay && disabled ? 2 : 1);
        expect(step.events.filter((event) => event.kind === 'observation' && event.name === 'relocate')).toHaveLength(1);
        expect(step.events.filter((event) => event.kind === 'policy' && event.name === 'secret.fill' && event.status === 'passed')).toHaveLength(disabled ? 1 : 2);
        if (disabled) expect(JSON.stringify(step)).toContain('POLICY_DENIED');
        if (replay && !disabled) expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 1 });
        expect(JSON.stringify(outcome)).not.toContain('private-fixture-value');
      } finally {
        project.cleanup();
      }
    }, 60_000);
  }
});
