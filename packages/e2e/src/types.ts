/**
 * Public SDK types. The emitted `dist/index.d.ts` is the contract;
 * `tests/types/sdk-types.ts` pins the parts that are easy to loosen by accident.
 */

import type { expectationBrand, testCaseBrand } from './internal/brands.ts';
import type { CredentialConfig, Secret, SecretConfig } from './config/secrets.ts';
import type { Unique } from './params.ts';
import type { StepExecutor } from './agent/executor.ts';
import type { StepCacheInfo } from './run/steps.ts';
import type { EngineHandle } from './engine/index.ts';
import type { KeyModifier, Momentum, ScrollDirection, SelectOption, ViewportPoint } from './engine/contract.ts';
import type { CacheStore } from './cache/store.ts';
import type { RunEvent, RunExitCode, RunStatus } from './run/events.ts';
import type { Report1Document } from './report/build.ts';

export type { KeyModifier, Momentum, ScrollDirection, SelectOption } from './engine/contract.ts';
export type { CacheReadResult, CacheStore } from './cache/store.ts';
export type { DerivedReason } from './cache/trace.ts';
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
export type { Unique } from './params.ts';
export type {
  ActionTrace,
  RecordedAction,
  TraceEntry,
  TraceTargetDescriptor,
} from './cache/trace.ts';

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;
/** Data that survives JSON serialization. */
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type Capability = string;

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

/** A JSON-safe value, a `Secret`, or a `Unique` string. */
export type AgentParam =
  | JsonPrimitive
  | Secret
  | Unique
  | readonly AgentParam[]
  | { readonly [key: string]: AgentParam };
/** Values an `act` instruction refers to. */
export type AgentParams = Readonly<Record<string, AgentParam>>;

/**
 * What evidence a judgment (`assert`, `waitFor`, `extract`) is given: the
 * semantic tree, a masked screenshot of the current observation, or both.
 *
 * - `false`: the tree.
 * - `true`: the tree and a screenshot, on every call.
 * - `'only'`: the screenshot, and not the tree.
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
 *
 * `act` takes no `vision`: the act model works from the tree and pulls
 * pixels itself with `screenshot` when the tree lacks what it needs, then
 * acts at points in that screenshot where the tree lists nothing.
 */
export type VisionMode = boolean | 'only';

export interface VisionOption {
  /**
   * What the judge is shown; `false` by default. The tree, the tree with a
   * masked screenshot, or the screenshot alone. A custom `StepExecutor`
   * rejects it with `UNSUPPORTED_CAPABILITY`: the executor decides what its
   * model sees.
   */
  vision?: VisionMode;
}

/** The configured agent (`agents.<name>`) one call runs with, in place of the test's. */
export interface AgentOption {
  agent?: string;
}

/** `assert` options: one judgment plus one repair round, within `timeout`. */
export interface AssertOptions extends VisionOption, AgentOption {
  /** Deadline in milliseconds; defaults to the agent's `judgmentTimeout`, 30000. */
  timeout?: number;
  /** Attach a redacted screenshot to the step; on by default, denied after a secret fill. */
  screenshot?: boolean;
}

/** `waitFor` options: a judgment at most once per `interval` until `timeout`. */
export interface WaitForOptions extends VisionOption, AgentOption {
  /** Deadline in milliseconds; defaults to the agent's `judgmentTimeout`, 30000. */
  timeout?: number;
  /** Least time between two judgments, in milliseconds; 100 through 60000, default 3000. */
  interval?: number;
  /** Judgment budget; defaults to `agents.<name>.maxModelCalls` and can only lower it. */
  maxModelCalls?: number;
}

/** `extract` options: one extraction plus one repair round, validated against `schema`. */
export interface ExtractOptions<Schema extends StandardSchemaV1> extends VisionOption, AgentOption {
  /** Any Standard Schema v1 validator; the output is validated against it, with one repair round. */
  schema: Schema;
  /** Deadline in milliseconds; defaults to the agent's `judgmentTimeout`, 30000. */
  timeout?: number;
}

/**
 * One `act` call: the values the instruction refers to and the step's
 * budgets. Structured output is a judgment-tier option: `extract` takes
 * `schema`. Pixels are the model's to ask for, not an option.
 */
export interface ActOptions extends AgentOption {
  /**
   * JSON-safe values the instruction refers to, at most 64 KiB and 32 levels
   * deep. A `Secret` reaches the model by name only; the runner fills it. A
   * value wrapped in `unique()` is different on every run, and the replay
   * cache records a slot for it instead of the value.
   */
  params?: AgentParams;
  /** Step deadline in milliseconds; defaults to `config.timeout`. */
  timeout?: number;
  /** Action budget; defaults to `agents.<name>.maxSteps` and can only lower it. */
  maxSteps?: number;
  /** Model-call budget; defaults to `agents.<name>.maxModelCalls` and can only lower it. */
  maxModelCalls?: number;
}

