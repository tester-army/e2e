/** Canonical public declarations for the e2e sdk-0.1 profile. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type Platform = 'web' | 'ios' | 'android' | (string & {});
export type Capability = 'web' | 'device' | (string & {});
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type Momentum = 'none' | 'slow' | 'fast';

declare const secretBrand: unique symbol;
declare const credentialBrand: unique symbol;
declare const testCaseBrand: unique symbol;
declare const driverHandleBrand: unique symbol;

/** Opaque host-side value accepted only by sensitive input sinks. */
export interface Secret {
  readonly name: string;
  readonly purpose: 'password' | 'one-time-code' | 'generic-secret';
  readonly [secretBrand]: true;
}

/** Named test identity. The password remains an opaque Secret. */
export interface Credential {
  readonly name: string;
  readonly username: string;
  readonly password: Secret;
  readonly [credentialBrand]: true;
}

export interface Credentials {
  /** Resolves a named credential without exposing its password. */
  user(name: string): Credential;
}

export const credentials: Credentials;

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
      options?: Options | undefined,
    ) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }

  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  type Result<Output> = SuccessResult<Output> | FailureResult;

  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  interface FailureResult {
    readonly issues: readonly Issue[];
  }

  interface Issue {
    readonly message: string;
    readonly path?: readonly (PropertyKey | PathSegment)[] | undefined;
  }

  interface PathSegment {
    readonly key: PropertyKey;
  }

  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
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
 * - `'fallback'` — the tree, escalating to add a screenshot once the tree turns
 *   out not to describe the target.
 * - `'only'` — the screenshot, and not the tree.
 *
 * `'only'` exists because a tree sent alongside pixels is a cheaper path to an
 * answer, and a model will take it: asked whether a form is covered by an
 * overlay, it can read from the tree that the form is present and named and
 * answer yes, while the pixels show the overlay. For a judgment that is about
 * what the page presents, the tree is a distractor, so the mode that means it
 * removes it. It also costs fewer input tokens than `true`, not more.
 *
 * A locate under `'only'` can only answer with a screenshot point, since there
 * are no node identifiers to choose from. Methods that need a semantic node to
 * hand the driver — `type`, `select`, `upload`, `scrollTo`, `dragTo` — therefore
 * reject `'only'` with `POLICY_DENIED` rather than acting on a coordinate.
 *
 * `'fallback'` needs a signal that the tree was insufficient, which only a
 * method that locates a target has: the model reporting no match, or no derived
 * query resolving the node it chose. A judgment always produces an answer from
 * the tree, so `'fallback'` leaves `assert`, `waitFor`, and `extract` tree-only;
 * use `true` or `'only'` to have pixels judged.
 *
 * In every mode that sends pixels but also the tree, pixel evidence degrades
 * away rather than failing the call when it cannot be proven redacted. `'only'`
 * has nothing to degrade to, so it fails with `POLICY_DENIED` instead of
 * answering the wrong question from the tree.
 */
export type VisionMode = boolean | 'fallback' | 'only';

export interface VisionOption {
  vision?: VisionMode;
}

export interface AgentOptions extends VisionOption {
  timeout?: number;
  maxSteps?: number;
  maxModelCalls?: number;
  cache?: boolean;
}

export type LoginOptions = Omit<AgentOptions, 'cache'>;

export interface AgentSchemaOptions<Schema extends StandardSchemaV1>
  extends AgentOptions {
  schema: Schema;
}

export interface AgentResult {
  readonly ok: true;
}

export interface AgentResultWithData<Output> extends AgentResult {
  readonly data: Output;
}

export type AgentErrorCode =
  | 'AUTH_CREDENTIAL_UNAVAILABLE'
  | 'AUTHENTICATION_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_PROVIDER_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'APP_UNREACHABLE'
  | 'APP_NOT_OPEN'
  | 'LOCATOR_NOT_FOUND'
  | 'LOCATOR_AMBIGUOUS'
  | 'ACTION_FAILED'
  | 'CACHE_REPLAY_DIVERGED'
  | 'POLICY_DENIED'
  | 'STEP_BUDGET_EXHAUSTED'
  | 'STEP_TIMEOUT'
  | 'STEP_NO_CONCLUSION'
  | 'ASSERTION_FAILED'
  | 'CANCELLED';

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly explanation: string;
  readonly screenshot?: string;
}

