/**
 * Public SDK types. The emitted `dist/index.d.ts` is the contract;
 * `tests/types/sdk-types.ts` pins the parts that are easy to loosen by accident.
 */

import type { expectationBrand, testCaseBrand } from './internal/brands.ts';
import type { CredentialConfig, Secret, SecretConfig } from './config/secrets.ts';
import type { StepExecutor } from './agent/executor.ts';
import type { StepCacheInfo } from './run/steps.ts';
import type { EngineHandle } from './engine/index.ts';
import type { TraceCacheStore } from './cache/store.ts';
import type { RunEvent, RunExitCode, RunStatus } from './run/events.ts';
import type { Report1Document } from './report/build.ts';

export type { CacheReadResult, TraceCacheStore } from './cache/store.ts';
export type { StepCacheInfo } from './run/steps.ts';
export type {
  Credential,
  CredentialConfig,
  Credentials,
  Secret,
  SecretConfig,
  SecretProvider,
  SecretPurpose,
  Secrets,
} from './config/secrets.ts';
export type {
  ActionTrace,
  RecordedAction,
  TraceEntry,
  TraceTargetDescriptor,
} from './cache/trace.ts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type Platform = 'web' | 'ios' | 'android' | (string & {});
export type Capability = string;
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type Momentum = 'none' | 'slow' | 'fast';

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: Options | undefined,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: readonly Issue[];
  }

  export interface Issue {
    readonly message: string;
    readonly path?: readonly (PropertyKey | PathSegment)[] | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

export type AgentParam =
  | JsonPrimitive
  | Secret
  | readonly AgentParam[]
  | { readonly [key: string]: AgentParam };
export type AgentParams = Readonly<Record<string, AgentParam>>;

/**
 * What evidence the model is given: the semantic tree, a masked screenshot of
 * the current observation, or both.
 *
 * - `false` — the tree.
 * - `true` — the tree and a screenshot, on every call.
 * - `'only'` — the screenshot, and not the tree.
 *
 * `'only'` exists because a tree sent alongside pixels is a cheaper path to an
 * answer, and a model will take it: asked whether a form is covered by an
 * overlay, it can read from the tree that the form is present and named and
 * answer yes, while the pixels show the overlay. For a judgment that is about
 * what the screen presents, the tree is a distractor, so the mode that means it
 * removes it. It also costs fewer input tokens than `true`, not more.
 *
 * In every mode that sends pixels but also the tree, pixel evidence degrades
 * away rather than failing the call when it cannot be proven redacted. `'only'`
 * has nothing to degrade to, so it fails with `POLICY_DENIED` instead of
 * answering the wrong question from the tree.
 */
export type VisionMode = boolean | 'only';

export interface VisionOption {
  vision?: VisionMode;
}

/** The configured agent (`agents.<name>`) one call runs with, in place of the test's. */
export interface AgentOption {
  agent?: string;
}

/** `assert` options: one judgment plus one repair round, within `timeout`. */
export interface AssertOptions extends VisionOption, AgentOption {
  /** Deadline in milliseconds; defaults to the judgment budget, `max(30000, actionTimeout)`. */
  timeout?: number;
  /** Attach a redacted screenshot to the step; on by default, denied after a secret fill. */
  screenshot?: boolean;
}

/** `waitFor` options: a judgment at most once per `interval` until `timeout`. */
export interface WaitForOptions extends VisionOption, AgentOption {
  /** Deadline in milliseconds; defaults to the judgment budget, `max(30000, actionTimeout)`. */
  timeout?: number;
  /** Least time between two judgments, in milliseconds; 100 through 60000, default 3000. */
  interval?: number;
  /** Judgment budget; defaults to `agent.maxModelCalls` and can only lower it. */
  maxModelCalls?: number;
}

/** `extract` options: one extraction plus one repair round, validated against `schema`. */
export interface ExtractOptions<Schema extends StandardSchemaV1> extends VisionOption, AgentOption {
  schema: Schema;
  /** Deadline in milliseconds; defaults to the judgment budget, `max(30000, actionTimeout)`. */
  timeout?: number;
}

/**
 * One `act` call: the values the instruction refers to and the step's
 * budgets. Structured output and vision are judgment-tier options:
 * `extract` takes `schema`; `assert`, `waitFor`, and `extract` take `vision`.
 */
export interface ActOptions extends AgentOption {
  /**
   * JSON-safe values the instruction refers to, at most 64 KiB and 32 levels
   * deep. A `Secret` reaches the model by name only; the runner fills it.
   */
  params?: AgentParams;
  /** Step deadline in milliseconds; defaults to the test timeout. */
  timeout?: number;
  /** Action budget; defaults to `agent.maxSteps` and can only lower it. */
  maxSteps?: number;
  /** Model-call budget; defaults to `agent.maxModelCalls` and can only lower it. */
  maxModelCalls?: number;
}

/** What one passing `act` step did, as the report records it. */
export interface ActResult {
  /** The executor's one-line account of the step, or the replay's when the cache finished it. */
  readonly summary: string;
  /** How the trace cache took part; absent when caching is off for the step. */
  readonly cache?: StepCacheInfo;
  /** Model calls the step spent; 0 when a cached replay finished it. */
  readonly modelCalls: number;
  /** Grammar actions and mutating tool calls the step performed. */
  readonly actions: number;
}

export type AgentErrorCode =
  | 'AUTH_CREDENTIAL_UNAVAILABLE'
  | 'AUTH_CREDENTIAL_INVALID'
  | 'SECRET_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'SEED_DATA_MISSING'
  | 'TEST_SETUP_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_PROVIDER_FAILED'
  | 'CONTEXT_OVERFLOW'
  | 'MODEL_OUTPUT_INVALID'
  | 'APP_UNREACHABLE'
  | 'APP_ALREADY_RUNNING'
  | 'APP_NOT_OPEN'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'ACTION_FAILED'
  | 'AUTOMATION_UNSUPPORTED'
  | 'POLICY_DENIED'
  | 'STEP_BUDGET_EXHAUSTED'
  | 'STEP_TIMEOUT'
  | 'STEP_NO_CONCLUSION'
  | 'ASSERTION_FAILED'
  | 'ASSERTION_INCONCLUSIVE'
  | 'CANCELLED';

export interface Agent {
  /** Plans and executes a bounded multi-action flow; resolves with what the step did. */
  act(instruction: string, options?: ActOptions): Promise<ActResult>;
  /** Polls a natural-language condition until true or timed out. */
  waitFor(condition: string, options?: WaitForOptions): Promise<void>;
  /** Extracts and validates structured screen data. */
  extract<Schema extends StandardSchemaV1>(
    instruction: string,
    options: ExtractOptions<Schema>,
  ): Promise<StandardSchemaV1.InferOutput<Schema>>;
  /** Judges a natural-language assertion against a fresh observation. */
  assert(assertion: string, options?: AssertOptions): Promise<void>;
}

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'image'
  | 'heading'
  | 'tab'
  | 'menuitem'
  | 'list'
  | 'listitem'
  | 'table'
  | 'row'
  | 'cell'
  | 'columnheader'
  | 'status'
  | 'alert'
  | 'dialog'
  | 'alertdialog'
  | 'main'
  | 'navigation'
  | 'banner'
  | 'contentinfo'
  | 'complementary'
  | 'region';
export type TextMatch = string | RegExp;

export interface TextMatchOptions {
  exact?: boolean;
  /**
   * When true, nodes the platform reports as hidden are excluded before the
   * exactly-one rule is applied, so a visible node with a hidden twin (a
   * prerendered copy kept after navigation, a closed drawer) still resolves.
   * Omitted or false keeps every match, hidden ones included.
   */
  visible?: boolean;
}

/**
 * Role query options. A role query never matches a node hidden from the
 * accessibility tree, on every engine; `visible` (inherited) is the one knob
 * that narrows the other query kinds the same way.
 */
export interface RoleOptions extends TextMatchOptions {
  name?: TextMatch;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
}

export interface ActionOptions {
  timeout?: number;
}

/** `longPress` options: the hold time in milliseconds, 100 through 10000, default 500. */
export interface LongPressOptions extends ActionOptions {
  duration?: number;
}

export interface SwipeOptions {
  direction: ScrollDirection;
  momentum?: Momentum;
}

/** One option of a select: its label (a bare string too), its `value` attribute, or its zero-based index. */
export type SelectOption =
  | string
  | { label: string; value?: never; index?: never }
  | { value: string; label?: never; index?: never }
  | { index: number; label?: never; value?: never };

export interface Screen {
  /** Creates a lazy role query. */
  getByRole(role: Role, options?: RoleOptions): Locator;
  /** Creates a lazy accessible-label query. */
  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy placeholder query. */
  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy visible-text query. */
  getByText(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy displayed-value query. */
  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy test-id query. */
  getByTestId(id: string, options?: { visible?: boolean }): Locator;
  /** Performs a viewport-level swipe. */
  swipe(options: SwipeOptions): Promise<void>;
  /** Scrolls until a locator resolves visibly or times out. */
  scrollUntilVisible(
    target: Locator,
    options?: { direction?: ScrollDirection; timeout?: number },
  ): Promise<void>;
}

export interface Locator extends Screen {
  /** Taps exactly one matching actionable node. */
  tap(options?: ActionOptions): Promise<void>;
  /** Alias of tap. */
  click(options?: ActionOptions): Promise<void>;
  /** Double-taps exactly one matching actionable node. */
  doubleTap(options?: ActionOptions): Promise<void>;
  /** Long-presses exactly one matching actionable node. */
  longPress(options?: LongPressOptions): Promise<void>;
  /** Fills exactly one input. Secret values are never logged. */
  fill(value: string | Secret, options?: ActionOptions): Promise<void>;
  /** Clears exactly one input. */
  clear(options?: ActionOptions): Promise<void>;
  /** Sends one key to exactly one node. */
  press(key: string, options?: ActionOptions): Promise<void>;
  /** Checks exactly one node. */
  check(options?: ActionOptions): Promise<void>;
  /** Unchecks exactly one node. */
  uncheck(options?: ActionOptions): Promise<void>;
  /** Selects one option from exactly one control. */
  selectOption(value: SelectOption, options?: ActionOptions): Promise<void>;
  /** Focuses exactly one node. */
  focus(options?: ActionOptions): Promise<void>;
  /** Hovers over exactly one matching actionable node. */
  hover(options?: ActionOptions): Promise<void>;
  /** Sets the files of exactly one file input; paths resolve from the project root. */
  setInputFiles(paths: string | readonly string[], options?: ActionOptions): Promise<void>;
  /** Drags exactly one node to exactly one target. */
  dragTo(target: Locator, options?: ActionOptions): Promise<void>;
  /** Scrolls exactly one node into view. */
  scrollIntoView(options?: ActionOptions): Promise<void>;
  /** Performs a swipe scoped to exactly one node. */
  swipe(options: SwipeOptions & ActionOptions): Promise<void>;
  /** Reads normalized text without retrying for a particular value. */
  textContent(): Promise<string | null>;
  /** Reads the current input value. */
  inputValue(): Promise<string>;
  /** Reads one attribute. */
  getAttribute(name: string): Promise<string | null>;
  /** Reads current visibility. */
  isVisible(): Promise<boolean>;
  /** Reads current enabled state. */
  isEnabled(): Promise<boolean>;
  /** Reads current checked state. */
  isChecked(): Promise<boolean>;
  /** Reads the current viewport-relative rectangle. */
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Counts current matches without auto-waiting. */
  count(): Promise<number>;
  /** Waits for the requested locator state. */
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  /** Adds deterministic locator filters. */
  filter(options: { hasText?: TextMatch; has?: Locator }): Locator;
  /** Selects the first current match. */
  first(): Locator;
  /** Selects the last current match. */
  last(): Locator;
  /** Selects one zero-based current match. */
  nth(index: number): Locator;
}

export interface App {
  /**
   * The resolved base URL of the target's app, with the port the run
   * allocated when the engine declared port 0; undefined for a surface whose
   * engine declares no `url`.
   */
  readonly baseUrl: string | undefined;
  /** Opens the app: the declared URL, a path relative to it, or any absolute http(s) URL. */
  open(path?: string): Promise<void>;
  /**
   * Recreates the execution context while preserving persisted state, then
   * reopens the app at its base URL when the engine declares one.
   */
  restart(): Promise<void>;
  /**
   * Clears persisted client state, recreates the execution context, then
   * reopens the app at its base URL when the engine declares one.
   */
  clearState(): Promise<void>;
  /** Navigates back once. */
  back(): Promise<void>;
  /** Captures a redacted evidence screenshot. */
  screenshot(label?: string): Promise<string>;
}

export interface SetupSession {
  /** Saves state under a setup-declared name. */
  save(name: string): Promise<void>;
}

export interface TestFixtures {
  readonly agent: Agent;
  readonly app: App;
  readonly screen: Screen;
  readonly platform: Platform;
}

export interface SetupFixtures extends TestFixtures {
  readonly session: SetupSession;
}

export interface SuiteFixtures {
  readonly platform: Platform;
}

export interface TestOptions {
  timeout?: number;
  retries?: number;
  tags?: readonly string[];
  skip?: boolean | string;
  only?: boolean;
  platforms?: readonly Platform[];
  requires?: readonly Capability[];
  session?: string;
  agentContext?: string;
  /**
   * The configured agent (`agents.<name>`) this test or group runs with, in
   * place of the run's agents. A list runs the test once per agent named, as
   * one result each. Innermost wins; a call's own `agent` option wins over
   * it. `--agent` narrows a list to the names both name and never overrides
   * a pin the flag does not name.
   */
  agent?: string | readonly string[];
}

export interface DescribeOptions extends Omit<TestOptions, 'only'> {
  serial?: boolean;
}

export interface SetupOptions extends Omit<TestOptions, 'session' | 'only' | 'skip' | 'agent'> {
  /** Session names this setup test MUST save. */
  sessions: readonly string[];
  /** A setup test runs once per target, so it pins at most one agent. */
  agent?: string;
}

export type TestFn<Fixtures = TestFixtures> = (fixtures: Fixtures) => void | Promise<void>;
export type SetupFn<Fixtures = TestFixtures> = (
  fixtures: Fixtures & SetupFixtures,
) => void | Promise<void>;
export type TestHookFn<Fixtures = TestFixtures> = (fixtures: Fixtures) => void | Promise<void>;
export type SuiteHookFn = (fixtures: SuiteFixtures) => void | Promise<void>;
/**
 * Defines one fixture: everything before `await use(value)` is its setup,
 * everything after is its teardown. The body, its hooks, and later fixtures
 * run while `use` is pending; it resolves once they are done, whether or not
 * the body failed.
 */
export type FixtureFn<Fixtures, Value> = (
  fixtures: Fixtures,
  use: (value: Value) => Promise<void>,
) => Promise<void>;
/**
 * One definition per fixture `test.extend()` adds. A definition sees the
 * fixtures of the `test` it extends, not its siblings: a fixture that needs
 * another one goes in a chained `extend()`. A name the base already has is a
 * type error (and a `COLLECTION_ERROR` at runtime).
 */
export type FixtureDefinitions<Base, Extra> = {
  readonly [K in keyof Extra]: K extends keyof Base ? never : FixtureFn<Base, Extra[K]>;
};
export type SynchronousBody<Result> = Extract<Result, PromiseLike<unknown>> extends never
  ? () => Result
  : never;

export interface TestCase {
  readonly [testCaseBrand]: true;
}

export interface TestAPI<Fixtures = TestFixtures> {
  /** Registers one test synchronously during module evaluation. */
  (title: string, fn: TestFn<Fixtures>): TestCase;
  /** Registers one configured test synchronously during module evaluation. */
  (title: string, options: TestOptions, fn: TestFn<Fixtures>): TestCase;
  /** Registers one skipped test. */
  skip(title: string, fn: TestFn<Fixtures>): TestCase;
  /** Registers one focused local test. CI rejects focused tests. */
  only(title: string, fn: TestFn<Fixtures>): TestCase;
  /** Registers one setup test with statically declared session outputs. */
  setup(title: string, options: SetupOptions, fn: SetupFn<Fixtures>): TestCase;
  /**
   * Returns the same runtime `test`, typed with an engine's contributed
   * fixtures. A pure type refinement, the fixtures still resolve from the
   * target's engine at runtime, so a project types its device/desktop/web
   * surface without a global `declare module` augmentation:
   *
   *   export const test = base.extend<{ device: Device }>();
   */
  extend<Extra>(): TestAPI<Fixtures & Extra>;
  /**
   * Returns a new `test` whose registrations carry these fixture
   * definitions on top of the ones it already had. Each attempt sets them up
   * in declaration order after the engine's fixtures, runs the hooks and the
   * body with them, and tears them down in reverse order after `afterEach`:
   *
   *   export const test = base.extend<{ workspace: Workspace }>({
   *     workspace: async ({ web }, use) => {
   *       const workspace = await createWorkspace();
   *       await use(workspace);
   *       await workspace.cleanup();
   *     },
   *   });
   */
  extend<Extra>(fixtures: FixtureDefinitions<Fixtures, Extra>): TestAPI<Fixtures & Extra>;
  /** Declares a group synchronously. */
  describe<Result>(title: string, body: SynchronousBody<Result>): void;
  /** Declares a configured group synchronously. */
  describe<Result>(
    title: string,
    options: DescribeOptions,
    body: SynchronousBody<Result>,
  ): void;
  /** Registers a test-attempt setup hook. */
  beforeEach(fn: TestHookFn<Fixtures>): void;
  /** Registers a test-attempt teardown hook. */
  afterEach(fn: TestHookFn<Fixtures>): void;
  /** Registers a suite-instance setup hook. */
  beforeAll(fn: SuiteHookFn): void;
  /** Registers a suite-instance teardown hook. */
  afterAll(fn: SuiteHookFn): void;
}

export interface AsyncExpectation {
  readonly not: AsyncExpectation;
  /** Waits for visibility. */
  toBeVisible(options?: { timeout?: number }): Promise<void>;
  /** Waits for hidden or absent state. */
  toBeHidden(options?: { timeout?: number }): Promise<void>;
  /** Waits for enabled state. */
  toBeEnabled(options?: { timeout?: number }): Promise<void>;
  /** Waits for disabled state. */
  toBeDisabled(options?: { timeout?: number }): Promise<void>;
  /** Waits for checked state. */
  toBeChecked(options?: { timeout?: number }): Promise<void>;
  /** Waits for selected state. */
  toBeSelected(options?: { timeout?: number }): Promise<void>;
  /** Waits for expanded state. */
  toBeExpanded(options?: { timeout?: number }): Promise<void>;
  /** Waits for focused state. */
  toBeFocused(options?: { timeout?: number }): Promise<void>;
  /** Waits for exact normalized text. */
  toHaveText(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for contained normalized text. */
  toContainText(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for an input value. */
  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the attribute to be present; with `value`, for it to match. */
  toHaveAttribute(name: string, options?: { timeout?: number }): Promise<void>;
  toHaveAttribute(name: string, value: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for an exact match count. */
  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void>;
  /** Waits for an accessible name. */
  toHaveAccessibleName(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

/**
 * An object that carries its own expectation surface, so `expect(object)`
 * returns `E`. Engine-contributed fixtures attach one through
 * `EngineFixtureContext.expectable`; core never declares a platform's
 * matchers, it only routes to them.
 */
export interface Expectable<E> {
  readonly [expectationBrand]: E;
}

export interface ValueExpectation<T> {
  readonly not: ValueExpectation<T>;
  /** Compares with Object.is. */
  toBe(expected: T): void;
  /** Performs recursive structural equality. */
  toEqual(expected: unknown): void;
  /** Requires a truthy value. */
  toBeTruthy(): void;
  /** Requires a falsy value. */
  toBeFalsy(): void;
  /** Requires null. */
  toBeNull(): void;
  /** Requires undefined. */
  toBeUndefined(): void;
  /** Requires a non-nullish value. */
  toBeDefined(): void;
  /** Requires string or collection containment. */
  toContain(expected: unknown): void;
  /** Requires a string or regexp match. */
  toMatch(expected: string | RegExp): void;
  /** Requires a numeric lower bound. */
  toBeGreaterThan(expected: number): void;
  /** Requires a numeric upper bound. */
  toBeLessThan(expected: number): void;
}

export interface PollOptions {
  /** Deadline in milliseconds. Default 5000. */
  timeout?: number;
  /** Pause between reads in milliseconds. Default 100. */
  interval?: number;
  /** Extra line in the timeout error, after the matcher line. */
  message?: string;
}

/**
 * The asynchronous form of every `ValueExpectation<T>` matcher: the same
 * names and parameters, each resolving once the re-read value passes.
 * Derived from `ValueExpectation<T>` so the two cannot drift.
 */
export type PollExpectation<T> = {
  readonly not: PollExpectation<T>;
} & {
  readonly [K in Exclude<keyof ValueExpectation<T>, 'not'>]: (
    ...args: Parameters<ValueExpectation<T>[K]>
  ) => Promise<void>;
};

/** The `expect` entry: dispatch on the argument, plus `expect.poll`. */
export interface Expect {
  (actual: Locator): AsyncExpectation;
  <E extends object>(actual: Expectable<E>): E;
  <T>(actual: T): ValueExpectation<T>;
  /** Re-reads a value until the chosen matcher holds or `timeout` passes. */
  poll<T>(read: () => T | Promise<T>, options?: PollOptions): PollExpectation<T>;
}

export interface CommandConfig {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeout?: number;
  shutdownTimeout?: number;
  /** File that receives the process's stdout and stderr, appended, resolved from the project root. Omitted discards output. */
  log?: string;
  /**
   * When the readiness URL already answers before the command starts, use that
   * process instead of spawning: nothing is started and nothing is stopped.
   * Off by default; CI ignores it and always starts the command.
   */
  reuseExisting?: boolean;
}

/**
 * One dependency process of the app under test (a database container, a
 * cache, an auth emulator, a migration step). Services start sequentially in
 * declaration order before `app.command`, and each must be ready before the
 * next starts. Exactly one of `readyUrl` or `waitForExit` declares how a
 * service becomes ready; a service with neither has no readiness contract and
 * is rejected as `INVALID_CONFIG`.
 */
export interface ServiceConfig extends CommandConfig {
  /** Label used in errors, reporter output, and the report; defaults to the executable name. */
  name?: string;
  /** Optional HTTP readiness probe; a status of 200 through 499 counts as ready. */
  readyUrl?: string;
  /**
   * Wait for the process to exit with code 0 instead of probing a URL
   * (migrations, `docker compose up --wait`). A non-zero exit or the
   * `startupTimeout` expiring is `APP_UNREACHABLE`.
   */
  waitForExit?: boolean;
  /**
   * Optional command run during teardown after the service itself has been
   * stopped (`docker compose down`). Runs on every exit path, is waited on
   * until exit within its own `startupTimeout`, and a failure is recorded as a
   * cleanup-phase run error rather than a crash.
   */
  teardown?: CommandConfig;
}

/**
 * One target: a named surface on one platform, served by an engine.
 * What the target can do is graded from the engine's declared capabilities;
 * with no `engine` the target is agent-tools-only and everything runs opaque.
 * The app under test is the engine's to declare (its URL, identity, or the
 * command that starts it); a target carries no app config of its own.
 */
export interface Target {
  /** Label in reports and for `--target`; defaults to the platform. */
  name?: string;
  /**
   * Platform label, inherited from the engine when omitted. Required for a
   * target without an engine; when both name one, they must agree.
   */
  platform?: Platform;
  engine?: EngineHandle;
}

/**
 * A live AI SDK language model instance: `gateway('openai/gpt-5.6-luna')`
 * from `ai`, `openrouter(...)` from `@openrouter/ai-sdk-provider`,
 * `openai('gpt-4o')` from `@ai-sdk/openai`, or any other provider
 * implementing the AI SDK `LanguageModelV2+` specification. The instance owns
 * its own transport and credentials; the runner knows no gateway or provider
 * of its own. Detection is structural, so any AI SDK provider package works
 * without this runner depending on it.
 */
export interface ModelInstance {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
}

/** Trace cache posture. In CI, `read-write` is forced down to `read-only`. */
export type CacheMode = 'off' | 'read-only' | 'read-write';

/**
 * Trace cache configuration. The store abstraction is the cloud seam: the
 * default file store keeps entries under `.e2e/cache/`, and a custom
 * `TraceCacheStore` (Redis, an API — anything implementing read/write over
 * key digests) replaces it wholesale. Like agents and model instances, a
 * store never crosses a process boundary: workers re-resolve the config
 * module and construct their own.
 */
export interface CacheConfig {
  mode?: CacheMode;
  /** Custom entry store; undefined selects the file store at `dir`. */
  store?: TraceCacheStore;
  /** File store directory, resolved against the project root. */
  dir?: string;
}

/**
 * One produced artifact as handed to an `ArtifactStore`, the moment it is
 * complete on disk: its bytes, digest, and report identity. `path` is the
 * report-relative path the record carries, stable across runs of the same
 * test, so a host may use it as its own key.
 */
export interface StoredArtifact {
  readonly kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log';
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly sha256: string;
  /** Report-relative path with `/` separators. */
  readonly path: string;
  readonly runId: string;
  readonly testId: string;
  readonly attemptId: string;
  /** The step that produced it, when one was running. */
  readonly stepId?: string;
  /**
   * When a time-based artifact began recording (a video segment), so a host
   * can align step timestamps with it without reading the report.
   */
  readonly startedAt?: string;
}

/**
 * Where artifacts go. The default keeps them under the artifacts directory,
 * and the report records their paths. A host-supplied store (object storage,
 * an API) receives every artifact as it is produced — not after the run — and
 * returns its own reference, which the report records as the artifact's
 * `ref` beside the local path. The cloud seam for evidence, the way
 * `TraceCacheStore` is for traces. A failed `put` never fails the run: the
 * record simply carries no `ref`. Like every live value, a store never
 * crosses a process boundary.
 */
export interface ArtifactStore {
  put(artifact: StoredArtifact): Promise<{ readonly ref: string }>;
}

/**
 * Artifact kinds a config may ask for. `video` is never in the default set:
 * asking for it, in the config or with `--video`, is always a contract, and
 * it never enters the config digest, so recording a run cannot invalidate
 * its cached traces.
 */
export type ConfiguredArtifactKind = 'trace' | 'screenshot' | 'video';

/** Options of the `video` artifact. */
export interface VideoArtifactConfig {
  /**
   * Which attempts keep their recording: every attempt (`all`, the default),
   * or only the ones that did not pass (`on-failure`), so a CI run records
   * everything and keeps only what needs watching.
   */
  retain?: 'all' | 'on-failure';
}

/** Artifact configuration: which kinds to capture, and where they go. */
export interface ArtifactsConfig {
  /** Kinds to capture; defaults to screenshot and trace. */
  kinds?: readonly ConfiguredArtifactKind[];
  /** Host store every produced artifact is handed to; undefined keeps files local only. */
  store?: ArtifactStore;
  /** Options of the `video` kind; ignored unless `video` is among the kinds. */
  video?: VideoArtifactConfig;
}

/**
 * AI SDK provider options, keyed by provider then option name, e.g.
 * `{ openai: { reasoningEffort: 'low' } }`. Sent with every model call of
 * both the act tier and the judgment tier.
 */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Agent options for the built-in agent; `agent` also accepts a StepExecutor. */
export interface AgentConfig {
  /**
   * The step executor `agent.act()` dispatches to, alongside the options —
   * a custom brain no longer forfeits `model`, budgets, or `context`
   *. Omitted selects the built-in agent.
   */
  executor?: StepExecutor;
  /** An AI SDK model instance; no implicit default. */
  model?: ModelInstance;
  /**
   * The model that judges `assert`, `waitFor`, and `extract`; defaults to
   * `model`. A judge of its own separates the model that grades a flow from
   * the one that drove it. Must agree with `createAgent({ judge })` when both
   * are set.
   */
  judge?: ModelInstance;
  maxSteps?: number;
  maxModelCalls?: number;
  maxObservationBytes?: number;
  context?: string;
  /** Project-wide default for the per-call `vision` option. */
  vision?: VisionMode;
  /** Provider options every model call carries, e.g. a reasoning effort. */
  providerOptions?: ProviderOptions;
}

/** The reporters the runner ships, named by id; each is a `Reporter` on the same contract. */
export type BuiltinReporter = 'list' | 'json' | 'junit' | 'markdown';

/**
 * The run's report document, the one `.e2e/report.json` holds. Its
 * `schemaVersion` names the wire format (`report-1`), pinned by
 * `schema/report-v1.schema.json` in the package.
 */
export type Report = Report1Document;

/** What a reporter receives once the run is over and its report is on disk. */
export interface FinishedRun {
  readonly report: Report;
  /** The same status `report.run.status` carries. */
  readonly status: RunStatus;
  readonly exitCode: RunExitCode;
  /** Absolute project root, what the terminal shows paths relative to. */
  readonly projectRoot: string;
  /** Where `report.json` was written; undefined when the write failed or config never loaded. */
  readonly reportPath: string | undefined;
  /** Absolute directory the report's artifact paths are relative to. */
  readonly artifactsRoot: string;
  /** Where `--ai-trace` wrote the run's model calls, when it was requested. */
  readonly aiTracePath: string | undefined;
}

/** Rows a reporter hands back for the terminal summary: a label and its text, a URL or a path. */
export type ReporterSummary = readonly { readonly label: string; readonly text: string }[];

/**
 * A reporter in `reporters`, the contract the built-in `list`, `json`,
 * `junit`, and `markdown` reporters implement too. `onEvent` sees every run event as it
 * happens, exactly what the `list` reporter renders, and must not block: a
 * throw quarantines it for the rest of the run. Event types are added over
 * time; a reporter handles the ones it knows and ignores the rest. `onRunFinished` runs once
 * `report.json` is written and the summary has printed; it is awaited within
 * a fixed budget, and the rows it resolves with print under the summary. Its
 * `signal` aborts when that budget runs out or the run is forced to stop, so
 * a reporter hands it to its requests and leaves nothing running behind. A
 * reporter can never change the run's status or exit code: a failure or a
 * timeout is one line on stderr. Like every live value, a reporter never
 * crosses a process boundary; workers construct their own copy when they
 * load the config module and never call it, so constructing one must have no
 * side effects.
 */
export interface Reporter {
  readonly name: string;
  onEvent?(event: RunEvent): void;
  onRunFinished?(run: FinishedRun, signal: AbortSignal): Promise<ReporterSummary | void>;
}

export interface E2EConfig {
  specVersion?: '0.1';
  projectId?: string;
  targets?: readonly Target[];
  tests?: string | readonly string[];
  timeout?: number;
  launchTimeout?: number;
  actionTimeout?: number;
  assertionTimeout?: number;
  cleanupTimeout?: number;
  retries?: number;
  workers?: number;
  /** Artifact kinds, or `{ kinds, store, video }` to also hand every artifact to a host store. */
  artifacts?: readonly ConfiguredArtifactKind[] | ArtifactsConfig;
  /**
   * Output renderers and reporter objects. `junit` writes `.e2e/junit.xml`,
   * `markdown` writes `.e2e/summary.md`, `json` prints the report and
   * excludes `list`; a `Reporter` object runs
   * beside them and `--reporter` never removes it.
   */
  reporters?: readonly (BuiltinReporter | Reporter)[];
  /**
   * The agents by name. Each is either an options block or the agent itself:
   * `createAgent(...)` from `e2e/agent`, or any hand-rolled
   * `StepExecutor`. `default` is the one tests run with; `e2e run --agent
   * <name>` runs them with another. With an agent value, the model is the
   * one it brought and every other option keeps its default. Agents never
   * cross a process boundary: workers re-resolve the config module and
   * construct their own, exactly like model instances.
   */
  agents?: Readonly<Record<string, AgentConfig | StepExecutor>>;
  /**
   * The adaptive trace cache. Opt-out: unset means
   * `read-write`, and `'off'` — or the `--no-cache` flag, which wins over the
   * config — disables it. A string is shorthand for `{ mode }`. In CI an
   * unset mode is demoted to `read-only`: a committed cache is untrusted
   * input. An explicit `read-write` is honored as the project's own statement
   * of trust in the cache it restores.
   */
  cache?: CacheMode | CacheConfig;
  /**
   * Enforced resource ceilings only. A limit exists here exactly when the
   * runner has an enforcement site for it; aspirational knobs are not
   * accepted, so a configured limit is never a silent no-op.
   */
  limits?: {
    maxAgentContextBytes?: number;
    maxLedgerBytes?: number;
    maxEventsPerStep?: number;
    maxModelTokensPerCall?: number;
  };
  /**
   * Named accounts. A credential's password is registered as a secret under
   * the credential's name, so the name may not also appear under `secrets`.
   */
  credentials?: Readonly<Record<string, CredentialConfig>>;
  /**
   * Named values the model must never see: API keys, tokens, anything sourced
   * from the environment. `secrets.get(name)` hands a test the opaque handle;
   * the value is filled by the runner, masked in every observation, and
   * redacted from logs, traces, and the report.
   */
  secrets?: Readonly<Record<string, SecretConfig>>;
}
