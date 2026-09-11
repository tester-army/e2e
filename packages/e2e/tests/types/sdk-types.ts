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
import { createAgent, defineTool, type DefaultAgent } from '../../src/agent/public.ts';
import type { Report } from '../../src/index.ts';

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

// A pin names one configured agent, or lists several to run the test once per agent.
test.describe('as one persona', { agent: 'buyer' }, () => {});
test.describe('as each persona', { agent: ['buyer', 'admin'] }, () => {});
test('as each persona', { agent: ['buyer', 'admin'] }, async () => {});
// @ts-expect-error a setup test runs once per target, so it pins at most one agent
test.setup('sign in', { sessions: ['buyer'], agent: ['buyer', 'admin'] }, async () => {});
declare const condition: boolean;
// @ts-expect-error a conditionally async describe is still asynchronous
test.describe('conditionally asynchronous', () => condition ? undefined : Promise.resolve());

// test.extend defines fixtures with setup and teardown; the body and the hooks see them typed.
interface Workspace {
  readonly id: string;
  cleanup(): Promise<void>;
}
declare const createWorkspace: () => Promise<Workspace>;
const withWorkspace = test.extend<{ workspace: Workspace }>({
  workspace: async ({ app }, use) => {
    await app.open();
    const workspace = await createWorkspace();
    await use(workspace);
    await workspace.cleanup();
  },
});
withWorkspace('renames it', async ({ workspace, app }) => {
  workspace.id satisfies string;
  await app.open();
});
withWorkspace.beforeEach(async ({ workspace }) => {
  workspace.id satisfies string;
});
// A fixture that needs another fixture goes in a chained extend.
withWorkspace.extend<{ member: string }>({
  member: async ({ workspace }, use) => {
    await use(workspace.id);
  },
});
test.extend<{ owner: string; member: string }>({
  owner: async (_fixtures, use) => {
    await use('owner');
  },
  // @ts-expect-error a definition sees the fixtures of the test it extends, not its siblings
  member: async ({ owner }, use) => {
    await use(owner);
  },
});
// @ts-expect-error a core fixture cannot be redefined
test.extend<{ agent: string }>({ agent: async (_fixtures, use) => { await use('x'); } });
// @ts-expect-error the value handed to use() has the declared fixture type
test.extend<{ count: number }>({ count: async (_fixtures, use) => { await use('one'); } });
// The zero-argument form still types an engine's contributed fixtures without defining them.
test.extend<{ device: unknown }>()('types a device', async ({ device }) => { device satisfies unknown; });

// A test, a group, and a call each pin a configured agent by name.
test('as the buyer', { agent: 'buyer' }, async () => {});
test.describe('admin flows', { agent: 'admin' }, () => {});
await agent.act('approve it', { agent: 'admin' });
await agent.assert('it is approved', { agent: 'buyer' });
// createAgent hands back what it was built from, so a host (e2e explore) can compose on it.
declare const seedCart: ReturnType<typeof defineTool>;
const projectAgent: DefaultAgent = createAgent({ tools: { seedCart }, system: 'Be thorough.' });
projectAgent.options.tools?.seedCart satisfies ReturnType<typeof defineTool> | undefined;
projectAgent.options.system satisfies string | undefined;
({ agents: { default: projectAgent } }) satisfies E2EConfig;
// @ts-expect-error the options are read-only
projectAgent.options = {};

// The report carries the exploration record only on an explore run; a finding's evidence is one of the attempt's artifacts.
declare const report: Report;
report.run.explore satisfies { goal: string; findings: readonly { severity: 1 | 2 | 3 | 4 | 5; artifactId?: string | undefined }[] } | undefined;