export interface InstantActionOptions extends VisionOption {
  timeout?: number;
  cache?: boolean;
}

export interface Agent {
  /** Plans a flow and validates its structured result with Standard Schema v1. */
  act<Schema extends StandardSchemaV1>(
    instruction: string,
    params: AgentParams | undefined,
    options: AgentSchemaOptions<Schema>,
  ): Promise<AgentResultWithData<StandardSchemaV1.InferOutput<Schema>>>;
  /** Plans and executes a bounded multi-action flow. */
  act(
    instruction: string,
    params?: AgentParams,
    options?: AgentOptions,
  ): Promise<AgentResult>;
  /** Locates one target and taps it once. */
  tap(target: string, options?: InstantActionOptions): Promise<void>;
  /** Alias of tap. */
  click(target: string, options?: InstantActionOptions): Promise<void>;
  /** Locates one target and types a plain or host-side secret value. */
  type(
    target: string,
    value: string | Secret,
    options?: InstantActionOptions,
  ): Promise<void>;
  /** Performs one deterministic scroll, optionally inside a located target. */
  scroll(
    options: InstantActionOptions & {
      direction: ScrollDirection;
      momentum?: Momentum;
      within?: string;
    },
  ): Promise<void>;
  /** Locates a target by scrolling toward it. */
  scrollTo(
    target: string,
    options?: InstantActionOptions & { direction?: ScrollDirection },
  ): Promise<void>;
  /** Locates one target and long-presses it once. */
  longPress(
    target: string,
    options?: InstantActionOptions & { durationMs?: number },
  ): Promise<void>;
  /** Locates one target and sends it one key, e.g. `Enter`. */
  press(target: string, key: string, options?: InstantActionOptions): Promise<void>;
  /** Locates one select-like control and picks one option. */
  select(target: string, value: SelectOption, options?: InstantActionOptions): Promise<void>;
  /** Locates one target and hovers over it. */
  hover(target: string, options?: InstantActionOptions): Promise<void>;
  /** Locates one checkable target and checks it. */
  check(target: string, options?: InstantActionOptions): Promise<void>;
  /** Locates one checkable target and unchecks it. */
  uncheck(target: string, options?: InstantActionOptions): Promise<void>;
  /** Locates a source and a destination, then drags source onto destination. */
  dragTo(source: string, destination: string, options?: InstantActionOptions): Promise<void>;
  /**
   * Locates one file input and sets its files. Paths come from test code and
   * resolve from the project root; the model never chooses a path.
   */
  upload(
    target: string,
    paths: string | readonly string[],
    options?: InstantActionOptions,
  ): Promise<void>;
  /** Polls a natural-language condition until true or timed out. */
  waitFor(
    condition: string,
    options?: VisionOption & { timeout?: number; intervalMs?: number; maxModelCalls?: number },
  ): Promise<void>;
  /** Authenticates with a pinned credential. */
  login(user: Credential, options?: LoginOptions): Promise<AgentResult>;
  /** Extracts and validates structured screen data. */
  extract<Schema extends StandardSchemaV1>(
    instruction: string,
    options: VisionOption & { schema: Schema; timeout?: number; maxModelCalls?: number },
  ): Promise<StandardSchemaV1.InferOutput<Schema>>;
  /** Judges a natural-language assertion against fresh observations. */
  assert(
    assertion: string,
    options?: VisionOption & {
      timeout?: number;
      screenshot?: boolean;
    },
  ): Promise<void>;
}

export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'checkbox'
  | 'switch'
  | 'slider'
  | 'image'
  | 'heading'
  | 'tab'
  | 'menuitem'
  | 'listitem'
  | 'status'
  | 'dialog'
  | 'alert';
export type TextMatch = string | RegExp;

export interface TextMatchOptions {
  exact?: boolean;
}

export interface RoleOptions extends TextMatchOptions {
  name?: TextMatch;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  hidden?: boolean;
}

