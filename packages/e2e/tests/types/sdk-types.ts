/**
 * Compile-time assertions on the public SDK surface. Never executed: `tsc`
 * (the package `typecheck` script) is the test, and every `@ts-expect-error`
 * below must stay necessary.
 */

import { z } from 'zod';
import {
  credentials,
  expect,
  secrets,
  unique,
  test,
  type Agent,
  type App,
  type ArtifactStore,
  type AsyncExpectation,
  type E2EConfig,
  type Locator,
  type PollExpectation,
  type Reporter,
  type Role,
  type RoleAlias,
  type RunEvent,
  type Screen,
  type Secret,
  type Unique,
  type TraceCacheStore,
  type ExecutorObservation,
  type ValueExpectation,
} from '../../src/index.ts';
import type { EngineHandle, EngineObserveOptions, EngineSnapshot } from '../../src/engine/index.ts';
import { createAgent, defineTool, type DefaultAgent } from '../../src/agent/public.ts';
import type { Report } from '../../src/index.ts';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { chatgpt } from '../../src/oauth/chatgpt.ts';
import { copilot } from '../../src/oauth/copilot.ts';
import { grok } from '../../src/oauth/grok.ts';
// @ts-expect-error isDefinedTool left e2e/agent: createAgent checks each tools entry itself
import { isDefinedTool } from '../../src/agent/public.ts';
// @ts-expect-error BLOCKABLE_CODES left e2e: a blocked verdict carries any code the errors reference marks blocked
import { BLOCKABLE_CODES } from '../../src/index.ts';

isDefinedTool;
BLOCKABLE_CODES;

declare const agent: Agent;
declare const appFixture: App;
declare const remoteStore: TraceCacheStore;
declare const artifactStore: ArtifactStore;
declare const asyncExpectation: AsyncExpectation;
declare const screen: Screen;
declare const engine: EngineHandle;

({ pixels: false, pixelFallback: true }) satisfies EngineObserveOptions;
interface CustomSnapshot extends EngineSnapshot { readonly projectMetadata?: string }
interface CustomExecutorObservation extends ExecutorObservation { readonly projectMetadata?: string }
declare const customSnapshot: CustomSnapshot;
declare const customExecutorObservation: CustomExecutorObservation;
customSnapshot satisfies EngineSnapshot;
customExecutorObservation satisfies ExecutorObservation;
declare const engineSnapshot: EngineSnapshot;
engineSnapshot.treeUnavailable satisfies true | undefined;
// @ts-expect-error unavailable semantics are explicitly true or absent, never a separate false state.
({ ...engineSnapshot, treeUnavailable: false }) satisfies EngineSnapshot;

({ cache: 'read-write' }) satisfies E2EConfig;
({ cache: { mode: 'read-only', store: remoteStore, dir: 'shared-cache' } }) satisfies E2EConfig;
({ targets: [{ platform: 'ios' }] }) satisfies E2EConfig;
// A target inherits its platform from the engine; the resolver rejects one with neither.
({ targets: [{ engine }] }) satisfies E2EConfig;
declare const model: import('../../src/types.ts').ModelInstance;

// Secrets: a bare value or a provider; every handle is the same opaque Secret.
({ secrets: { key: 'sk_test', totp: () => '123456' } }) satisfies E2EConfig;
// @ts-expect-error a secret needs a value; an env variable that may be unset must be defaulted.
({ secrets: { key: process.env['STRIPE_KEY'] } }) satisfies E2EConfig;
secrets.get('key') satisfies Secret;
credentials.user('admin').password satisfies Secret;
// @ts-expect-error a Secret has no plaintext accessor.
secrets.get('key').value;
void screen.getByLabel('Key').fill(secrets.get('key'));
// @ts-expect-error a Secret is never typed as keystrokes; fill it.
void screen.getByLabel('Key').pressSequentially(secrets.get('key'));
void screen.getByLabel('City').pressSequentially('War', { delay: 50 });
void agent.act('use the key', { params: { apiKey: secrets.get('key') } });
// A run-unique value is marked, not inferred; the model still sees the string.
unique('E2E Company') satisfies Unique;
void agent.act('create {name}', { params: { name: unique(`E2E ${Date.now()}`), owner: { email: unique('a@b.test') } } });
// @ts-expect-error unique() marks a string.
unique(7);
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
declare const runEvent: RunEvent;
if (runEvent.type === 'step') {
  runEvent.progress.identity?.attemptId satisfies string | undefined;
  runEvent.progress.identity?.attemptIndex satisfies number | undefined;
  runEvent.progress.identity?.stepId satisfies string | undefined;
  runEvent.progress.identity?.stepIndex satisfies number | undefined;
  if (runEvent.progress.phase === 'end') {
    runEvent.progress.error?.code satisfies string | undefined;
    runEvent.progress.explanation satisfies string | undefined;
  }
  // @ts-expect-error only the end phase carries the step error
  runEvent.progress.error;
}
// @ts-expect-error a reporter has a name
({ onRunFinished: async () => undefined }) satisfies Reporter;
// @ts-expect-error reporter ids are a closed union
({ reporters: ['xunit'] }) satisfies E2EConfig;
// @ts-expect-error attribute values must be text matches
asyncExpectation.toHaveAttribute('x', 42);
// Set reads answer with lists and never wait; the list form of a text matcher takes strings and RegExps.
void (screen.getByTestId('todo').all() satisfies Promise<Locator[]>);
void (screen.getByTestId('todo').allTextContents() satisfies Promise<string[]>);
void (screen.getByTestId('todo').isHidden() satisfies Promise<boolean>);
void (screen.getByTestId('todo').isDisabled() satisfies Promise<boolean>);
void asyncExpectation.toBeAttached({ timeout: 1000 });
void asyncExpectation.toHaveText(['a', /b/], { timeout: 1000 });
void asyncExpectation.toContainText(['a', /b/]);
// @ts-expect-error a text list holds strings and RegExps only
void asyncExpectation.toHaveText(['a', 1]);
// @ts-expect-error only toHaveText and toContainText take a list; a value is one string
void asyncExpectation.toHaveValue(['a']);

