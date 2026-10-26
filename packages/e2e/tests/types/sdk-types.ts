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
  type ExecutorVerb,
  type FinishedRun,
  type KeyModifier,
  type Locator,
  type ModelInstance,
  type PointHit,
  type PointTapResult,
  type PollExpectation,
  type RecordingMode,
  type Reporter,
  type Role,
  type RoleAlias,
  type RunEvent,
  type RunExitCode,
  type RunStatus,
  type Screen,
  type Secret,
  type StepExecutor,
  type StepExecutorContext,
  type StepTurn,
  type StoredArtifactLink,
  type Target,
  type TestFilter,
  type TestFilterCandidate,
  type TestFilterContext,
  type Unique,
  type CacheStore,
  type ExecutorObservation,
  type ValueExpectation,
  type StandardSchemaV1,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
} from '../../src/index.ts';
import type { Engine, EngineAttemptContext, EngineCleanupContext, EngineDisposeContext, EngineHandle, EngineObserveOptions, EngineSnapshot } from '../../src/engine/index.ts';
import { createToolLoopExecutor, defineTool } from '../../src/agent/public.ts';
import type { Report } from '../../src/index.ts';
import type { LanguageModelV2, LanguageModelV3, LanguageModelV4 } from '@ai-sdk/provider';
import { chatgpt } from '../../src/oauth/chatgpt.ts';
import { copilot } from '../../src/oauth/copilot.ts';
import { grok } from '../../src/oauth/grok.ts';
import { opencodeConsole } from '../../src/oauth/opencode-console.ts';
// @ts-expect-error isDefinedTool left e2e/agent: config loading checks each tools entry itself
import { isDefinedTool } from '../../src/agent/public.ts';
// @ts-expect-error createAgent left e2e/agent: an agents entry is the plain object it took
import { createAgent } from '../../src/agent/public.ts';
// @ts-expect-error BLOCKABLE_CODES left e2e: a blocked verdict carries any code the errors reference marks blocked
import { BLOCKABLE_CODES } from '../../src/index.ts';
// @ts-expect-error list is e2e/runner: importing e2e does not load the runner
import { list as listFromE2E } from '../../src/index.ts';
// @ts-expect-error suite execution belongs to e2e/runner, not the test SDK
import { run as runFromE2E } from '../../src/index.ts';
// @ts-expect-error openHost is e2e/runner: importing e2e does not load the runner
import { openHost as openHostFromE2E } from '../../src/index.ts';
// @ts-expect-error exploration belongs to e2e/runner, not the test SDK
import { explore as exploreFromE2E } from '../../src/index.ts';
// @ts-expect-error host types belong to e2e/runner, not the test SDK
import type { E2EHost as E2EHostFromE2E } from '../../src/index.ts';
// @ts-expect-error the unpublished top-level openSession was replaced by openHost
import { openSession as removedOpenSession } from '../../src/runner.ts';
import {
  ConfigurationError,
  type E2EHost,
  type E2ESession,
  explore,
  type ExploreOptions,
  type ExploreResult,
  isE2EError,
  list,
  type ListedPair,
  type ListOptions,
  openHost,
  run,
  type RunEventSink,
  type RunOptions,
  type RunResult,
  type OpenHostOptions,
  type OpenSessionOptions,
  type SerializedError,
  type StepProgress,
  type StepRecord,
} from '../../src/runner.ts';

isDefinedTool;
createAgent;
BLOCKABLE_CODES;
listFromE2E;
runFromE2E;
openHostFromE2E;
exploreFromE2E;
removedOpenSession;
declare const rootHost: E2EHostFromE2E;
rootHost;

declare const agent: Agent;
declare const appFixture: App;
declare const remoteStore: CacheStore;
// @ts-expect-error TraceCacheStore is CacheStore: the store serves the replay cache
declare const renamedStore: import('../../src/index.ts').TraceCacheStore;
renamedStore;
declare const artifactStore: ArtifactStore;
declare const asyncExpectation: AsyncExpectation;
declare const screen: Screen;
declare const engine: EngineHandle;
declare const targets: readonly Target[];

void (screen.tree() satisfies Promise<string>);
void (screen.debug({ timeout: 1000 }) satisfies Promise<void>);
// @ts-expect-error tree reads the whole screen; a locator does not scope it
void screen.getByRole('list').tree();

declare const cleanupContext: EngineCleanupContext;
declare const disposeContext: EngineDisposeContext;
cleanupContext satisfies EngineDisposeContext;
disposeContext.reuseSignal satisfies AbortSignal | undefined;
({ signal: cleanupContext.signal, timeoutMs: 100, reuseSignal: cleanupContext.signal }) satisfies EngineDisposeContext;
// @ts-expect-error Reuse permission is an AbortSignal, not a worker message.
({ signal: cleanupContext.signal, timeoutMs: 100, reuseSignal: 'shutdown' }) satisfies EngineDisposeContext;
// @ts-expect-error Reuse permission cannot be reassigned by an engine.
disposeContext.reuseSignal = cleanupContext.signal;
// @ts-expect-error Attempt cleanup does not receive worker reuse permission.
cleanupContext.reuseSignal;
declare const attemptCleanupContext: Parameters<NonNullable<Engine['endAttempt']>>[0];
// @ts-expect-error Only disposal receives worker reuse permission.
attemptCleanupContext.reuseSignal;
({
  name: 'legacy-cleanup', version: '1.0.0', spiVersion: 1,
  async dispose(_context: EngineCleanupContext) {},
}) satisfies Engine;

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
// The measured keyboard is a yes or no, or absent when the engine did not measure it.
engineSnapshot.keyboardVisible satisfies boolean | undefined;
customExecutorObservation.keyboardVisible satisfies boolean | undefined;
// @ts-expect-error the keyboard state carries no band or reason, only whether one is showing.
({ ...engineSnapshot, keyboardVisible: { kind: 'visible' } }) satisfies EngineSnapshot;