/** What one passing `act` step did, as the report records it. */
export interface ActResult {
  /** The executor's one-line account of the step, or the replay's when the cache finished it. */
  readonly summary: string;
  /** How the replay cache took part; absent when caching is off for the step. */
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
  | 'MODEL_REFUSED'
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
  | 'REPLAY_STALE'
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

/**
 * The closed role vocabulary; an unsupported role is a type error. Every
 * engine maps its platform's element types onto these names, so a role query
 * reads the same against a browser and a device. A role the platform has no
 * widget for matches nothing there; it is never a type error.
 */
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
  | 'radiogroup'
  | 'switch'
  | 'slider'
  | 'spinbutton'
  | 'progressbar'
  | 'meter'
  | 'image'
  | 'heading'
  | 'tab'
  | 'tablist'
  | 'tabpanel'
  | 'menu'
  | 'menubar'
  | 'menuitem'
  | 'menuitemcheckbox'
  | 'menuitemradio'
  | 'toolbar'
  | 'tooltip'
  | 'tree'
  | 'treeitem'
  | 'list'
  | 'listitem'
  | 'table'
  | 'grid'
  | 'row'
  | 'rowgroup'
  | 'rowheader'
  | 'cell'
  | 'gridcell'
  | 'columnheader'
  | 'separator'
  | 'group'
  | 'article'
  | 'figure'
  | 'form'
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

/**
 * Spellings `getByRole` accepts beside the vocabulary and rewrites to a `Role`
 * before the query is built: `img` is the ARIA name of `image`. An alias never
 * reaches an engine, the replay cache, or a report; a `Role` is what they see.
 */
export type RoleAlias = 'img';

/** A string matches exactly; a RegExp uses its own source and flags. */
export type TextMatch = string | RegExp;

export interface TextMatchOptions {
  /** Exact match, the default. `false` is case-insensitive substring matching; a RegExp ignores it. */
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
 * that narrows the other query kinds, to the nodes `toBeVisible()` accepts.
 */
export interface RoleOptions extends TextMatchOptions {
  /** Accessible name filter. */
  name?: TextMatch;
  /** Requires the checked state. */
  checked?: boolean;
  /** Requires the disabled state. */
  disabled?: boolean;
  /** Requires the selected state. */
  selected?: boolean;
  /** Requires the expanded state. */
  expanded?: boolean;
  /** Requires the pressed state of a toggle button. */
  pressed?: boolean;
  /** Requires a heading level, 1 through 6. */
  level?: number;
}

export interface ActionOptions {
  /** Deadline in milliseconds; defaults to `config.actionTimeout`. */
  timeout?: number;
}

/**
 * A point in CSS pixels. For `screen.tapAt` and `screen.swipe` the origin is
 * the viewport's top-left corner, the space `boundingBox()` reports in; for
 * `tap({ position })` it is the node's own top-left corner.
 */
export type Point = ViewportPoint;

/** `tap`, `click`, `doubleTap`, and `secondaryTap` options: the action timeout and the keys held for the click. */
export interface ClickOptions extends ActionOptions {
  /**
   * Keys held while the pointer clicks, as a Shift-click extends a selection:
   * `Shift`, `Control`, `Alt`, `Meta`, or `ControlOrMeta` (Control on Windows
   * and Linux, Meta on macOS). Needs an engine that declares `tapModifiers`,
   * `UNSUPPORTED_CAPABILITY` otherwise.
   */
  modifiers?: readonly KeyModifier[];
}

/** `tap` and `click` options. */
export interface TapOptions extends ClickOptions {
  /**
   * Where to tap, relative to the node's top-left corner. Without it the
   * platform picks a point of the node, usually its center, behind its own
   * actionability checks; with it the pointer is dispatched at that point
   * once the node is in view and has a box, which needs the engine's `tap`
   * pointer action.
   */
  position?: Point;
}

/** `longPress` options: the hold time in milliseconds, 100 through 10000, default the engine's own. */
export interface LongPressOptions extends ActionOptions {
  /** Hold time in milliseconds, 100 through 10000; unset, the engine's default. */
  duration?: number;
}

/** `pressSequentially` options: an optional pause between characters. */
export interface PressSequentiallyOptions extends ActionOptions {
  /** Milliseconds to wait between characters; omitted types the whole text in one call. */
  delay?: number;
}

/** A swipe in a direction. */
export interface SwipeOptions {
  /** Swipe direction. */
  direction: ScrollDirection;
  /** Fling strength; default `none`. */
  momentum?: Momentum;
  from?: never;
  to?: never;
  duration?: never;
}

/** A swipe along a path between two viewport points: a touch swipe on a device, a pointer drag on a document platform. */
export interface SwipePathOptions {
  /** Where the finger goes down. */
  from: Point;
  /** Where it lifts. */
  to: Point;
  /** Gesture duration in milliseconds; omitted = the engine's default. */
  duration?: number;
  direction?: never;
  momentum?: never;
}

export interface Screen {
  /** Creates a lazy role query. An alias such as `img` is rewritten to its role. */
  getByRole(role: Role | RoleAlias, options?: RoleOptions): Locator;
  /** Creates a lazy role query narrowed to an accessible name: `getByRole('button', 'Sign in')`. */
  getByRole(role: Role | RoleAlias, name: TextMatch, options?: Omit<RoleOptions, 'name'>): Locator;
  /** Creates a lazy accessible-label query. */
  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy placeholder query. */
  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy visible-text query. */
  getByText(text: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy displayed-value query. */
  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator;
  /** Creates a lazy test-id query: a string matches the whole id, case-sensitive; a RegExp tests it. */
  getByTestId(id: TextMatch, options?: { visible?: boolean }): Locator;
  /** Taps a viewport point, with no node behind it. */
  tapAt(point: Point, options?: ActionOptions): Promise<void>;
  /** Performs a viewport-level swipe: in a direction, or along a path from one point to another. */
  swipe(options: SwipeOptions | SwipePathOptions): Promise<void>;
  /**
   * Scrolls until a locator resolves visibly or times out: the viewport on
   * `screen`, the node itself on a locator. `momentum` is the stride of each
   * step, `slow` unless told otherwise.
   */
  scrollUntilVisible(
    target: Locator,
    options?: { direction?: ScrollDirection; momentum?: Momentum; timeout?: number },
  ): Promise<void>;
}

export interface Locator extends Screen {
  /** Taps exactly one matching actionable node; with `position`, taps that point of its box once it is in view, with no other actionability check. */
  tap(options?: TapOptions): Promise<void>;
  /** Alias of tap. */
  click(options?: TapOptions): Promise<void>;
  /** Double-taps exactly one matching actionable node. */
  doubleTap(options?: ClickOptions): Promise<void>;
  /** Secondary-taps exactly one matching actionable node: a right click, a two-finger tap. */
  secondaryTap(options?: ClickOptions): Promise<void>;
  /** Long-presses exactly one matching actionable node. */
  longPress(options?: LongPressOptions): Promise<void>;
  /** Fills exactly one input. Secret values are never logged. */
  fill(value: string | Secret, options?: ActionOptions): Promise<void>;
  /**
   * Focuses exactly one input and types `text` through the keyboard, one
   * character at a time, so the app receives key events. A `Secret` is
   * refused; it goes through `fill`.
   */
  pressSequentially(text: string, options?: PressSequentiallyOptions): Promise<void>;
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
  /** Reads current hidden or absent state, the negation of `isVisible`. */
  isHidden(): Promise<boolean>;
  /** Reads current enabled state. */
  isEnabled(): Promise<boolean>;
  /** Reads current disabled state, the negation of `isEnabled`. */
  isDisabled(): Promise<boolean>;
  /** Reads current checked state. */
  isChecked(): Promise<boolean>;
  /** Reads the current viewport-relative rectangle. */
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** Counts current matches without auto-waiting. */
  count(): Promise<number>;
  /** One `nth(i)` locator per current match, without auto-waiting; empty when nothing matches. */
  all(): Promise<Locator[]>;
  /** Reads the normalized text of every current match, without auto-waiting; empty when nothing matches. */
  allTextContents(): Promise<string[]>;
  /**
   * Waits for the requested locator state, `visible` by default: `attached`
   * for one match, visible or not; `detached` for none; `hidden` for none or
   * a hidden one.
   */
  waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
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
   * allocated when `app.url` declared port 0; undefined for a target that
   * declares no `app.url`.
   */
  readonly baseUrl: string | undefined;
  /**
   * Opens the app: the declared URL, a path relative to it, or any absolute
   * http(s) URL. On a device target, which has no URL, it launches the pinned
   * app fresh and takes no path.
   */
  open(path?: string): Promise<void>;
  /**
   * Recreates the execution context while preserving persisted state, then
   * reopens the app at its base URL when the target declares one.
   */
  restart(): Promise<void>;
  /**
   * Clears persisted client state, recreates the execution context, then
   * reopens the app at its base URL when the target declares one.
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
  /** Agent steps. Acquiring the built-in agent without a configured model is `MODEL_UNAVAILABLE`. */
  readonly agent: Agent;
  /** App lifecycle: open, restart, clear state, back, screenshot. */
  readonly app: App;
  /** Semantic queries and the actions on their matches. */
  readonly screen: Screen;
  /** The target's platform label: `web`, `ios`, `android`, or an engine's own string. */
  readonly platform: string;
}

export interface SetupFixtures extends TestFixtures {
  /** Saves the sessions the setup test declared. */
  readonly session: SetupSession;
}

export interface SuiteFixtures {
  /** The target's platform label: `web`, `ios`, `android`, or an engine's own string. */
  readonly platform: string;
}

export interface TestOptions {
  /** Attempt deadline in milliseconds; defaults to `config.timeout`. Innermost wins. */
  timeout?: number;
  /** Retries, 0 through 10; defaults to `config.retries`. Inside a serial group the group's value applies. */
  retries?: number;
  /** Tags for `--tag`: distinct names, none blank, with no comma and no leading or trailing whitespace; every layer's tags are unioned. */
  tags?: readonly string[];
  /** Skips the test; a string is the reason. Any truthy layer skips. */
  skip?: boolean | string;
  /** Focuses the test locally. CI rejects it with `ONLY_IN_CI`. */
  only?: boolean;
  /** Platforms the test runs on; other targets skip it. Innermost wins. */
  platforms?: readonly string[];
  /** Capabilities the target must have; otherwise the test is skipped at selection. Innermost wins. */
  requires?: readonly Capability[];
  /** Session a setup test saved, restored before the body runs. */
  session?: string;
  /** Extra context for agent steps; layers are concatenated outermost first. */
  agentContext?: string;
  /**
   * The configured agent (`agents.<name>`) this test or group runs with, in
   * place of the run's agents. A list runs the test once per agent named, as
   * one result each. Innermost wins; a call's own `agent` option wins over
   * it. `--agent` narrows a list to the names both name and never overrides
   * a pin the flag does not name.
   */
  agent?: string | readonly string[];
  /**
   * Which of the test's attempts keep a trace, in place of the run's: the
   * same modes as the config's `trace`. Innermost wins, over `--trace` too;
   * inside a serial group the group's value applies, since the group runs as
   * one unit.
   */
  trace?: RecordingMode;
  /**
   * Which of the test's attempts record a video, in place of the run's:
   * the same modes as the config's `video`. Innermost wins, over `--video`
   * too; inside a serial group the group's value applies, since the group
   * records as one unit. A mode set here is required of the target's engine.
   */
  video?: RecordingMode;
}

export interface DescribeOptions extends Omit<TestOptions, 'only'> {
  /** Runs the group as one ordered retry unit with shared app state. Nesting one serial group in another is a `COLLECTION_ERROR`. */
  serial?: boolean;
}

export interface SetupOptions extends Omit<TestOptions, 'session' | 'only' | 'skip' | 'agent'> {
  /** Session names this setup test MUST save. */
  sessions: readonly string[];
  /** A setup test runs once per target, so it pins at most one agent. */
  agent?: string;
}

/** A test body. */
export type TestFn<Fixtures = TestFixtures> = (fixtures: Fixtures) => void | Promise<void>;
/** A setup test body; `session.save` is the extra fixture. */
export type SetupFn<Fixtures = TestFixtures> = (
  fixtures: Fixtures & SetupFixtures,
) => void | Promise<void>;
/** A `beforeEach` or `afterEach` body. */
export type TestHookFn<Fixtures = TestFixtures> = (fixtures: Fixtures) => void | Promise<void>;
/** A `beforeAll` or `afterAll` body. */
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
/** A `describe` body. An async body is a type error. */
export type SynchronousBody<Result> = Extract<Result, PromiseLike<unknown>> extends never
  ? () => Result
  : never;

/** Opaque handle of a registered test. */
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
  /**
   * Inside a running test: skips it when `condition` is true (or always,
   * with no condition) by throwing, so nothing after the call runs. The
   * attempt is reported `skipped` with `reason`; steps that already ran stay
   * in the report without deciding the status, and teardown still runs. A
   * setup test cannot skip: its sessions are owed.
   * Outside a test body this form is `COLLECTION_ERROR`; use the `skip`
   * option to skip at collection.
   */
  skip(condition: boolean, reason?: string): void;
  skip(reason?: string): void;
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
   *     workspace: async ({ browser }, use) => {
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

/**
 * The locator matchers. An option a matcher does not take, or a flag that is
 * not a boolean, is `INVALID_ARGUMENT` before the first read.
 */
export interface AsyncExpectation {
  /** Inverts the matcher. A negated matcher passes after 1000 ms of continuous truth. */
  readonly not: AsyncExpectation;
  /** Waits for visibility; `visible: false` waits for hidden or absent state, as `toBeHidden`. */
  toBeVisible(options?: { visible?: boolean; timeout?: number }): Promise<void>;
  /** Waits for hidden or absent state. */
  toBeHidden(options?: { timeout?: number }): Promise<void>;
  /** Waits for one match to exist, visible or not; `attached: false` waits for none. */
  toBeAttached(options?: { attached?: boolean; timeout?: number }): Promise<void>;
  /** Waits for enabled state; `enabled: false` waits for disabled state. */
  toBeEnabled(options?: { enabled?: boolean; timeout?: number }): Promise<void>;
  /** Waits for disabled state. */
  toBeDisabled(options?: { timeout?: number }): Promise<void>;
  /** Waits for checked state; `checked: false` waits for unchecked state. */
  toBeChecked(options?: { checked?: boolean; timeout?: number }): Promise<void>;
  /** Waits for selected state. */
  toBeSelected(options?: { timeout?: number }): Promise<void>;
  /** Waits for expanded state. */
  toBeExpanded(options?: { timeout?: number }): Promise<void>;
  /** Waits for focused state. */
  toBeFocused(options?: { timeout?: number }): Promise<void>;
  /** Waits for exact normalized text; a list waits for exactly that many matches, each with its entry's text, in order. */
  toHaveText(expected: TextMatch, options?: TextMatcherOptions): Promise<void>;
  toHaveText(expected: readonly TextMatch[], options?: TextMatcherOptions): Promise<void>;
  /** Waits for contained normalized text; a list waits for each entry to be contained by a distinct match, in order, extra matches allowed. */
  toContainText(expected: TextMatch, options?: TextMatcherOptions): Promise<void>;
  toContainText(expected: readonly TextMatch[], options?: TextMatcherOptions): Promise<void>;
  /** Waits for a form control's value, compared as it is. */
  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the attribute to be present; with `value`, for it to match. */
  toHaveAttribute(name: string, options?: { timeout?: number }): Promise<void>;
  toHaveAttribute(name: string, value: TextMatch, options?: TextMatcherOptions): Promise<void>;
  /** Waits for an exact match count. */
  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void>;
  /** Waits for an accessible name. */
  toHaveAccessibleName(expected: TextMatch, options?: TextMatcherOptions): Promise<void>;
}

/** Options of a locator matcher that compares text. */
export interface TextMatcherOptions {
  /** Compares a string case-insensitively; on a RegExp, `true` adds the `i` flag and `false` removes it. */
  ignoreCase?: boolean;
  /** Assertion budget in milliseconds. */
  timeout?: number;
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

/** A class, abstract or not: what `expect.any` takes. */
export type Class = abstract new (...args: never[]) => unknown;

/** A property path for `toHaveProperty`: dotted (`'user.address.city'`) or one key per element (`['user', 'address', 'city']`). */
export type PropertyPath = string | readonly (string | number)[];

/**
 * A stand-in for a value inside `toEqual`, `toMatchObject`, `toContain`, and
 * `toHaveProperty`: `expect.any(Number)` in place of a number,
 * `expect.objectContaining({ id: 1 })` in place of a record. The structural
 * matchers ask it whether a value matches instead of comparing.
 */
export interface AsymmetricMatcher {
  /** Whether `other` satisfies the matcher. */
  asymmetricMatch(other: unknown): boolean;
  /** The matcher's name, `ObjectContaining`; a failure message adds the sample. */
  toString(): string;
}

export interface ValueExpectation<T> {
  /** Inverts the matcher. */
  readonly not: NegatedValueExpectation<T>;
  /** Compares with Object.is. */
  toBe(expected: T): void;
  /** Performs recursive structural equality; `undefined` properties are ignored and class types are not compared. */
  toEqual(expected: unknown): void;
  /** Requires every property of `expected` to match recursively; extra properties on the value are fine, arrays must match element-wise with equal length. */
  toMatchObject(expected: object): void;
  /** Requires a truthy value. */
  toBeTruthy(): void;
  /** Requires a falsy value. */
  toBeFalsy(): void;
  /** Requires null. */
  toBeNull(): void;
  /** Requires undefined. */
  toBeUndefined(): void;
  /** Requires any value but undefined; null passes. */
  toBeDefined(): void;
  /** Requires a `length` property equal to `expected`: a string, an array, or anything array-like. */
  toHaveLength(expected: number): void;
  /** Requires the property at `path` to exist; with `expected`, to equal it by `toEqual` rules. */
  toHaveProperty(path: PropertyPath, ...expected: [] | [expected: unknown]): void;
  /** Requires string or collection containment. */
  toContain(expected: unknown): void;
  /** Requires a string or regexp match. */
  toMatch(expected: string | RegExp): void;
  /** Requires a numeric lower bound. */
  toBeGreaterThan(expected: number): void;
  /** Requires a numeric lower bound, inclusive. */
  toBeGreaterThanOrEqual(expected: number): void;
  /** Requires a numeric upper bound. */
  toBeLessThan(expected: number): void;
  /** Requires a numeric upper bound, inclusive. */
  toBeLessThanOrEqual(expected: number): void;
  /** Requires a number within `10 ** -digits / 2` of `expected`; `digits` defaults to 2. */
  toBeCloseTo(expected: number, digits?: number): void;
  /**
   * Requires the value to pass a synchronous Standard Schema (Zod, Valibot,
   * ArkType, ...) and returns the schema's output, typed:
   * `const users = expect(await response.json()).toMatchSchema(Users)`.
   * A schema that validates asynchronously is `INVALID_ARGUMENT`.
   */
  toMatchSchema<Schema extends StandardSchemaV1>(schema: Schema): StandardSchemaV1.InferOutput<Schema>;
}

/** The names of the value matchers, every key of `ValueExpectation` but `not`. */
export type ValueMatcherName = Exclude<keyof ValueExpectation<unknown>, 'not'>;

/** `expect(value).not`: every value matcher inverted, none returning a value; `Back` is what `.not` returns to. */
export type NegatedValueExpectation<T, Back = ValueExpectation<T>> = {
  /** Inverts the matcher back. */
  readonly not: Back;
} & {
  readonly [K in ValueMatcherName]: (...args: Parameters<ValueExpectation<T>[K]>) => void;
};

/**
 * `expect.soft(value)`: the value matchers, with `toMatchSchema` returning
 * `undefined` when the value failed and the failure was kept for the end of
 * the body.
 */
export type SoftValueExpectation<T> = Omit<ValueExpectation<T>, 'toMatchSchema' | 'not'> & {
  /** Inverts the matcher; still soft, so a double negation's `toMatchSchema` may return `undefined` too. */
  readonly not: NegatedValueExpectation<T, SoftValueExpectation<T>>;
  /** Requires the value to pass the schema; returns its output, or `undefined` after a kept failure. */
  toMatchSchema<Schema extends StandardSchemaV1>(schema: Schema): StandardSchemaV1.InferOutput<Schema> | undefined;
};

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
 * Derived from `ValueExpectation<T>` so the two cannot drift; the one
 * matcher that returns a value, `toMatchSchema`, is spelled out to resolve
 * to the schema's output for the passing read.
 */
export type PollExpectation<T> = {
  readonly not: NegatedPollExpectation<T>;
} & {
  readonly [K in Exclude<ValueMatcherName, 'toMatchSchema'>]: (
    ...args: Parameters<ValueExpectation<T>[K]>
  ) => Promise<void>;
} & {
  /** Resolves to the schema's output once a read passes it. */
  toMatchSchema<Schema extends StandardSchemaV1>(schema: Schema): Promise<StandardSchemaV1.InferOutput<Schema>>;
};

/** `expect.poll(read).not`: every poll matcher inverted, none resolving to a value. */
export type NegatedPollExpectation<T> = {
  /** Inverts the matcher back. */
  readonly not: PollExpectation<T>;
} & {
  readonly [K in ValueMatcherName]: (...args: Parameters<ValueExpectation<T>[K]>) => Promise<void>;
};

/** The `expect(actual)` call: a locator, an engine fixture, or a value, told apart by the argument. */
export interface ExpectCall {
  (actual: Locator): AsyncExpectation;
  <E extends object>(actual: Expectable<E>): E;
  /** `message` opens the failure text, so a bare `expected false to be true` says which check it was. */
  <T>(actual: T, message?: string): ValueExpectation<T>;
}

/** The `expect.soft(actual)` call: `expect(actual)` whose failures are kept instead of thrown. */
export interface SoftExpectCall {
  (actual: Locator): AsyncExpectation;
  <E extends object>(actual: Expectable<E>): E;
  /** `message` opens the failure text, so a bare `expected false to be true` says which check it was. */
  <T>(actual: T, message?: string): SoftValueExpectation<T>;
}

/** The `expect` entry: the call, `expect.poll`, `expect.soft`, and the asymmetric matchers. */
export interface Expect extends ExpectCall {
  /** Re-reads a value until the chosen matcher holds or `timeout` passes. */
  poll<T>(read: () => T | Promise<T>, options?: PollOptions): PollExpectation<T>;
  /**
   * The same matchers, but a failure is kept on the running attempt instead
   * of thrown, and the body runs on. Once the body has settled the attempt
   * fails with `ASSERTION_FAILED` listing every kept failure. Outside a test
   * body (a standalone script, an `afterEach` hook) a failure throws at once.
   */
  readonly soft: SoftExpectCall;
  /** Matches an instance of the class; for `String`, `Number`, `Boolean`, `BigInt`, `Symbol`, and `Function`, the primitive too; for `Object`, anything `typeof` calls an object, `null` included. */
  any(sample: Class | typeof BigInt | typeof Symbol): AsymmetricMatcher;
  /** Matches anything but `null` and `undefined`. */
  anything(): AsymmetricMatcher;
  /** Matches an object whose properties include every property of `sample`, each compared with `toEqual` rules. */
  objectContaining(sample: object): AsymmetricMatcher;
  /** Matches an array holding every element of `sample`, each compared with `toEqual` rules, in any order. */
  arrayContaining(sample: readonly unknown[]): AsymmetricMatcher;
  /** Matches a string with `sample` as a substring. */
  stringContaining(sample: string): AsymmetricMatcher;
  /** Matches a string the RegExp tests true on; a string sample is compiled to a RegExp. */
  stringMatching(sample: string | RegExp): AsymmetricMatcher;
}

export interface CommandConfig {
  /** Resolved with `PATH`; never shell-interpreted. */
  executable: string;
  /** Passed verbatim; `{port}` expands to the app's port. */
  args?: readonly string[];
  /** Working directory, resolved from the project root. */
  cwd?: string;
  /** Added to the inherited set; `{port}` expands in values. */
  env?: Readonly<Record<string, string>>;
  /** Ready-probe budget in milliseconds; default 60000. Expiry is `APP_UNREACHABLE`. */
  startupTimeout?: number;
  /** Grace period before force-kill in milliseconds; default 10000. */
  shutdownTimeout?: number;
  /** File that receives the process's stdout and stderr, appended, resolved from the project root. Omitted discards output. */
  log?: string;
  /**
   * When the readiness URL already answers before the command starts, use that
   * process instead of spawning: nothing is started and nothing is stopped.
   * Off by default; CI ignores it and always starts the command. A URL on a
   * free port (port 0) can never already answer, so the two together are
   * `INVALID_CONFIG`.
   */
  reuseExisting?: boolean;
}

/** A permission's state when the app launches: held, refused, or not asked for yet, so the OS asks again. */
export type AppPermissionState = 'grant' | 'deny' | 'reset';

/**
 * The app one target tests, declared on the target and nowhere else: engines
 * only drive it. Every field also accepts `undefined`, so values read straight
 * from `process.env` need no conditional spread. A browser target names the
 * `url` it opens; a device target names the installed app (`bundleId`) or
 * the build (`appPath`) it launches. Each engine checks the fields its
 * platform needs at config load. `command` and `readyUrl` start the app for
 * this target alone.
 */
export interface TargetApp {
  /**
   * Base URL of an addressable app: `app.open()` opens it and relative
   * navigation resolves against it. WHATWG-normalized; no userinfo, query, or
   * fragment; a missing scheme becomes `https://`, or `http://` for a
   * loopback host. Plain HTTP is accepted for loopback hosts only. A URL on
   * `127.0.0.1` or `[::1]` with port 0 asks the run for a free port for
   * `command`, handed to it as `{port}`; without a command nothing would
   * serve it, so that is `INVALID_CONFIG`.
   */
  url?: string | undefined;
  /**
   * The installed app a device target launches: a bundle id, an Android
   * package name, or a display name the device resolves (`Settings`).
   */
  bundleId?: string | undefined;
  /**
   * The build a device target runs against, an iOS `.app` bundle or an
   * Android `.apk`, resolved against the project root. Without `bundleId`,
   * the app it installs is the one launched.
   */
  appPath?: string | undefined;
  /**
   * Stable logical identity of the app under test, keying replay cache and
   * session entries. Defaults to the URL's origin and base path, else
   * `bundleId`, else `appPath`, so an ephemeral per-deploy origin (a PR
   * preview) cold-starts every entry; an explicit identity keys them by what
   * the app *is* instead of where it is served this run. Never share one
   * identity across genuinely different apps: recorded traces would replay
   * across them.
   */
  identity?: string | undefined;
  /**
   * Labels the target in the report and joins the cache and session identity
   * digest; never gates a run. Defaults to `test` for loopback, `.localhost`,
   * and `.test` hosts and for an app without a URL, `production` otherwise.
   */
  environment?: 'test' | 'staging' | 'production' | undefined;
  /**
   * Arguments a device app is launched with on every fresh launch
   * (`app.open()`, `app.restart()`, `app.clearState()`). Arguments that
   * select a build mode change what the app is: give each mode its own
   * `identity` so their recordings stay apart.
   */
  launchArguments?: readonly string[] | undefined;
  /**
   * Permissions a device app holds on every fresh launch, by name, each
   * granted, denied, or reset before the app starts.
   */
  permissions?: Readonly<Record<string, AppPermissionState>> | undefined;
  /**
   * Process the runner starts before the first test and stops at the end of
   * the run (a dev server, Metro for a debug build). Structured, never
   * shell-interpreted; the child inherits only `PATH`, `HOME`, the
   * temp-directory variables, and `command.env`. `{port}` in it is the port
   * of `url`, fixed or free. Targets declaring the same command share one
   * process, probed at the first declaring target's `readyUrl`. A release
   * build has no command.
   */
  command?: CommandConfig | undefined;
  /**
   * URL polled until `command` is ready (a 200-499 status); defaults to
   * `url`, and is required without one. `{port}` in it is the port of `url`.
   */
  readyUrl?: string | undefined;
}

/**
 * One target: a named surface on one platform, served by an engine.
 * What the target can do is graded from the engine's declared capabilities;
 * with no `engine` the target is agent-tools-only and everything runs opaque.
 * The app under test is the target's `app`; the engine only drives it.
 */
export interface Target {
  /** Label in reports and for `--target`; defaults to the platform. */
  name?: string;
  /**
   * Platform label, inherited from the engine when omitted. Required for a
   * target without an engine; when both name one, they must agree.
   */
  platform?: string;
  /** The engine driving the surface: `web(...)`, `mobile(...)`, or any `defineEngine` handle. */
  engine?: EngineHandle;
  /** The app under test: what it is, where it is served, and the command that starts it. */
  app?: TargetApp;
  /**
   * Which attempts on this target keep a trace, in place of the config's
   * `trace`; `--trace` and a test's own `trace` win over it.
   */
  trace?: RecordingMode;
  /**
   * Which attempts on this target record a video, in place of the config's
   * `video`; `--video` and a test's own `video` win over it. A mode set here
   * is required of the engine: one that cannot record fails the run with
   * `UNSUPPORTED_ARTIFACT`.
   */
  video?: RecordingMode;
}

/**
 * Which attempts keep a trace or record a video, and which are kept.
 * `off`: none. `on`: every attempt, every recording kept.
 * `retain-on-failure`: every attempt records, only the recordings of attempts
 * that did not pass are kept. `on-first-retry`: only the first retry records,
 * so a test that passes first time costs nothing and a flaky one leaves a
 * recording of the retry. `on-all-retries`: every attempt after the first.
 */
export type RecordingMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries';

/**
 * A live AI SDK language model instance: `gateway('openai/gpt-6-luna-fast')`
 * from `ai`, `openrouter(...)` from `@openrouter/ai-sdk-provider`,
 * `openai('gpt-4o')` from `@ai-sdk/openai`, or any other provider
 * implementing the AI SDK `LanguageModelV2+` specification. The instance owns
 * its own transport and credentials; the runner knows no gateway or provider
 * of its own. Detection is structural, so any AI SDK provider package works
 * without this runner depending on it.
 */
export interface ModelInstance {
  /** The AI SDK specification the instance implements. */
  readonly specificationVersion: string;
  /** Provider id, recorded per step in the report. */
  readonly provider: string;
  /** Model id, recorded per step in the report. */
  readonly modelId: string;
  /** The generate call every AI SDK language model implements; what tells a live instance from its three id strings. */
  readonly doGenerate: (...args: never[]) => unknown;
}

/** Replay cache posture. In CI an unset mode is `read-only`, unless `cache.store` is set. */
export type CacheMode = 'off' | 'read-only' | 'read-write';

/**
 * Replay cache configuration. The store abstraction is the cloud seam: the
 * default file store keeps entries under `.e2e/cache/`, and a custom
 * `CacheStore` (Redis, an API, anything implementing read/write over
 * key digests) replaces it wholesale. Like agents and model instances, a
 * store never crosses a process boundary: workers re-resolve the config
 * module and construct their own.
 */
export interface CacheConfig {
  /** Default `read-write`; `read-only` in CI when unset. */
  mode?: CacheMode;
  /** Custom entry store; omit it to use the file store at `dir`. */
  store?: CacheStore;
  /** File store directory, resolved against the project root. */
  dir?: string;
  /**
   * Fails a step whose recording exists but no longer replays (a control
   * not found or ambiguous, a rejected action, an end state that did not
   * come back, the app on another screen, an unreadable entry) with
   * `REPLAY_STALE`, instead of handing it to the agent. A step with no
   * recording, a retry, and a value read off the screen still run live.
   * `--strict-cache` sets it for one run. Default `false`.
   */
  strict?: boolean;
}

/**
 * One produced artifact as handed to an `ArtifactStore`, the moment it is
 * complete on disk: its bytes, digest, and report identity. `path` is the
 * report-relative path the record carries, stable across runs of the same
 * test, so a host may use it as its own key.
 */
export interface StoredArtifact {
  readonly kind: 'screenshot' | 'video' | 'download' | 'log';
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly sha256: string;
  /** Report-relative path with `/` separators. */
  readonly path: string;
  /**
   * How much of the file the runner masked, as the report records it. A
   * `download` is `incomplete` unless the runner ran it as text through the
   * session's secret values; a store that exports only what the runner
   * vouches for reads this rather than the kind.
   */
  readonly redaction: 'complete' | 'incomplete';
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
 * `CacheStore` is for the replay cache. A failed `put` never fails the run: the
 * record simply carries no `ref`. Like every live value, a store never
 * crosses a process boundary.
 */
export interface ArtifactStore {
  put(artifact: StoredArtifact): Promise<{ readonly ref: string }>;
  /**
   * Receives a video a hosted service keeps (a browser or device provider's
   * own recording): a link with no bytes, so `put` never sees it. Returns a
   * reference the report records as the artifact's `ref` beside its `url`.
   * Optional: without it a link is only recorded. A passed attempt's link
   * under `retain-on-failure` is never handed over, since the report leaves
   * it out. A failed `putLink` never fails the run, like `put`.
   */
  putLink?(link: StoredArtifactLink): Promise<{ readonly ref: string }>;
}

/** One provider-hosted recording, handed to `store.putLink` once the attempt stopped it. */
export interface StoredArtifactLink {
  readonly kind: 'video';
  /** The `http(s)` URL the service serves the recording from. */
  readonly url: string;
  readonly mediaType: string;
  /** A recording masks nothing, so a link is always `incomplete`. */
  readonly redaction: 'incomplete';
  readonly runId: string;
  readonly testId: string;
  readonly attemptId: string;
  /** When the recording started, as an ISO timestamp. */
  readonly startedAt: string;
  /** The step that was running when the recording was registered, if any. */
  readonly stepId?: string;
}

/**
 * Where artifacts go. What is recorded is not configured here: `trace` and
 * `video` choose what is kept, and a failure's screenshot and screen text
 * are captured whenever the engine can.
 */
export interface ArtifactsConfig {
  /** Host store every produced artifact is handed to; omit it to keep files local only. */
  store?: ArtifactStore;
}

/**
 * AI SDK provider options, keyed by provider then option name, e.g.
 * `{ openai: { reasoningEffort: 'low' } }`. Sent with every model call of
 * both the act tier and the judgment tier.
 */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * A project tool as `defineTool` from `e2e/agent` returns it. Typed
 * structurally so this entrypoint names nothing from the optional `ai` peer;
 * config resolution accepts only values `defineTool` built.
 */
export interface AgentTool {
  readonly tool: object;
  readonly annotations: { readonly mutates: boolean; readonly platforms?: readonly string[] };
}

/** The options every agent takes, whichever brain runs its `act` steps. */
export interface AgentOptions {
  /** An AI SDK model instance; no implicit default. */
  model?: ModelInstance;
  /**
   * The model that judges `assert`, `waitFor`, and `extract`; defaults to
   * `model`. A judge of its own separates the model that grades a flow from
   * the one that drove it.
   */
  judge?: ModelInstance;
  /**
   * What the app calls things, told to every model call this agent makes,
   * act turns and judgments alike: the names of screens and menus, where a
   * feature lives, which button submits a form. At most 16384 bytes.
   */
  context?: string;
  /** Committed actions per agent call, 1 through 100; default 25. */
  maxSteps?: number;
  /** Model requests per agent call, 1 through 100; default 25. */
  maxModelCalls?: number;
  /** Deadline of one `assert`, `waitFor`, or `extract` call in milliseconds; default 30000. Raise it for a slow judge; engine operations keep `actionTimeout`. */
  judgmentTimeout?: number;
  /** Observation payload ceiling for act turns and judgments, 1024 through 16777216; default 262144. */
  maxObservationBytes?: number;
  /** Input tokens per model request, 1 through 1000000; default 64000. A dense screen is cut to fit under it. */
  maxInputTokens?: number;
  /**
   * Provider options every model call carries, e.g. a reasoning effort.
   * OpenAI and Azure OpenAI calls also carry `store: false` and a prompt
   * cache key unless set here.
   */
  providerOptions?: ProviderOptions;
  /** Never set: an entry is not itself a `StepExecutor`; a custom brain goes under `executor`. */
  runStep?: never;
}

/**
 * One entry of `agents`: the built-in agent with its options, or a custom
 * brain under `executor`. Each entry starts from the built-in defaults; no
 * agent inherits another's values, `default`'s included.
 */
export type AgentConfig = AgentOptions &
  (
    | {
        executor?: never;
        /**
         * How the acting agent should work, appended to the built-in execution
         * rules: its persona, its caution, what it verifies before it finishes.
         * Only the act loop reads it. The judges behind `assert`, `waitFor`,
         * and `extract` never see it, so nothing here can talk a judge into a
         * verdict.
         */
        system?: string;
        /** Project tools from `defineTool`, offered beside the built-in toolset. */
        tools?: Readonly<Record<string, AgentTool>>;
      }
    | {
        /**
         * A custom brain `agent.act()` dispatches to instead of the built-in
         * agent. The model, judge, budgets, and context still apply; `system`
         * and `tools` belong to the built-in agent and are rejected here.
         */
        executor: StepExecutor;
        system?: never;
        tools?: never;
      }
  );

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
  /** The report-1 document, as written. */
  readonly report: Report;
  /** The same status `report.run.status` carries. */
  readonly status: RunStatus;
  /** The exit code the process will end with. */
  readonly exitCode: RunExitCode;
  /** Absolute project root, what the terminal shows paths relative to. */
  readonly projectRoot: string;
  /** Where `report.json` was written; undefined when the write failed or config never loaded. */
  readonly reportPath: string | undefined;
  /** Absolute directory the report's artifact paths are relative to: `<output>/results`, a directory per test. */
  readonly artifactsRoot: string;
  /** Where `--ai-trace` wrote the run's model calls, when it was requested. */
  readonly aiTracePath: string | undefined;
  /**
   * The trace the runner wrote for each test that kept one (by its `trace`
   * mode, a failed one by default), by report result id, as a path from the
   * project root (`.e2e/results/checkout-applies-the-coupon-1a2b3c4d5e6f7a8b/trace.md`).
   */
  readonly traces: ReadonlyMap<string, string>;
  /**
   * The report `--last-failed` selected from, when the run was given that
   * flag: the run before this one, whose tests that did not fail were left
   * out here. A reporter that keeps one place current folds this run into it.
   */
  readonly lastRun?: Report;
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
  /** Label in diagnostics; required. */
  readonly name: string;
  /** Every run event as it happens. Must not block or throw. */
  onEvent?(event: RunEvent): void;
  /** Runs once the report is written and the summary printed; awaited one minute. Returned rows print under the summary. */
  onRunFinished?(run: FinishedRun, signal: AbortSignal): Promise<ReporterSummary | void>;
}

export interface E2EConfig {
  /** Stable project id, 1 through 256 characters; defaults to the root `package.json` name. */
  projectId?: string;
  /** The surfaces tests run on; required, at least one, each naming its engine. */
  targets: readonly Target[];
  /** Test file globs relative to the project root (`*`, `?`, and a whole `**` segment; a leading `!` excludes); default every `*.e2e.ts` under `tests/`. */
  tests?: string | readonly string[];
  /** Test attempt deadline in milliseconds; default 120000. */
  timeout?: number;
  /** Engine init and attempt start budget in milliseconds; default 60000. */
  launchTimeout?: number;
  /** Budget of every engine operation in milliseconds; default 30000. */
  actionTimeout?: number;
  /** Default `expect` deadline in milliseconds; default 5000. */
  assertionTimeout?: number;
  /** Budget of each `afterEach` hook, fixture teardown, and engine cleanup in milliseconds; default 30000. */
  cleanupTimeout?: number;
  /** Retries per test, 0 through 10; default 1 in CI, else 0. */
  retries?: number;
  /** Fail the run when a test skips itself after a soft failure or an earlier failed attempt; default false. */
  failOnSkippedFailure?: boolean;
  /** Parallel workers, 1 through 1024; default 1 in CI, else half the cores. An engine may cap it lower. */
  workers?: number;
  /** `{ store }` hands every artifact to a host store as it is produced. */
  artifacts?: ArtifactsConfig;
  /**
   * Which attempts keep a trace, a `trace.md` page in the test's directory
   * under `<output>/results/` telling every step, the cache's decisions, what
   * the app logged, and the screen at failure; default `retain-on-failure`. A target's `trace` wins
   * over it, `--trace [mode]` over both, and a test's own `trace` over all.
   */
  trace?: RecordingMode;
  /**
   * Which attempts record a video; default `off`. A target's `video` wins
   * over it, `--video [mode]` over both, and a test's own `video` over all.
   * Applies to the targets whose engine can record.
   */
  video?: RecordingMode;
  /**
   * The directory a run writes its results to, relative to the project root;
   * default `.e2e`. It holds `report.json`, `junit.xml`, `summary.md`,
   * `ai-trace.json`, `artifacts/` (cleared at the start of every run),
   * `sessions/`, and the `e2e mcp` session videos under `videos/`.
   * `--output <dir>` overrides it for one run. It must be inside the project
   * root and not the root itself, may not hold a test glob's directory, and
   * is independent of `cache.dir`, which may sit inside it but not under a
   * directory the run clears.
   */
  output?: string;
  /**
   * Output renderers and reporter objects. `junit` writes `<output>/junit.xml`,
   * `markdown` writes `<output>/summary.md`, `json` prints the report and
   * excludes `list`; a `Reporter` object runs
   * beside them and `--reporter` never removes it.
   */
  reporters?: readonly (BuiltinReporter | Reporter)[];
  /**
   * The agents by name, each one plain object: the built-in agent's options,
   * or `{ executor }` for a custom brain. `default` is the one tests run
   * with; `e2e run --agent <name>` runs them with another. Every agent starts
   * from the built-in defaults: none inherits another's values. Agents never
   * cross a process boundary: workers re-resolve the config module and
   * construct their own, exactly like model instances.
   */
  agents?: Readonly<Record<string, AgentConfig>>;
  /**
   * The adaptive replay cache. Opt-out: unset means
   * `read-write`, and `'off'` disables it, as does the `--no-cache` flag,
   * which wins over the config. A string is shorthand for `{ mode }`. In CI an
   * unset mode is demoted to `read-only`: a committed cache is untrusted
   * input. An explicit `read-write` is honored as the project's own statement
   * of trust in the cache it restores.
   */
  cache?: CacheMode | CacheConfig;
  /**
   * Named accounts. `credentials.user(name).password` is the handle of a
   * credential's password, a secret named `<name>.password`; `secrets.get()`
   * never returns it, so a credential and a secret may share a name.
   */
  credentials?: Readonly<Record<string, CredentialConfig>>;
  /**
   * Named values the model must never see: API keys, tokens, anything sourced
   * from the environment. `secrets.get(name)` hands a test the opaque handle;
   * the value is filled by the runner, masked in every observation, and
   * redacted from logs and the report.
   */
  secrets?: Readonly<Record<string, SecretConfig>>;
}