// expect.poll carries every value matcher and no other, each resolving to void.
declare const pollMatcherNames: Exclude<keyof PollExpectation<string>, 'not'>;
declare const valueMatcherNames: Exclude<keyof ValueExpectation<string>, 'not'>;
pollMatcherNames satisfies typeof valueMatcherNames;
valueMatcherNames satisfies typeof pollMatcherNames;
void (expect.poll(() => 'x', { timeout: 15_000, interval: 250, message: 'never settled' }).toBe('x') satisfies Promise<void>);
void (expect.poll(async () => 1).not.toBeGreaterThan(1) satisfies Promise<void>);
// @ts-expect-error the matcher is typed by what the read returns
void expect.poll(() => 'x').toBe(1);
// @ts-expect-error poll takes a read function, not the value itself
void expect.poll('x').toBe('x');
// @ts-expect-error the synchronous matchers take no options; a value that is still settling goes through expect.poll
expect('x').toBe('x', { timeout: 1000 });
screen.getByRole('button', { name: 'Save', visible: true });
screen.getByRole('heading', { name: 'Dashboard', level: 1 });
// The vocabulary names composite widgets and structure, and takes ARIA's img as an alias of image.
screen.getByRole('img', { name: 'Logo' });
screen.getByRole('tablist', { name: 'Filter' }).getByRole('tab', { selected: true });
screen.getByRole('menu').getByRole('menuitemcheckbox', { checked: true });
screen.getByRole('progressbar');
screen.getByRole('toolbar').getByRole('spinbutton');
screen.getByRole('tree').getByRole('treeitem', { expanded: true });
screen.getByRole('grid').getByRole('rowgroup').getByRole('gridcell');
// @ts-expect-error the vocabulary is closed; a role outside it is a type error, not a runtime miss
screen.getByRole('carousel');
// @ts-expect-error a Playwright role the vocabulary does not carry stays out
screen.getByRole('generic');
// @ts-expect-error img is an alias getByRole accepts, never a Role an engine emits
'img' satisfies Role;
'image' satisfies Role;
'img' satisfies RoleAlias;
// A message names a value check; the synchronous matchers still take no options.
expect(1, 'why this holds').toBe(1);
expect(1, 'why this holds').not.toBeCloseTo(2, 0);
// The Jest-shaped matchers, each also on expect.poll through the derived type.
expect([1]).toHaveLength(1);
expect({ a: 1 }).toMatchObject({ a: expect.any(Number) });
expect({ a: { b: 1 } }).toHaveProperty('a.b');
expect({ a: { b: 1 } }).toHaveProperty(['a', 'b'], 1);
expect({ a: [1] }).toHaveProperty(['a', 0], expect.anything());
void (expect.poll(() => ({ a: 1 })).toHaveProperty('a') satisfies Promise<void>);
void (expect.poll(() => [1]).not.toHaveLength(2) satisfies Promise<void>);
// @ts-expect-error toMatchObject takes an object to match against
expect({ a: 1 }).toMatchObject(1);
// @ts-expect-error a property path is dotted text or a key array
expect({ a: 1 }).toHaveProperty({ a: 1 });
// The asymmetric matchers stand in for a value anywhere a structural matcher compares one.
expect(1).toEqual(expect.any(Number));
expect(1n).toEqual(expect.any(BigInt));
expect(Symbol('s')).toEqual(expect.any(Symbol));
expect(['a']).toContain(expect.stringContaining('a'));
expect(['a']).toEqual(expect.arrayContaining([expect.stringMatching(/a/)]));
expect({ a: 1 }).toEqual(expect.objectContaining({ a: expect.anything() }));
// @ts-expect-error expect.any takes a class or a primitive constructor, not a value
expect.any(1);
// @ts-expect-error expect.arrayContaining takes an array
expect.arrayContaining('a');
// @ts-expect-error expect.stringContaining takes text
expect.stringContaining(/a/);
// expect.soft has the expect call's three shapes and no poll of its own.
expect.soft(1, 'why this holds').toBe(1);
void (expect.soft(screen.getByRole('button')).toBeVisible() satisfies Promise<void>);
// @ts-expect-error soft is the call, not the whole entry
expect.soft.poll(() => 1);
// @ts-expect-error soft has no statics either
expect.soft.any(Number);
// Inside a body, skip takes a condition and a reason, or a reason alone; registration keeps its title and body.
test.skip(true, 'not today');
test.skip('not today');
test.skip('later', async () => {});
void screen.getByLabel('Plan').selectOption({ value: 'pro' });
// @ts-expect-error one of label, value, or index, never two
void screen.getByLabel('Plan').selectOption({ value: 'pro', index: 1 });
// @ts-expect-error role queries never match hidden nodes; visible is the one visibility knob
screen.getByRole('button', { hidden: true });