// There is no implicit target: a config names at least one, and the type says so before the loader does.
// @ts-expect-error targets is required
({ cache: 'read-write' }) satisfies E2EConfig;
({ targets, cache: 'read-write' }) satisfies E2EConfig;
({ targets, failOnSkippedFailure: true }) satisfies E2EConfig;
({ targets, maxDuration: 900_000 }) satisfies E2EConfig;
({ targets, cache: { mode: 'read-only', store: remoteStore, dir: 'shared-cache' } }) satisfies E2EConfig;
({ targets: [{ platform: 'ios' }] }) satisfies E2EConfig;
// @ts-expect-error specVersion is gone; the runner version is the format version
({ targets, specVersion: '0.1' }) satisfies E2EConfig;
// A target inherits its platform from the engine; the resolver rejects one with neither.
({ targets: [{ engine }] }) satisfies E2EConfig;
({
  targets: [{ engine, app: { url: 'http://localhost:3000', command: { executable: 'pnpm', args: ['dev'] }, readyUrl: 'http://localhost:3000/health' } }],
}) satisfies E2EConfig;
({
  targets: [{ engine, app: { bundleId: 'dev.shop.app', appPath: './build/Shop.app', launchArguments: ['-e2e'], permissions: { camera: 'grant' } } }],
}) satisfies E2EConfig;
// @ts-expect-error a permission is granted, denied, or reset; there is no `allow`
({ targets: [{ engine, app: { bundleId: 'dev.shop.app', permissions: { camera: 'allow' } } }] }) satisfies E2EConfig;
// @ts-expect-error launch arguments are the strings the launch command takes
({ targets: [{ engine, app: { bundleId: 'dev.shop.app', launchArguments: [1] } }] }) satisfies E2EConfig;
// @ts-expect-error the app URL is the target's app.url, not a key of the target itself
({ targets: [{ engine, url: 'http://localhost:3000' }] }) satisfies E2EConfig;
// @ts-expect-error an engine only drives the app: the target declares it
({ name: 'toy', version: '1.0.0', spiVersion: 1, app: { url: 'http://localhost:3000' } }) satisfies Engine;
({ name: 'toy', version: '1.0.0', spiVersion: 1, validateApp: (app, { targetName }) => void [app.bundleId, targetName] }) satisfies Engine;
// @ts-expect-error a target declares its app; there is no services list in this version
({ targets: [{ engine, app: { url: 'http://localhost:3000' }, services: [] }] }) satisfies E2EConfig;
declare const model: ModelInstance;
// A model is the live AI SDK object: every LanguageModelV2 through V4 assigns, and so does a subscription constructor.
declare const modelV2: LanguageModelV2;
declare const modelV3: LanguageModelV3;
declare const modelV4: LanguageModelV4;
declare const subscriptionModel: ReturnType<typeof chatgpt>;
modelV2 satisfies ModelInstance;
modelV3 satisfies ModelInstance;
modelV4 satisfies ModelInstance;
subscriptionModel satisfies ModelInstance;
// @ts-expect-error the three id strings alone are not a model; the loader rejects an object without doGenerate
({ specificationVersion: 'v4', provider: 'openai', modelId: 'gpt-5.6-luna' }) satisfies ModelInstance;