export interface ActionOptions {
  timeout?: number;
}

export interface SwipeOptions {
  direction: ScrollDirection;
  momentum?: Momentum;
}

export type SelectOption =
  | string
  | { label: string; index?: never }
  | { label?: never; index: number };

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
  getByTestId(id: string): Locator;
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
  longPress(options?: ActionOptions & { durationMs?: number }): Promise<void>;
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
  selectOption(
    value: SelectOption,
    options?: ActionOptions,
  ): Promise<void>;
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
  /** Reads one exposed attribute. */
  getAttribute(name: string): Promise<string | null>;
  /** Reads current visibility. */
  isVisible(): Promise<boolean>;
  /** Reads current enabled state. */
  isEnabled(): Promise<boolean>;
  /** Reads current checked state. */
  isChecked(): Promise<boolean>;
  /** Reads the current viewport-relative rectangle. */
  boundingBox(): Promise<
    { x: number; y: number; width: number; height: number } | null
  >;
  /** Counts current matches without auto-waiting. */
  count(): Promise<number>;
  /** Waits for the requested locator state. */
  waitFor(options?: {
    state?: 'visible' | 'hidden';
    timeout?: number;
  }): Promise<void>;
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
  /** Opens the configured app URL or relative route. */
  open(path?: string): Promise<void>;
  /** Recreates the execution context while preserving persisted state. */
  restart(): Promise<void>;
  /** Clears persisted client state and relaunches. */
  clearState(): Promise<void>;
  /** Navigates back once. */
  back(): Promise<void>;
  /** Opens an allowed deep or universal link. */
  deepLink(url: string): Promise<void>;
  /** Captures a redacted evidence screenshot. */
  screenshot(label?: string): Promise<string>;
}

export type RouteFulfillResponse = {
  status?: number;
  headers?: Record<string, string>;
} & (
  | { json: JsonValue; body?: never }
  | { body: string; json?: never }
  | { body?: never; json?: never }
);

export interface WebRoute {
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly postData?: string;
  };
  /** Fulfills the intercepted request once. */
  fulfill(response: RouteFulfillResponse): Promise<void>;
  /** Continues the intercepted request once. */
  continue(): Promise<void>;
  /** Aborts the intercepted request once. */
  abort(): Promise<void>;
}

export interface WebResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Parses the response body as JSON. */
  json<T = unknown>(): Promise<T>;
  /** Reads the response body as text. */
  text(): Promise<string>;
}