// Coordinate input: a viewport point on screen, a node-relative one on a locator.
declare const point: import('../../src/types.ts').Point;
void screen.tapAt(point, { timeout: 1_000 });
void screen.swipe({ direction: 'up', momentum: 'fast' });
void screen.swipe({ from: point, to: point });
void screen.getByRole('image').tap({ position: point, timeout: 1_000 });
void screen.getByRole('image').click({ position: point });
// @ts-expect-error a point has both coordinates.
void screen.tapAt({ x: 1 });
// @ts-expect-error a path swipe names both ends.
void screen.swipe({ from: point });
// @ts-expect-error a swipe is a direction or a path, never both.
void screen.swipe({ direction: 'up', to: point });
// @ts-expect-error a locator swipe is directional; the path form is screen.swipe.
void screen.getByRole('image').swipe({ from: point, to: point });
// @ts-expect-error a surface without a url has no base URL; a test must handle undefined
const appOrigin: string = appFixture.baseUrl;
void appOrigin;
// @ts-expect-error the base URL is the runner's to resolve, never a test's to set
appFixture.baseUrl = 'http://127.0.0.1:3000/';

const actResult = await agent.act('open billing', { params: { plan: 'pro' }, timeout: 10_000 });
actResult.summary satisfies string;
actResult.modelCalls satisfies number;
// @ts-expect-error act returns no data; extract does
actResult.data;
// @ts-expect-error params travel inside the options bag
await agent.act('open billing', { plan: 'pro' }, {});
// @ts-expect-error act takes no schema; structured output is extract({ schema })
await agent.act('read total', { schema: z.object({ total: z.number() }) });
// @ts-expect-error act takes no vision; the model asks for a screenshot itself
await agent.act('open billing', { vision: true });
// @ts-expect-error act takes no vision; the model asks for a screenshot itself
await agent.act('pick the red pin', { vision: 'only' });
await agent.assert('the chart trends upward', { vision: true });
await agent.assert('the form is not covered', { vision: 'only' });
// @ts-expect-error a judgment's vision is a closed set: true, false, or 'only'
await agent.assert('the chart trends upward', { vision: 'always' });
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
// One complete agent: model, how it works, and the app's vocabulary in one call; the options object needs no second key.
declare const sdkModel: NonNullable<NonNullable<Parameters<typeof createAgent>[0]>['model']>;
const completeAgent = createAgent({ model: sdkModel, system: 'Be thorough.', context: 'Plans are called tiers.' });
completeAgent.options.context satisfies string | undefined;
({ agents: { default: { executor: completeAgent } } }) satisfies E2EConfig;
// @ts-expect-error context is one string, as agents.<name>.context is
createAgent({ model: sdkModel, context: ['Plans are called tiers.'] });
// @ts-expect-error the options are read-only
projectAgent.options = {};

// The report carries the exploration record only on an explore run; a finding's evidence is one of the attempt's artifacts.
declare const report: Report;
// Every result carries its tags, an empty list when the test declares none.
report.run.results[0]!.tags satisfies readonly string[];
// Every result says which `--repeat-each` run it is, 0 without the flag.
report.run.results[0]!.repeat satisfies number;
report.run.explore satisfies { goal: string; findings: readonly { severity: 1 | 2 | 3 | 4 | 5; artifactId?: string | undefined }[] } | undefined;

// An explore run's events narrow to the exploration's progress.
if (runEvent.type === 'explore') {
  runEvent.progress.phase satisfies 'started' | 'planning' | 'step-started' | 'step-finished' | 'finding' | 'finished';
  if (runEvent.progress.phase === 'finding') runEvent.progress.finding.severity satisfies 1 | 2 | 3 | 4 | 5;
}

// e2e/oauth/*: a constructor takes the model id alone; the login comes from e2e login or E2E_OAUTH_CREDENTIALS.
chatgpt('gpt-5.6-luna') satisfies LanguageModelV4;
copilot('gpt-4.1') satisfies LanguageModelV4;
grok('grok-4') satisfies LanguageModelV4;
// @ts-expect-error the store and apiUrl options are gone
chatgpt('gpt-5.6-luna', {});
// @ts-expect-error the store and baseURL options are gone
copilot('gpt-4.1', {});
// @ts-expect-error the store and baseURL options are gone
grok('grok-4', {});