// Secrets: a bare value or a provider; every handle is the same opaque Secret.
({ targets, secrets: { key: 'sk_test', totp: () => '123456' } }) satisfies E2EConfig;
// @ts-expect-error a secret needs a value; an env variable that may be unset must be defaulted.
({ targets, secrets: { key: process.env['STRIPE_KEY'] } }) satisfies E2EConfig;
secrets.get('key') satisfies Secret;
// An engine declares the secrets its options hold and resolves them per attempt.
({ name: 'gated', version: '1.0.0', spiVersion: 1, secrets: [secrets.get('key')] }) satisfies Engine;
// @ts-expect-error an engine declares secrets.get() handles, never the values.
({ name: 'gated', version: '1.0.0', spiVersion: 1, secrets: ['sk_test'] }) satisfies Engine;
declare const attemptContext: EngineAttemptContext;
attemptContext.resolveSecret(secrets.get('key')) satisfies Promise<string>;
// The forms the app sees in place of the value join its redaction.
void attemptContext.resolveSecret(secrets.get('key'), { derived: (plaintext) => [Buffer.from(`ada:${plaintext}`).toString('base64')] });
// @ts-expect-error a derived form is a string computed from the value, never the handle itself.
void attemptContext.resolveSecret(secrets.get('key'), { derived: () => [secrets.get('key')] });
// An engine reports what the app logged, one line from a closed source and level each.
attemptContext.appLog({ source: 'network', level: 'error', text: 'GET /api/todos 500' });
// @ts-expect-error an app log source is a closed union.
attemptContext.appLog({ source: 'stdout', level: 'error', text: 'boom' });
// @ts-expect-error where the app went is its own report, not an app log line.
attemptContext.appLog({ source: 'navigation', level: 'info', text: 'navigated to /login' });
attemptContext.navigation('navigated to /login');
declare const actCache: NonNullable<Awaited<ReturnType<Agent['act']>>['cache']>;
actCache.entry satisfies string | undefined;
actCache.recordedBy satisfies { readonly provider: string; readonly model: string } | undefined;
// @ts-expect-error a recording model id must be a string.
({ provider: 'test', model: 1 }) satisfies NonNullable<typeof actCache.recordedBy>;
// @ts-expect-error what became of the recording is known once the attempt ends, so only the report has it.
void actCache.write;
credentials.user('admin').password satisfies Secret;
({ targets, credentials: { admin: { username: 'admin', password: () => 'admin-pass' } } }) satisfies E2EConfig;
// @ts-expect-error only password may be a provider function; username is a plain string.
({ targets, credentials: { admin: { username: () => 'admin', password: 'admin-pass' } } }) satisfies E2EConfig;
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
({ targets, agents: { default: { model }, ux: { context: 'Review the UX.' } } }) satisfies E2EConfig;
// @ts-expect-error a model is an AI SDK instance the config constructs; the runner implies no gateway for a string
({ targets, agents: { default: { model: 'openai/gpt-5.6-luna-fast' } } }) satisfies E2EConfig;
// @ts-expect-error agents are named: agents.default is what agent held
({ targets, agent: { model } }) satisfies E2EConfig;
({ targets: [{ name: 'phone', engine }] }) satisfies E2EConfig;
// @ts-expect-error cache mode is a closed union
({ targets, cache: 'sometimes' }) satisfies E2EConfig;
({ targets, artifacts: { store: artifactStore } }) satisfies E2EConfig;
// @ts-expect-error artifacts no longer lists kinds; trace and video choose the recordings
({ targets, artifacts: ['screenshot', 'trace'] }) satisfies E2EConfig;
// @ts-expect-error artifacts.kinds was removed
({ targets, artifacts: { kinds: ['trace'], store: artifactStore } }) satisfies E2EConfig;
// @ts-expect-error artifacts.trace was removed; trace is a mode at the config root
({ targets, artifacts: { trace: { record: 'retries' } } }) satisfies E2EConfig;
// @ts-expect-error video retention moved to the video mode
({ targets, artifacts: { video: { retain: 'on-failure' } } }) satisfies E2EConfig;
({ targets, trace: 'on-all-retries', video: 'retain-on-failure' }) satisfies E2EConfig;
({ targets: [{ name: 'phone', engine, trace: 'off', video: 'on-first-retry' }], trace: 'on', video: 'off' }) satisfies E2EConfig;
'on-all-retries' satisfies RecordingMode;
// @ts-expect-error trace is a closed set of modes; record: 'retries' is on-all-retries
({ targets, trace: 'retries' }) satisfies E2EConfig;
// @ts-expect-error video is a closed set of modes
({ targets, video: 'sometimes' }) satisfies E2EConfig;
// @ts-expect-error video is a mode, not a boolean
({ targets, video: true }) satisfies E2EConfig;
// @ts-expect-error trace is a mode, not a boolean
({ targets: [{ name: 'phone', engine, trace: true }] }) satisfies E2EConfig;
({ put: async (artifact) => ({ ref: artifact.startedAt ?? artifact.sha256 }) }) satisfies ArtifactStore;
({
  put: async (artifact) => ({ ref: artifact.sha256 }),
  putLink: async (link: StoredArtifactLink) => ({ ref: `${link.url}#${link.attemptId}@${link.startedAt}` }),
}) satisfies ArtifactStore;
({ kind: 'video', url: 'https://r.example/a.mp4', mediaType: 'video/mp4', redaction: 'incomplete', runId: 'r', testId: 't', attemptId: 'a', startedAt: '2026-01-01T00:00:00.000Z' }) satisfies StoredArtifactLink;
// @ts-expect-error a link has no bytes, and only video links exist
({ kind: 'trace', url: 'https://r.example/a.zip', mediaType: 'application/zip', redaction: 'incomplete', runId: 'r', testId: 't', attemptId: 'a', startedAt: '2026-01-01T00:00:00.000Z' }) satisfies StoredArtifactLink;
({ targets, output: 'results/e2e' }) satisfies E2EConfig;
// @ts-expect-error output is one directory
({ targets, output: ['a', 'b'] }) satisfies E2EConfig;
declare const reporter: Reporter;
({ targets, reporters: ['list', reporter] }) satisfies E2EConfig;
({ targets, reporters: [reporter] }) satisfies E2EConfig;
({
  name: 'upload',
  onEvent: (event: RunEvent) => void event.seq,
  onRunFinished: async (finished) => [{ label: 'Results', text: finished.report.run.id }],
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
({ targets, reporters: ['xunit'] }) satisfies E2EConfig;

// A test filter is a named object under filters; it answers with the tests to leave out, each with a reason.
const areas = {
  name: 'areas',
  filter: (tests) => ({
    exclude: Object.fromEntries(tests.filter((candidate) => !candidate.tags.includes('auth')).map((candidate) => [candidate.id, 'the diff reaches none of its tags'])),
  }),
} satisfies TestFilter;
const jev = {
  name: 'jev',
  async filter(tests, { projectRoot, changes, signal, log, redact }) {
    log(`asking about ${tests.length} tests in ${projectRoot}, ${changes.root} against ${changes.base}`);
    signal satisfies AbortSignal;
    const exclude: Record<string, string> = {};
    for (const candidate of tests) exclude[candidate.id] = redact(`${candidate.file}: ${candidate.titlePath.join(' > ')}`);
    return { exclude, note: 'one call' };
  },
} satisfies TestFilter;
({ targets, filters: [areas, jev] }) satisfies E2EConfig;
// @ts-expect-error filters is a list, not a record of entries
({ targets, filters: { affected: areas } }) satisfies E2EConfig;
// @ts-expect-error a filter is an object with a name, not a bare function
({ targets, filters: [() => ({ exclude: {} })] }) satisfies E2EConfig;
// @ts-expect-error a filter has a name
({ targets, filters: [{ filter: () => ({ exclude: {} }) }] }) satisfies E2EConfig;
// @ts-expect-error a filter leaves tests out by id with a reason; it never lists the ones to keep
({ name: 'jev', filter: () => ({ keep: [] }) }) satisfies TestFilter;
declare const filterCandidate: TestFilterCandidate;
// @ts-expect-error a candidate names a test, never its body
filterCandidate.fn;
// @ts-expect-error a candidate is read-only
filterCandidate.tags.push('smoke');
filterCandidate.setupFile satisfies string | undefined;
declare const filterContext: TestFilterContext;
// @ts-expect-error the change is read-only
filterContext.changes.files.push('src/a.ts');
filterContext.configFile satisfies string | undefined;
// @ts-expect-error a filter takes its tests read-only: the runner freezes them
({ name: 'sorts', filter: (tests: TestFilterCandidate[]) => ({ exclude: {}, note: `${tests.push(filterCandidate)}` }) }) satisfies TestFilter;
// Every name a public signature uses is importable, so a reporter or an executor can annotate what it reads.
declare const finishedRun: FinishedRun;
finishedRun.status satisfies RunStatus;
finishedRun.exitCode satisfies RunExitCode;
finishedRun.lastRun satisfies FinishedRun['report'] | undefined;
// @ts-expect-error the run status is a closed union
'skipped' satisfies RunStatus;
// @ts-expect-error the exit codes are the closed set a run ends with
5 satisfies RunExitCode;
declare const executorContext: StepExecutorContext;
executorContext.target.verbs satisfies ReadonlySet<ExecutorVerb>;
executorContext.attempt.titlePath satisfies readonly string[];
'tapAt' satisfies ExecutorVerb;
'hover' satisfies ExecutorVerb;
'drag' satisfies ExecutorVerb;
'upload' satisfies ExecutorVerb;
'back' satisfies ExecutorVerb;
// @ts-expect-error a verb is one of the action grammar's names
'fly' satisfies ExecutorVerb;
void (executorContext.actions.hoverAt(point) satisfies Promise<PointTapResult>);
void (executorContext.actions.check({ id: 'n1' }, true) satisfies Promise<void>);
void (executorContext.actions.drag({ id: 'n1' }, { id: 'n2' }) satisfies Promise<void>);
void (executorContext.actions.upload({ id: 'n1' }, ['fixtures/a.txt']) satisfies Promise<void>);
// @ts-expect-error a drag names two nodes
void executorContext.actions.drag({ id: 'n1' });
executorContext.attachTurns([{ index: 1, calls: ['tap({"target":"n19"})'], outcome: 'the form opened' } satisfies StepTurn]);
// @ts-expect-error attribute values must be text matches
asyncExpectation.toHaveAttribute('x', 42);
// A test id takes a RegExp, as the text queries do.
void (screen.getByTestId(/^total-/) satisfies Locator);
// @ts-expect-error a test id is a text match
screen.getByTestId(42);
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
void screen.getByRole('button').waitFor({ state: 'attached' });
void screen.getByRole('button').waitFor({ state: 'detached', timeout: 1000 });
// @ts-expect-error waitFor takes Playwright's four states
void screen.getByRole('button').waitFor({ state: 'gone' });
// Playwright's state flags and ignoreCase are taken where Playwright takes them, and nowhere else.
void asyncExpectation.toBeChecked({ checked: false });
void asyncExpectation.toBeVisible({ visible: false, timeout: 1000 });
void asyncExpectation.toContainText('error', { ignoreCase: true });
void asyncExpectation.toHaveAttribute('data-kind', 'error', { ignoreCase: true });
// @ts-expect-error toBeChecked has no indeterminate state
void asyncExpectation.toBeChecked({ indeterminate: true });
// @ts-expect-error a value is compared as it is, case included
void asyncExpectation.toHaveValue('a', { ignoreCase: true });
// @ts-expect-error presence has no case to ignore
void asyncExpectation.toHaveAttribute('data-kind', { ignoreCase: true });

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
// expect(screen) and expect(locator) compare screenshots; screen gets no locator matcher.
void (expect(screen).toHaveScreenshot('home.png') satisfies Promise<void>);
void (expect(screen).not.toHaveScreenshot({ maxDiffPixelRatio: 0.01, mask: [screen.getByTestId('clock')] }) satisfies Promise<void>);
void (expect(screen.getByRole('button')).toHaveScreenshot({ threshold: 0.1, maxDiffPixels: 10, maskColor: '#000000', timeout: 1000 }) satisfies Promise<void>);
void (expect.soft(screen).toHaveScreenshot() satisfies Promise<void>);
// @ts-expect-error a page screenshot option the cross-platform matcher does not take
void expect(screen).toHaveScreenshot({ fullPage: true });
// @ts-expect-error masks are locators, not selectors
void expect(screen).toHaveScreenshot({ mask: ['#clock'] });
// @ts-expect-error screen is not a locator
void expect(screen).toBeVisible();
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
void (executorContext.actions.tapAt(point) satisfies Promise<PointTapResult>);
void (executorContext.actions.hitTest(point) satisfies Promise<PointHit>);
void screen.tapAt(point, { timeout: 1_000 });
void screen.swipe({ direction: 'up', momentum: 'fast' });
void screen.swipe({ from: point, to: point });
void screen.swipe({ from: point, to: point, duration: 300 });
void screen.getByRole('image').tap({ position: point, timeout: 1_000 });
const rangeKeys: readonly KeyModifier[] = ['Shift', 'ControlOrMeta'];
void screen.getByRole('row').click({ modifiers: rangeKeys });
void screen.getByRole('row').secondaryTap({ modifiers: ['Alt'] });
void screen.getByRole('row').dblclick({ modifiers: ['Shift'], timeout: 1_000 });
// @ts-expect-error modifiers are the key grammar's modifier names
void screen.getByRole('row').doubleTap({ modifiers: ['Hyper'] });
void screen.getByRole('image').click({ position: point });
// @ts-expect-error a point has both coordinates.
void screen.tapAt({ x: 1 });
// @ts-expect-error a path swipe names both ends.
void screen.swipe({ from: point });
// @ts-expect-error a swipe is a direction or a path, never both.
void screen.swipe({ direction: 'up', to: point });
// @ts-expect-error a locator swipe is directional; the path form is screen.swipe.
void screen.getByRole('image').swipe({ from: point, to: point });
// @ts-expect-error a directional swipe takes no duration.
void screen.swipe({ direction: 'up', duration: 300 });
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
test('traced on retries', { trace: 'on-all-retries', video: 'retain-on-failure' }, async () => {});
test.describe('untraced', { trace: 'off' }, () => {});
// @ts-expect-error a test's trace is a mode
test('traced', { trace: 'all' }, async () => {});
test.describe('admin flows', { agent: 'admin' }, () => {});
await agent.act('approve it', { agent: 'admin' });
await agent.assert('it is approved', { agent: 'buyer' });
// An agents entry is one plain object: model, how it works, the app's vocabulary, and its tools.
declare const seedCart: ReturnType<typeof defineTool>;
({ targets, agents: { default: { model, judge: model, system: 'Be thorough.', context: 'Plans are called tiers.', tools: { seedCart }, providerOptions: { openai: { reasoningEffort: 'low' } } } } }) satisfies E2EConfig;
// @ts-expect-error context is one string
({ targets, agents: { default: { model, context: ['Plans are called tiers.'] } } }) satisfies E2EConfig;
// A custom brain goes under executor, and keeps the model, judge, context, and budgets.
declare const brain: StepExecutor;
({ targets, agents: { default: { executor: brain, model, judge: model, context: 'Plans are called tiers.', maxModelCalls: 10 } } }) satisfies E2EConfig;
// An executor that declares vision receives the assert option as step.vision.
({ name: 'seeing', vision: true, runStep: async (ctx) => ({ status: 'passed', summary: ctx.step.vision === 'only' ? 'pixels' : 'tree' }) }) satisfies StepExecutor;
// @ts-expect-error vision is a declaration, not a mode
({ name: 'seeing', vision: 'only', runStep: async () => ({ status: 'passed', summary: '' }) }) satisfies StepExecutor;
// @ts-expect-error system belongs to the built-in agent; a custom executor brings its own prompt
({ targets, agents: { default: { executor: brain, system: 'Be thorough.' } } }) satisfies E2EConfig;
// @ts-expect-error tools belong to the built-in agent; a custom executor brings its own
({ targets, agents: { default: { executor: brain, tools: { seedCart } } } }) satisfies E2EConfig;
// @ts-expect-error a bare executor is not an agents entry: pass it as { executor }
({ targets, agents: { default: brain } }) satisfies E2EConfig;
// @ts-expect-error maxTurns left createToolLoopExecutor: the agent's maxModelCalls bounds its turns
createToolLoopExecutor({ name: 'brain', tools: () => ({}), buildPrompt: () => 'go', maxTurns: 3 });
// @ts-expect-error limits left the config: maxInputTokens is per agent, the rest are fixed by the runner
({ targets, limits: { maxModelTokensPerCall: 1_000 } }) satisfies E2EConfig;

// The report carries the exploration record only on an explore run; a finding's evidence is one of the attempt's artifacts.
declare const report: Report;
// Every result carries its tags, an empty list when the test declares none.
report.run.results[0]!.tags satisfies readonly string[];
// Every result says which `--repeat-each` run it is, 0 without the flag.
report.run.results[0]!.repeat satisfies number;
// Interrupted tests are counted on their own, never in failed.
report.run.summary.interrupted satisfies number;
report.run.explore satisfies { goal: string; findings: readonly { severity: 1 | 2 | 3 | 4 | 5; artifactId?: string | undefined }[] } | undefined;
// A --last-failed rerun carries what it owed and left out as full results, groups, and hook errors, never a looser shape.
report.run.carried satisfies
  | { results: Report['run']['results']; serialGroups: Report['run']['serialGroups']; errors: Report['run']['errors'] }
  | undefined;

// A run test filters narrowed records each filter by name, and every row one left out names it.
report.run.filters satisfies readonly { name: string; candidates: number; excluded: number; note?: string | undefined }[] | undefined;
report.run.results[0]!.skip?.filter satisfies string | undefined;
report.run.filters?.[0]?.outcome satisfies 'failed' | 'timed-out' | undefined;
// @ts-expect-error only a filtered skip names the test filter that left the test out
({ cause: 'explicit', reason: 'not on CI', filter: 'jev' }) satisfies NonNullable<Report['run']['results'][number]['skip']>;
// The change the filters judged is counts only, never a file list: base and files together once git measured it, else why no filter ran.
report.run.changes satisfies
  | { base: string; files: number; skipped?: string | undefined }
  | { skipped: string; base?: undefined; files?: undefined }
  | undefined;
// @ts-expect-error a change git never measured has no file count
({ files: 0, skipped: '--last-failed' }) satisfies NonNullable<Report['run']['changes']>;
// A filter deciding what runs is a setup step named by the filter's name.
if (runEvent.type === 'setup' && runEvent.step.kind === 'filter') runEvent.step.name satisfies string;

// An explore run's events narrow to the exploration's progress.
if (runEvent.type === 'explore') {
  runEvent.progress.phase satisfies 'started' | 'planning' | 'step-started' | 'step-finished' | 'finding' | 'finished';
  if (runEvent.progress.phase === 'finding') runEvent.progress.finding.severity satisfies 1 | 2 | 3 | 4 | 5;
}

// e2e/oauth/*: a constructor takes the model id alone; the login comes from e2e login or E2E_OAUTH_CREDENTIALS.
chatgpt('gpt-5.6-luna') satisfies LanguageModelV4;
copilot('gpt-4.1') satisfies LanguageModelV4;
grok('grok-4') satisfies LanguageModelV4;
opencodeConsole('go/deepseek-v4.1-flash') satisfies LanguageModelV4;
// @ts-expect-error the store and apiUrl options are gone
chatgpt('gpt-5.6-luna', {});
// @ts-expect-error the store and baseURL options are gone
copilot('gpt-4.1', {});
// @ts-expect-error the store and baseURL options are gone
grok('grok-4', {});
// @ts-expect-error a constructor takes the model id alone
opencodeConsole('go/deepseek-v4.1-flash', {});

// agents.<name>: the judge slot beside model, and every budget in one entry.
({ targets: [{ engine }], agents: { default: { model, judge: model, judgmentTimeout: 30_000, maxSteps: 5, maxModelCalls: 10, maxObservationBytes: 1000, maxInputTokens: 32_000 } } }) satisfies E2EConfig;
// @ts-expect-error the judge is an AI SDK instance like model; a string names no gateway model
({ targets: [{ engine }], agents: { default: { model, judge: 'openai/gpt-5.6-luna-fast' } } }) satisfies E2EConfig;
// @ts-expect-error judgmentTimeout is milliseconds, not a duration string
({ targets: [{ engine }], agents: { default: { model, judgmentTimeout: '30s' } } }) satisfies E2EConfig;
// @ts-expect-error timeout is now judgmentTimeout, and maxTurns is maxModelCalls
({ targets: [{ engine }], agents: { default: { model, timeout: 30_000 } } }) satisfies E2EConfig;

// getByRole takes the accessible name as its second argument, with the other options after it.
void (screen.getByRole('button', 'Sign in') satisfies Locator);
void (screen.getByRole('button', /sign in/i, { exact: false, disabled: false }) satisfies Locator);
// @ts-expect-error a name given positionally cannot be given again in the options
screen.getByRole('button', 'Sign in', { name: 'Sign out' });

// toMatchSchema returns the schema's output, typed; negated, soft, and polled forms follow suit.
declare const userSchema: StandardSchemaV1<unknown, { id: number }>;
void (expect(JSON.parse('{}') as unknown).toMatchSchema(userSchema).id satisfies number);
void (expect(1).not.toMatchSchema(userSchema) satisfies void);
void (expect.soft(1).toMatchSchema(userSchema) satisfies { id: number } | undefined);
// @ts-expect-error a kept soft failure returns undefined, so the output may be missing
void (expect.soft(1).toMatchSchema(userSchema) satisfies { id: number });
// @ts-expect-error a soft double negation is still soft
void (expect.soft(1).not.not.toMatchSchema(userSchema) satisfies { id: number });
void (expect.poll(() => 1).toMatchSchema(userSchema) satisfies Promise<{ id: number }>);
void (expect.poll(() => 1).not.toMatchSchema(userSchema) satisfies Promise<void>);
// @ts-expect-error a schema is a Standard Schema, not a plain object
expect(1).toMatchSchema({ id: 'number' });
// A return-only generic (an engine's `response.json<T>()`) infers no locator or screen from `expect`, and `any` (a DOM `Response.json()`) is a value.
declare function readBody<T = unknown>(): Promise<T>;
void (expect(await readBody()).toMatchSchema(userSchema) satisfies { id: number });
void (expect.soft(await readBody()).toMatchSchema(userSchema) satisfies { id: number } | undefined);
void (expect(JSON.parse('{}')).toMatchSchema(userSchema) satisfies { id: number });
void (expect.soft(JSON.parse('{}')).toMatchSchema(userSchema) satisfies { id: number } | undefined);

// describe and the hooks are top-level imports too, typed as their test.* forms.
describe('group', { tags: ['smoke'] }, () => {
  beforeEach(async (fixtures) => void fixtures.screen);
  afterEach(async ({ app }) => void app);
  beforeAll(({ platform }) => void platform);
  afterAll(({ platform }) => void platform);
});
// @ts-expect-error a describe body is synchronous
describe('async group', async () => {});
// @ts-expect-error a suite hook sees suite fixtures only
beforeAll((fixtures) => void fixtures.screen);

// Suite execution accepts project selection, progress, and cancellation; execution settings live in config.
declare const runResult: RunResult;
void (run() satisfies Promise<RunResult>);
void run({
  cwd: '.', config: { targets }, files: ['tests/a.e2e.ts'],
  interruptSignal: new AbortController().signal,
  onEvent: (event) => { event satisfies RunEvent; },
} satisfies RunOptions);
void run({ config: 'e2e.config.ts' });
void run({ changedSince: 'origin/main' } satisfies RunOptions);
// @ts-expect-error changedSince is a git ref
void run({ changedSince: true });
void (runResult.exitCode satisfies RunExitCode);
void (runResult.status satisfies RunStatus);
void (runResult.report satisfies Report);
void (runResult.reportPath satisfies string | undefined);
void (runResult.aiTracePath satisfies string | undefined);
void (((event: RunEvent) => { event.type; }) satisfies RunEventSink);
// @ts-expect-error runtime configuration uses config, not the internal rawConfig name
void run({ rawConfig: { targets } });
// @ts-expect-error targetIds is an internal runner option
void run({ targetIds: ['web'] });
// @ts-expect-error public execution settings belong in the config
void run({ targets: ['web'] });
// @ts-expect-error freshGraph is a CLI option, not an embedded execution option
void run({ freshGraph: true });
// @ts-expect-error debug terminal output is a CLI option
void run({ debug: true });
// @ts-expect-error public execution settings belong in the config
void run({ workers: 2 });
// @ts-expect-error internal registrations are not part of the public runner
void run({ tests: {} });
// @ts-expect-error outcomes do not expose live resolved configuration
runResult.config;
// @ts-expect-error progress callbacks consume RunEvent, not arbitrary strings
void run({ onEvent: (_event: string) => {} });

// Exploration takes the goal and its budgets beside the project, progress, and cancellation; output settings live in config.
declare const exploreResult: ExploreResult;
void (explore() satisfies Promise<ExploreResult>);
void explore({
  cwd: '.', config: { targets }, goal: 'Explore the login flow and report any bugs', target: 'web', agent: 'default',
  session: 'signed-in', maxSteps: 8, timeoutMs: 600_000,
  interruptSignal: new AbortController().signal,
  onEvent: (event) => { event satisfies RunEvent; },
} satisfies ExploreOptions);
void explore({ config: 'e2e.config.ts' });
void (exploreResult satisfies RunResult);
void (exploreResult.explore.ended satisfies 'finished' | 'step-limit' | 'time' | 'stuck' | 'aborted');
void (exploreResult.explore.findings[0]?.severity satisfies 1 | 2 | 3 | 4 | 5 | undefined);
void (exploreResult.explore.steps[0]?.status satisfies 'passed' | 'failed' | 'blocked' | 'exhausted' | undefined);
// @ts-expect-error runtime configuration uses config, not the internal rawConfig name
void explore({ rawConfig: { targets } });
// @ts-expect-error configPath is the internal name; config takes the path
void explore({ configPath: 'e2e.config.ts' });
// @ts-expect-error the public explorer renders nothing: reporters are a CLI option
void explore({ reporters: ['list'] });
// @ts-expect-error headed, video, and trace are CLI options; recording settings belong in the config
void explore({ headed: true });
// @ts-expect-error notices are the CLI's stderr lines; progress is onEvent
void explore({ notice: () => {} });
// @ts-expect-error the second signal is the CLI's force-kill ladder, not a caller option
void explore({ forceSignal: new AbortController().signal });
// @ts-expect-error outcomes do not expose live resolved configuration
exploreResult.config;

// `e2e/runner` lists a selection in process. `config` is a path or a config value; `grep` is RegExp[].
void list({
  cwd: '.', config: 'e2e.config.ts', files: ['tests/a.e2e.ts'], tags: ['smoke'], tagMode: 'all', excludeTags: ['slow'],
  grep: [/^plain$/], grepInvert: [/other/], lastFailed: false, shard: { index: 1, total: 2 }, passWithNoTests: true,
  output: 'out', env: {}, targets: ['web'], changedSince: 'origin/main',
} satisfies ListOptions);
void list({ config: { targets } });
void isE2EError(new ConfigurationError('NO_TESTS', 'none'));
// @ts-expect-error grep is an array of RegExp, not strings
void list({ grep: ['plain'] });
// @ts-expect-error disposition is run, skip, or filtered
const disposition: ListedPair['disposition'] = 'pending';
void disposition;
// A pair a test filter left out names it.
declare const listedPair: ListedPair;
listedPair.filter satisfies string | undefined;

// `e2e/runner` hosts worker resources and opens a named, test-lifetime session with typed fixtures.
type HostedFixtures = { device: { tap(): void } };
declare const host: E2EHost<HostedFixtures>;
declare const session: E2ESession<HostedFixtures>;
declare const signal: AbortSignal;
void (openHost() satisfies Promise<E2EHost>);
void (openHost<HostedFixtures>({
  cwd: '.', config: 'e2e.config.ts', target: 'web', env: {}, signal, headed: true,
  onNotice: (target, message) => {
    target satisfies string;
    message satisfies string;
  },
} satisfies OpenHostOptions) satisfies Promise<E2EHost<HostedFixtures>>);
void openHost({ config: { targets } });
void (host.runId satisfies string);
void (host.target satisfies string);
void (host.close() satisfies Promise<readonly SerializedError[]>);
void (host satisfies AsyncDisposable);
void (host[Symbol.asyncDispose]() satisfies PromiseLike<void>);
// @ts-expect-error the deadline belongs to each session, not the host
void openHost({ timeout: 1000 });
// @ts-expect-error steps belong to each session, not the host
void openHost({ onStep: (_step: StepProgress) => {} });
// @ts-expect-error the default agent is selected per session
void openHost({ agent: 'buyer' });
// @ts-expect-error the host has no test fixtures until a session opens
host.fixtures;

void (host.openSession({ name: 'checkout' }) satisfies Promise<E2ESession<HostedFixtures>>);
void host.openSession({
  name: 'checkout', timeout: 30_000, signal, agent: 'buyer',
  onStep: (step) => {
    step satisfies StepProgress;
    if (step.phase === 'end') step.status satisfies StepRecord['status'];
  },
} satisfies OpenSessionOptions);
// @ts-expect-error every hosted session requires options with a name
void host.openSession();
// @ts-expect-error name is required even when a timeout is supplied
void host.openSession({ timeout: 1000 });
// @ts-expect-error name is a string, not a title path array
void host.openSession({ name: ['checkout'] });
// @ts-expect-error the deadline is milliseconds, not a duration string
void host.openSession({ name: 'checkout', timeout: '30s' });
// @ts-expect-error a session is opened on its host's config
void host.openSession({ name: 'checkout', config: { targets } });
// @ts-expect-error the project directory belongs to the host
void host.openSession({ name: 'checkout', cwd: '.' });
// @ts-expect-error a session is opened on its host's target
void host.openSession({ name: 'checkout', target: 'web' });
// @ts-expect-error the environment belongs to the host
void host.openSession({ name: 'checkout', env: {} });
// @ts-expect-error headed mode belongs to the host
void host.openSession({ name: 'checkout', headed: true });
// @ts-expect-error provisioning notices belong to the host
void host.openSession({ name: 'checkout', onNotice: (_target: string, _message: string) => {} });

void (session.runId satisfies string);
void (session.attemptId satisfies string);
void (session.target satisfies string);
void (session.fixtures.agent satisfies Agent);
void (session.fixtures.app satisfies App);
void (session.fixtures.screen satisfies Screen);
void (session.fixtures.device.tap satisfies () => void);
void (session.artifactsDir satisfies string);
void (session.tracePath satisfies string);
void (session.steps() satisfies readonly StepRecord[]);
declare const stepRecord: StepRecord;
void (stepRecord.observationTruncated satisfies boolean | undefined);
void (session.report() satisfies Report | undefined);
void (session.close() satisfies Promise<readonly SerializedError[]>);
void (session satisfies AsyncDisposable);
void (session[Symbol.asyncDispose]() satisfies PromiseLike<void>);
// @ts-expect-error the session's steps are the report's, read-only
session.steps().push({} as StepRecord);
// @ts-expect-error the generated trace path is not caller-controlled
session.tracePath = '/tmp/trace.md';
// @ts-expect-error closing returns a read-only list of failures
(await session.close()).push({} as SerializedError);

void (screen.getByRole('tab').or(screen.getByText('Discover')) satisfies Locator);
// @ts-expect-error an alternative must be a Locator
void screen.getByRole('tab').or('tab');