export interface CookieFields {
  name: string;
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export type Cookie = CookieFields & (
  | { url: string; domain?: never; path?: never }
  | { url?: never; domain: string; path?: string }
);

export interface Dialog {
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export interface Web {
  /** Navigates to an allowed URL. */
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<void>;
  /** Reloads the current document. */
  reload(options?: ActionOptions): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: ActionOptions): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: ActionOptions): Promise<void>;
  /** Returns the current URL. */
  url(): Promise<string>;
  /** Returns the current title. */
  title(): Promise<string>;
  /** Waits for the current URL to match. */
  waitForURL(
    url: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void>;
  /** Creates a web-only CSS or XPath locator. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside one iframe. */
  frameLocator(selector: string): Screen;
  /** Evaluates trusted test code in the page. */
  evaluate<T extends JsonValue>(
    fn: string | (() => T | Promise<T>),
  ): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
  /** Adds an attempt-scoped network route. */
  route(
    pattern: string | RegExp,
    handler: (route: WebRoute) => void | Promise<void>,
  ): Promise<void>;
  /** Removes matching attempt-scoped routes. */
  unroute(pattern: string | RegExp): Promise<void>;
  /** Waits for a matching response. */
  waitForResponse(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<WebResponse>;
  /** Returns cookies visible to the current context. */
  cookies(): Promise<Cookie[]>;
  /** Sets cookies after origin policy validation. */
  setCookies(cookies: readonly Cookie[]): Promise<void>;
  /** Sets the viewport size. */
  setViewport(size: { width: number; height: number }): Promise<void>;
  /** Registers an attempt-scoped dialog handler and returns an unsubscribe function. */
  onDialog(
    handler: 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>),
  ): Promise<() => Promise<void>>;
  /** Runs a trigger and waits for its download. */
  waitForDownload(
    trigger: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<{ path: string; suggestedFilename: string }>;
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
  readonly mouse: {
    /** Moves the pointer. */
    move(x: number, y: number): Promise<void>;
    /** Scrolls the pointer wheel. */
    wheel(deltaX: number, deltaY: number): Promise<void>;
    /** Presses the primary pointer button. */
    down(): Promise<void>;
    /** Releases the primary pointer button. */
    up(): Promise<void>;
  };
}

/** Reserved mobile surface. It is not part of the web-0.1 execution profile. */
export interface Device {
  readonly platform: 'ios' | 'android';
  /** Sends the device to its home screen. */
  home(): Promise<void>;
  /** Hides the software keyboard. */
  hideKeyboard(): Promise<void>;
  /** Opens a device URL. */
  openUrl(url: string): Promise<void>;
  /** Sets simulator location. */
  setLocation(options: { latitude: number; longitude: number }): Promise<void>;
  /** Sets one simulator permission. */
  setPermission(
    permission: 'camera' | 'location' | 'notifications' | 'contacts',
    state: 'allow' | 'deny' | 'unset',
  ): Promise<void>;
  /** Injects one simulator push notification. */
  pushNotification(payload: Record<string, unknown>): Promise<void>;
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
  readonly web: Web;
  readonly device: Device;
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
}

export interface DescribeOptions extends Omit<TestOptions, 'only'> {
  serial?: boolean;
}

export interface SetupOptions
  extends Omit<TestOptions, 'session' | 'only' | 'skip'> {
  /** Session names this setup test MUST save. */
  sessions: readonly string[];
}

export type TestFn = (fixtures: TestFixtures) => void | Promise<void>;
export type SetupFn = (fixtures: SetupFixtures) => void | Promise<void>;
export type TestHookFn = (fixtures: TestFixtures) => void | Promise<void>;
export type SuiteHookFn = (fixtures: SuiteFixtures) => void | Promise<void>;
export type SynchronousBody<Result> = Extract<
  Result,
  PromiseLike<unknown>
> extends never
  ? () => Result
  : never;

export interface TestCase {
  readonly [testCaseBrand]: true;
}

export interface TestAPI {
  /** Registers one test synchronously during module evaluation. */
  (title: string, fn: TestFn): TestCase;
  /** Registers one configured test synchronously during module evaluation. */
  (title: string, options: TestOptions, fn: TestFn): TestCase;
  /** Registers one skipped test. */
  skip(title: string, fn: TestFn): TestCase;
  /** Registers one focused local test. CI rejects focused tests. */
  only(title: string, fn: TestFn): TestCase;
  /** Registers one setup test with statically declared session outputs. */
  setup(title: string, options: SetupOptions, fn: SetupFn): TestCase;
  /** Declares a group synchronously. */
  describe<Result>(title: string, body: SynchronousBody<Result>): void;
  /** Declares a configured group synchronously. */
  describe<Result>(
    title: string,
    options: DescribeOptions,
    body: SynchronousBody<Result>,
  ): void;
  /** Registers a test-attempt setup hook. */
  beforeEach(fn: TestHookFn): void;
  /** Registers a test-attempt teardown hook. */
  afterEach(fn: TestHookFn): void;
  /** Registers a suite-instance setup hook. */
  beforeAll(fn: SuiteHookFn): void;
  /** Registers a suite-instance teardown hook. */
  afterAll(fn: SuiteHookFn): void;
}

export const test: TestAPI;

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
  /** Waits for exact normalized text. */
  toHaveText(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for contained normalized text. */
  toContainText(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for an input value. */
  toHaveValue(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for an exact match count. */
  toHaveCount(expected: number, options?: { timeout?: number }): Promise<void>;
  /** Waits for an accessible name. */
  toHaveAccessibleName(
    expected: TextMatch,
    options?: { timeout?: number },
  ): Promise<void>;
}

export interface WebExpectation {
  readonly not: WebExpectation;
  /** Waits for the current URL to match. */
  toHaveURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
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

/** Creates deterministic or async e2e expectations. */
export function expect(actual: Locator): AsyncExpectation;
export function expect(actual: Web): WebExpectation;
export function expect<T>(actual: T): ValueExpectation<T>;

export interface DriverManifest {
  readonly id: string;
  readonly version: string;
  readonly platforms: readonly Platform[];
  readonly spiVersion: 1;
  readonly capabilities: {
    readonly fixtures: readonly Capability[];
    readonly artifacts: readonly ('screenshot' | 'trace' | 'video')[];
    readonly state: boolean;
  };
}

export interface DriverHandle extends DriverManifest {
  readonly [driverHandleBrand]: true;
}

export interface CommandConfig {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  startupTimeout?: number;
  shutdownTimeout?: number;
}

export interface AppConfig {
  url?: string;
  command?: CommandConfig;
  readyUrl?: string;
  allowedOrigins?: readonly string[];
  environment?: 'test' | 'staging' | 'production';
  allowProduction?: boolean;
}

export interface WebTarget {
  name: string;
  platform: 'web';
  driver?: 'playwright' | DriverHandle;
  browser?: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
}

export interface MobileTarget {
  name: string;
  platform: 'ios' | 'android';
  driver: DriverHandle;
  app: string;
  device?: string;
  os?: string;
}

export interface CustomTarget {
  name: string;
  platform: Platform;
  driver: DriverHandle;
}

export type Target = WebTarget | MobileTarget | CustomTarget;

export interface ModelConfig {
  provider: string;
  id: string;
  endpoint?: string;
  /** Environment variable containing the provider credential. */
  apiKeyEnv?: string;
}

/**
 * A live AI SDK language model instance, e.g. `openai('gpt-4o')` from
 * `@ai-sdk/openai` or any other provider implementing the AI SDK
 * `LanguageModelV2+` specification. The instance owns its own transport and
 * credentials. Detection is structural, so any provider package works without
 * the runner depending on it.
 */
export interface ModelInstance {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
}

export interface E2EConfig {
  specVersion?: '0.1';
  projectId?: string;
  app?: AppConfig;
  targets?: readonly Target[];
  browser?: 'chromium' | 'firefox' | 'webkit';
  tests?: string | readonly string[];
  timeout?: number;
  launchTimeout?: number;
  actionTimeout?: number;
  assertionTimeout?: number;
  cleanupTimeout?: number;
  retries?: number;
  workers?: number;
  artifacts?: readonly ('trace' | 'screenshot' | 'video')[];
  reporters?: readonly ('list' | 'json' | 'html')[];
  screen?: {
    testIdAttribute?: string;
  };
  agent?: {
    /**
     * The step executor `agent.act()` dispatches to (RFC0001 layer 4).
     * Undefined selects the built-in AI SDK executor. Executors never cross a
     * process boundary: workers re-resolve the config module and construct
     * their own, exactly like model instances.
     */
    executor?: StepExecutor;
    model?: string | ModelConfig | ModelInstance;
    /** Model used by calls with `vision`; falls back to `model`. */
    visionModel?: string | ModelConfig | ModelInstance;
    maxSteps?: number;
    maxModelCalls?: number;
    maxObservationBytes?: number;
    cache?: 'off' | 'read-only' | 'read-write';
    context?: string;
    /** Project-wide default for the per-call `vision` option. */
    vision?: VisionMode;
  };
  limits?: {
    maxDiscoveredResults?: number;
    maxCacheBytes?: number;
    maxTerminalFieldBytes?: number;
    maxAgentContextBytes?: number;
    maxLedgerBytes?: number;
    maxArtifactBytes?: number;
    maxArtifactTotalBytes?: number;
    maxDownloadBytes?: number;
    maxDownloads?: number;
    maxReportBytes?: number;
    maxEventsPerStep?: number;
    maxModelTokensPerCall?: number;
    maxModelCallsPerStep?: number;
    maxActionStepsPerStep?: number;
    maxEstimatedCostUsd?: number;
  };
  credentials?: Readonly<
    Record<
      string,
      {
        username: string;
        password: string;
        allowedOrigins?: readonly string[];
      }
    >
  >;
}

/** Type-checks and returns an e2e configuration object. */
export function defineConfig(config: E2EConfig): E2EConfig;

/*
 * The step-executor socket (RFC0001, layer 4). The harness owns each
 * `agent.act()` step — observation, action dispatch, budgets, recording, and
 * verdict mapping — and delegates only the thinking to a pluggable executor.
 * The socket never requires the AI SDK: a hand-rolled executor is valid.
 */

/** One step handed to an executor: one `agent.act()` call. */
export interface ExecutorStep {
  readonly kind: 'act';
  readonly instruction: string;
  /** JSON-safe call parameters; secrets are rejected before dispatch. */
  readonly params: Readonly<Record<string, JsonValue>> | undefined;
}

/** Redacted, size-bounded observation an executor may show its model. */
export interface ExecutorObservation {
  readonly revision: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
}

/** A node named by its id from the newest observation. */
export interface ExecutorTarget {
  readonly id: string;
}

/**
 * The action grammar. Every executor action bottoms out here, where the
 * harness enforces the deadline, the action budget, origin policy, and
 * recording. Node ids are only valid against the newest observation.
 */
export interface ExecutorActions {
  tap(target: ExecutorTarget): Promise<void>;
  type(target: ExecutorTarget, value: string): Promise<void>;
  press(target: ExecutorTarget, key: string): Promise<void>;
  select(target: ExecutorTarget, value: string): Promise<void>;
  scroll(direction: ScrollDirection, target?: ExecutorTarget): Promise<void>;
  navigate(url: string): Promise<void>;
}

/** Usage detail of one executor-made model call, all fields optional. */
export interface ExecutorModelCall {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
  readonly provider?: string;
  readonly modelId?: string;
}

/** Step budgets, read and reported by the executor, enforced by the harness. */
export interface ExecutorBudgets {
  readonly maxActions: number;
  readonly maxModelCalls: number;
  actionsUsed(): number;
  remainingMs(): number;
  /**
   * Records one executor-made model call; usage feeds metrics and the report.
   * Throws STEP_BUDGET_EXHAUSTED past `maxModelCalls`: enforced, not advisory.
   */
  recordModelCall(usage?: ExecutorModelCall): void;
  /**
   * Records one executor tool call that did not go through `actions`. A
   * mutating tool consumes an action-budget slot and may throw
   * STEP_BUDGET_EXHAUSTED; every call is recorded as a step event.
   */
  recordToolCall(call: { name: string; mutates: boolean; durationMs?: number }): void;
}

export interface StepExecutorContext {
  readonly step: ExecutorStep;
  /**
   * Aborts when the test is cancelled, when the step deadline expires, or on
   * any other hard stop. The harness settles the step at the hard stop either
   * way; a late verdict from an executor that ignored the signal is never
   * trusted over it.
   */
  readonly signal: AbortSignal;
  /** The config-resolved AI SDK model, when one is configured. */
  readonly model: ModelInstance | undefined;
  /** Completed prior steps serialized for prompt context; `''` when none. */
  readonly ledger: string;
  readonly agentContext: string | undefined;
  readonly budgets: ExecutorBudgets;
  observe(): Promise<ExecutorObservation>;
  readonly actions: ExecutorActions;
}

export type StepVerdictStatus = 'passed' | 'failed' | 'blocked';

/**
 * The ternary step verdict. `failed` means the application did not behave as
 * the step required; `blocked` means the environment, credentials, or the
 * executor's own budget prevented a product verdict, and always carries a
 * blockable error code.
 */
export interface StepVerdict {
  readonly status: StepVerdictStatus;
  readonly summary: string;
  readonly errorCode?: AgentErrorCode;
}

/** The brain socket: one step in, one verdict out. */
export interface StepExecutor {
  readonly name: string;
  readonly version?: string;
  runStep(context: StepExecutorContext): Promise<StepVerdict>;
}

/** The closed set of codes a `blocked` verdict may carry (chapter 16). */
export const BLOCKABLE_CODES: ReadonlySet<AgentErrorCode>;
