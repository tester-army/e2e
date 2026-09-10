/**
 * Compile-time assertions on the public SDK surface. Never executed: `tsc`
 * (the package `typecheck` script) is the test, and every `@ts-expect-error`
 * below must stay necessary.
 */

import { z } from 'zod';
import {
  test,
  type Agent,
  type ArtifactStore,
  type AsyncExpectation,
  type E2EConfig,
  type Reporter,
  type RunEvent,
  type Screen,
  type TraceCacheStore,
} from '../../src/index.ts';
import type { EngineHandle } from '../../src/engine/index.ts';

declare const agent: Agent;
declare const remoteStore: TraceCacheStore;
declare const artifactStore: ArtifactStore;
declare const asyncExpectation: AsyncExpectation;
declare const screen: Screen;
declare const engine: EngineHandle;

({ cache: 'read-write' }) satisfies E2EConfig;
({ cache: { mode: 'read-only', store: remoteStore, dir: 'shared-cache' } }) satisfies E2EConfig;
({ targets: [{ platform: 'ios' }] }) satisfies E2EConfig;
// A target inherits its platform from the engine; the resolver rejects one with neither.
({ targets: [{ engine }] }) satisfies E2EConfig;
declare const model: import('../../src/types.ts').ModelInstance;
({ agents: { default: { model }, ux: { context: 'Review the UX.' } } }) satisfies E2EConfig;
// @ts-expect-error a model is an AI SDK instance the config constructs; the runner implies no gateway for a string
({ agents: { default: { model: 'openai/gpt-5.6-luna-fast' } } }) satisfies E2EConfig;
// @ts-expect-error agents are named: agents.default is what agent held
({ agent: { model } }) satisfies E2EConfig;
({ targets: [{ name: 'phone', engine }] }) satisfies E2EConfig;
// @ts-expect-error cache mode is a closed union
({ cache: 'sometimes' }) satisfies E2EConfig;
({ artifacts: ['screenshot', 'trace', 'video'] }) satisfies E2EConfig;
({ artifacts: { kinds: ['video'], store: artifactStore, video: { retain: 'on-failure' } } }) satisfies E2EConfig;
// @ts-expect-error artifact kinds are a closed union
({ artifacts: ['gif'] }) satisfies E2EConfig;
// @ts-expect-error video retention is a closed union
({ artifacts: { video: { retain: 'sometimes' } } }) satisfies E2EConfig;
({ put: async (artifact) => ({ ref: artifact.startedAt ?? artifact.sha256 }) }) satisfies ArtifactStore;
declare const reporter: Reporter;
({ reporters: ['list', reporter] }) satisfies E2EConfig;
({ reporters: [reporter] }) satisfies E2EConfig;
({
  name: 'upload',
  onEvent: (event: RunEvent) => void event.seq,
  onRunFinished: async (run) => [{ label: 'Results', text: run.report.run.id }],
}) satisfies Reporter;
// @ts-expect-error a reporter has a name
({ onRunFinished: async () => undefined }) satisfies Reporter;
// @ts-expect-error reporter ids are a closed union
({ reporters: ['xunit'] }) satisfies E2EConfig;
// @ts-expect-error attribute values must be text matches
asyncExpectation.toHaveAttribute('x', 42);
screen.getByRole('button', { name: 'Save', visible: true });
void screen.getByLabel('Plan').selectOption({ value: 'pro' });
// @ts-expect-error one of label, value, or index, never two
void screen.getByLabel('Plan').selectOption({ value: 'pro', index: 1 });
// @ts-expect-error role queries never match hidden nodes; visible is the one visibility knob
screen.getByRole('button', { hidden: true });

const actResult = await agent.act('open billing', { params: { plan: 'pro' }, timeout: 10_000 });
actResult.summary satisfies string;
actResult.modelCalls satisfies number;
// @ts-expect-error act returns no data; extract does
actResult.data;
// @ts-expect-error params travel inside the options bag
await agent.act('open billing', { plan: 'pro' }, {});
// @ts-expect-error act takes no schema; structured output is extract({ schema })
await agent.act('read total', { schema: z.object({ total: z.number() }) });
// @ts-expect-error act takes no vision option; assert, waitFor, and extract do
await agent.act('open billing', { vision: true });
await agent.waitFor('the page settles', { interval: 500, maxModelCalls: 3 });
// @ts-expect-error the wait interval is `interval`, in milliseconds
await agent.waitFor('the page settles', { intervalMs: 500 });
// @ts-expect-error extract has a fixed budget: one extraction plus one repair round
await agent.extract('read total', { schema: z.object({ total: z.number() }), maxModelCalls: 1 });

test.describe('synchronous', () => {});
// @ts-expect-error describe registration must be synchronous
test.describe('asynchronous', async () => {});
declare const condition: boolean;
// @ts-expect-error a conditionally async describe is still asynchronous
test.describe('conditionally asynchronous', () => condition ? undefined : Promise.resolve());

// A test, a group, and a call each pin a configured agent by name.
test('as the buyer', { agent: 'buyer' }, async () => {});
test.describe('admin flows', { agent: 'admin' }, () => {});
await agent.act('approve it', { agent: 'admin' });
await agent.assert('it is approved', { agent: 'buyer' });
