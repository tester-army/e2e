/**
 * e2e — canonical public API surface.
 *
 * This file is the normative spec. No implementation exists yet.
 * When prose docs and this file disagree, this file wins.
 *
 * Root export: 'e2e'
 * Subpaths:    'e2e/cloud', 'e2e/driver'
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Shared utility types
// ---------------------------------------------------------------------------

/** Deep-partial matcher: literals, RegExp, or predicate per field. */
export type Match<T> = {
  [K in keyof T]?: T[K] extends object
    ? Match<T[K]> | ((value: T[K]) => boolean)
    : T[K] | RegExp | ((value: T[K]) => boolean);
};

/** Any Standard Schema (zod, valibot, arktype). */
export interface StandardSchema<T = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): { value: T } | { issues: unknown[] } | Promise<{ value: T } | { issues: unknown[] }>;
  };
}

// ---------------------------------------------------------------------------
// screen — deterministic cross-platform queries (see 08-platforms.md)
//
// A projection layer, not an automation engine: queries delegate to the
// target's backend automation (browser locators on web, accessibility
// queries on mobile). Zero model calls. Backends are an internal
// implementation detail of drivers — no backend object is exposed.
// ---------------------------------------------------------------------------

/** e2e-owned role vocabulary, matched literally, mapped per platform. */
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

/** Testing Library TextMatch. Trim + whitespace-collapse always applied. */
export type TextMatch = string | RegExp;

export interface TextMatchOptions {
  /** Full-string, case-sensitive match. Default: true. No effect with RegExp. */
  exact?: boolean;
}

/**
 * State options mirror the matcher vocabulary (toBeChecked ↔ { checked }).
 * Dual-source per platform (aria-* / accessibilityState.*), normalized.
 */
export interface RoleOptions extends TextMatchOptions {
  name?: TextMatch;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
}

/**
 * Query priority (Testing Library's): role > label > placeholder > text >
 * displayValue > testId (last resort). Also the agent's selector policy —
 * instant-action locations cache as these queries.
 */
export type Momentum = 'none' | 'slow' | 'fast';

export interface SwipeOptions {
  direction: ScrollDirection;
  momentum?: Momentum;
}

export interface Screen {
  getByRole(role: Role, options?: RoleOptions): Locator;
  getByLabel(text: TextMatch, options?: TextMatchOptions): Locator;
  getByPlaceholder(text: TextMatch, options?: TextMatchOptions): Locator;
  getByText(text: TextMatch, options?: TextMatchOptions): Locator;
  getByDisplayValue(value: TextMatch, options?: TextMatchOptions): Locator;
  /** Last resort. data-testid (web) / accessibilityIdentifier, RN testID (iOS) / resource-id (Android). */
  getByTestId(id: string): Locator;

  // Cross-platform gestures (Maestro heritage; touch/trackpad on web).
  swipe(options: SwipeOptions): Promise<void>;
  /** Scroll (in `direction`, default 'down') until the target is visible. */
  scrollUntilVisible(target: Locator, options?: { direction?: ScrollDirection; timeout?: number }): Promise<void>;
}

/**
 * Lazy, auto-retrying element handle (backend mechanics). Locators are also
 * scopes: chaining queries is Testing Library's within(). Actions on >1
 * match throw a descriptive ambiguity error (use first()/nth()/count()).
 * Absence is asserted, not queried: expect(locator).not.toBeVisible().
 */
export interface Locator extends Screen {
  // Actions — actionability-checked: acting on hidden/disabled/covered
  // elements fails with an actionable error, never a silent no-op.
  tap(options?: { timeout?: number }): Promise<void>;
  /** Alias of tap() for web muscle memory. */
  click(options?: { timeout?: number }): Promise<void>;
  doubleTap(options?: { timeout?: number }): Promise<void>;
  longPress(options?: { duration?: number }): Promise<void>;
  fill(value: string): Promise<void>;
  clear(): Promise<void>;
  press(key: string): Promise<void>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  /** Native <select> on web; picker on mobile. */
  selectOption(value: string | { label?: string; index?: number }): Promise<void>;
  focus(): Promise<void>;
  dragTo(target: Locator): Promise<void>;
  scrollIntoView(): Promise<void>;
  /** Swipe gesture scoped to this element. */
  swipe(options: SwipeOptions): Promise<void>;

  // Reads
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  isChecked(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  count(): Promise<number>;
  waitFor(options?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;

  // Refinement
  filter(options: { hasText?: TextMatch; has?: Locator }): Locator;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
}

// ---------------------------------------------------------------------------
// Platforms & targets (see 08-platforms.md)
// ---------------------------------------------------------------------------

export type Platform = 'web' | 'ios' | 'android';

export type Target =
  | {
      name?: string;
      platform: 'web';
      /** Automation backend: bundled id or driver package instance. Default: 'playwright'. */
      driver?: 'playwright' | 'agent-browser' | Driver;
      browser?: 'chromium' | 'firefox' | 'webkit';
      /** Overrides app.url for this target. */
      url?: string;
      viewport?: { width: number; height: number };
    }
  | {
      name?: string;
      platform: 'ios';
      /** Automation backend: bundled id or driver package instance. Default: 'agent-device'. */
      driver?: 'agent-device' | 'appium' | Driver;
      /** .app/.ipa path, or bundle id of an installed app. */
      app: string;
      /** Simulator/device name. Default: latest iPhone. */
      device?: string;
      os?: string;
    }
  | {
      name?: string;
      platform: 'android';
      /** Automation backend: bundled id or driver package instance. Default: 'agent-device'. */
      driver?: 'agent-device' | 'appium' | Driver;
      /** .apk path or applicationId. */
      app: string;
      device?: string;
      os?: string;
    };

/** Portable app handle — works on every platform. */
export interface App {
  /** Navigate to the target URL (web) or launch the app (mobile). */
  open(path?: string): Promise<void>;
  /**
   * Kill and relaunch (mobile) / fresh context + goto (web).
   * NOTE: does NOT clear persisted app data (keychain, storage, defaults) —
   * use clearState() for a factory-fresh app.
   */
  restart(): Promise<void>;
  /** Wipe persisted app data (web: cookies/storage; mobile: app data), then relaunch. */
  clearState(): Promise<void>;
  /** System back (Android hardware back / browser history back / iOS back gesture). */
  back(): Promise<void>;
  /** Open a deep link / universal link. */
  deepLink(url: string): Promise<void>;
  /** Evidence screenshot for the report, any platform. Returns artifact path. */
  screenshot(label?: string): Promise<string>;
}

/** Mobile system utils. Element interaction lives on `screen` or `agent`. */
export interface Device {
  readonly platform: 'ios' | 'android';

  home(): Promise<void>;
  hideKeyboard(): Promise<void>;
  openUrl(url: string): Promise<void>;
  setLocation(lat: number, lng: number): Promise<void>;
  setPermission(
    permission: 'camera' | 'location' | 'notifications' | 'contacts',
    state: 'allow' | 'deny',
  ): Promise<void>;

  /** Inject a push notification (simulator/emulator; managed devices in Cloud). */
  pushNotification(payload: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// web — web-only deterministic surface (e2e-owned, driver-projected)
//
// Playwright-parity capabilities with no mobile meaning. Still no backend
// object exposed: `web` is e2e's own interface, implemented by the target's
// web driver. Using it constrains the test to web (platforms: ['web']).
// ---------------------------------------------------------------------------

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface WebRoute {
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  fulfill(response: { status?: number; json?: unknown; body?: string; headers?: Record<string, string> }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

export interface WebResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface Web {
  // navigation
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void>;
  reload(): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  url(): string;
  title(): Promise<string>;
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;

  /** CSS/XPath escape hatch — web-only by nature; prefer screen.getBy*. */
  locator(selector: string): Locator;
  /** Scoped queries inside an iframe. */
  frameLocator(selector: string): Screen;

  evaluate<T>(fn: string | (() => T)): Promise<T>;

  // network
  route(pattern: string | RegExp, handler: (route: WebRoute) => void | Promise<void>): Promise<void>;
  unroute(pattern: string | RegExp): Promise<void>;
  waitForResponse(pattern: string | RegExp, options?: { timeout?: number }): Promise<WebResponse>;

  // browser state
  cookies(): Promise<Cookie[]>;
  setCookies(cookies: Cookie[]): Promise<void>;
  setViewport(size: { width: number; height: number }): Promise<void>;

  // events
  onDialog(handler: 'accept' | 'dismiss' | ((dialog: { message: string; accept(text?: string): Promise<void>; dismiss(): Promise<void> }) => void)): void;
  waitForDownload(trigger: () => Promise<void>): Promise<{ path: string; suggestedFilename: string }>;

  // raw input (web only — no cross-platform equivalent)
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
  mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// test()
// ---------------------------------------------------------------------------

export interface TestFixtures {
  /** AI agent bound to the current target (browser DOM or native a11y tree). */
  agent: Agent;
  /** Portable app handle: open/restart/deepLink/screenshot. */
  app: App;
  /** Deterministic cross-platform queries — zero AI. */
  screen: Screen;
  /** Current target platform, for branching. */
  platform: Platform;
  /** Save/restore app state (see 11-lifecycle.md). */
  session: Session;

  /** Web-only deterministic surface (navigation, css, network, dialogs) — web targets only. */
  web: Web;
  /** Mobile system utils (push, permissions, location) — mobile targets only. */
  device: Device;
}

export type TestFn = (fixtures: TestFixtures) => Promise<void>;

export interface TestOptions {
  /** Per-test timeout ms. Default: config.timeout (120_000). */
  timeout?: number;
  /** Per-test retries. Default: config.retries. */
  retries?: number;
  /** Tags for filtering (`e2e run --tag smoke`). */
  tags?: string[];
  /** Skip with optional reason. */
  skip?: boolean | string;
  /** Focus this test locally. */
  only?: boolean;
  /**
   * Platforms this test can run on. Default: all configured targets.
   * Required implicitly when using `device` (mobile) or platform-specific flows.
   */
  platforms?: Platform[];
  /** Start from a saved session; implies dependency on the setup test that saved it. */
  session?: string;
  /** Ambient agent context for this test, appended to config agent.context. */
  agentContext?: string;
}

/** Opaque test handle; exporting it registers the test. */
export interface TestCase {
  readonly title: string;
}

export interface TestFunction {
  (title: string, fn: TestFn): TestCase;
  (title: string, options: TestOptions, fn: TestFn): TestCase;

  skip(title: string, fn: TestFn): TestCase;
  only(title: string, fn: TestFn): TestCase;
  fixme(title: string, fn: TestFn): TestCase;

  /**
   * Setup test: runs first, once per run, produces shared state (sessions).
   * Tests using `session: name` depend on the setup test that saved it; if
   * it fails, dependents are skipped with the setup failure as cause.
   */
  setup(title: string, fn: TestFn): TestCase;

  /**
   * Parameterized tests. Cases must be statically known. `$key`
   * interpolation in titles. Each case is a separate result.
   */
  each<Case extends Record<string, unknown>>(
    cases: readonly Case[],
  ): {
    (title: string, fn: (fixtures: TestFixtures, testCase: Case) => Promise<void>): TestCase[];
    (title: string, options: TestOptions, fn: (fixtures: TestFixtures, testCase: Case) => Promise<void>): TestCase[];
  };

  /** Conditional skip; the condition source is used as the reason. */
  skipIf(condition: boolean | (() => boolean)): TestFunction;
  /** Expected failure under condition; an unexpected pass fails the test. */
  failsIf(condition: boolean | (() => boolean)): TestFunction;

  describe: {
    (title: string, fn: () => void): void;
    (title: string, options: GroupOptions, fn: () => void): void;
  };

  beforeEach(fn: (fixtures: TestFixtures) => Promise<void> | void): void;
  afterEach(fn: (fixtures: TestFixtures) => Promise<void> | void): void;
  beforeAll(fn: () => Promise<void> | void): void;
  afterAll(fn: () => Promise<void> | void): void;

  /**
   * Custom fixtures with setup/teardown (reserved, post-v0; see
   * 11-lifecycle.md). Fixtures are lazy, torn down in reverse order.
   */
  extend<Extra extends Record<string, unknown>>(fixtures: {
    [K in keyof Extra]: (
      fixtures: TestFixtures,
      use: (value: Extra[K]) => Promise<void>,
    ) => Promise<void>;
  }): TestFunction;
}

/** Options applying to every test in a group; test-level options override. */
export interface GroupOptions {
  tags?: string[];
  session?: string;
  platforms?: Platform[];
  timeout?: number;
  retries?: number;
  /** Ordered, one worker, shared state; a failure skips the rest. */
  serial?: boolean;
  /** Ambient agent context for every test in the group. */
  agentContext?: string;
}

/** Saved app state: cookies/localStorage/IndexedDB on web, app data on mobile. */
export interface Session {
  save(name: string): Promise<void>;
  restore(name: string): Promise<void>;
}

export declare const test: TestFunction;

/**
 * Group calls into a named report step (see 10-determinism.md). Ungrouped
 * agent/service-matcher calls become implicit steps automatically.
 */
export declare function step<T>(title: string, fn: () => Promise<T>): Promise<T>;

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

/**
 * Structured values the agent may use verbatim (never invented).
 * Credential values are filled host-side by reference — raw secrets never
 * enter model context. FileRef values scope which files the agent may use.
 */
export type AgentParamValue =
  | string
  | number
  | boolean
  | Credential
  | FileRef
  | FileRef[];

export type AgentParams = Record<string, AgentParamValue>;

export interface AgentOptions {
  /** Max ms for the whole action. Default: 60_000. */
  timeout?: number;
  /**
   * Action budget. On exhaustion the step is forced to conclude with
   * AgentError.code = 'STEP_BUDGET_EXHAUSTED'. Observation-only actions
   * don't count. Default: config.agent.maxSteps (25).
   */
  maxSteps?: number;
  /** Use/record the cached action path (see 10-determinism.md). Default: config.agent.cache. */
  cache?: boolean;
}

export interface AgentStep {
  action: string;         // human-readable, e.g. 'click "Sign up" button'
  screenshot?: string;    // artifact path
  startedAt: Date;
  durationMs: number;
}

export interface AgentResult<T = Record<string, unknown>> {
  ok: true;
  steps: AgentStep[];
  /** Typed when a schema is passed to act(); see AgentOptions.schema. */
  data?: T;
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface InstantActionOptions {
  timeout?: number;
  /** Use/record the cached location for this target. Default: config.agent.cache. */
  cache?: boolean;
}

export interface Agent {
  /**
   * Planning tier: the agent plans and executes a multi-step flow toward
   * the described goal. Use when you know the goal, not the steps.
   */
  act(instruction: string, params?: AgentParams, options?: AgentOptions): Promise<AgentResult>;
  /** With a schema, extracted values in result.data are validated and typed. */
  act<T>(instruction: string, params: AgentParams | undefined, options: AgentOptions & { schema: StandardSchema<T> }): Promise<AgentResult<T>>;

  // Instant actions: AI locates the described element (one model call);
  // the action itself is deterministic — no planning loop, no alternate
  // paths, no self-healing detours. Targets are natural language, never
  // selectors, so instant actions are cross-platform. Locations are cached
  // by target description; replays skip the model entirely.

  tap(target: string, options?: InstantActionOptions): Promise<void>;
  /** Alias of tap() for web muscle memory. */
  click(target: string, options?: InstantActionOptions): Promise<void>;
  /** Value may be a Credential — filled host-side, never in model context. */
  type(target: string, value: string | Credential, options?: InstantActionOptions & { submit?: boolean; clear?: boolean }): Promise<void>;
  scroll(options: InstantActionOptions & { direction: ScrollDirection; momentum?: Momentum; within?: string }): Promise<void>;
  /** Scroll until the described element is visible ("the 20th item"). */
  scrollTo(target: string, options?: InstantActionOptions & { direction?: ScrollDirection }): Promise<void>;
  longPress(target: string, options?: InstantActionOptions & { duration?: number }): Promise<void>;
  /** Poll a natural-language condition until true or timeout. */
  waitFor(condition: string, options?: { timeout?: number; interval?: number }): Promise<void>;

  /**
   * Natural-language assertion judged against the current screen.
   * Rejects with AssertionError (agent reasoning + screenshot) on failure.
   */
  assert(assertion: string, options?: { timeout?: number; screenshot?: boolean; soft?: boolean }): Promise<void>;

  /**
   * Authenticate, whatever the login UI looks like. The credential is pinned
   * for the step and filled host-side by reference. `{ temporaryEmail: true }`
   * signs up fresh via a temporary inbox (OTP/magic links handled).
   */
  login(user: Credential | { temporaryEmail: true }, options?: AgentOptions): Promise<AgentResult>;

  /** Extract structured data from the current page. */
  extract<T>(instruction: string, options: { schema: StandardSchema<T>; timeout?: number }): Promise<T>;
}

/**
 * Machine-actionable failure taxonomy (see 10-determinism.md). Setup errors
 * are reported as infrastructure, never as product failures.
 */
export type AgentErrorCode =
  // setup — your config, not your app
  | 'AUTH_CREDENTIAL_UNAVAILABLE'
  | 'AUTH_CREDENTIAL_INVALID'
  | 'APP_UNREACHABLE'
  // runtime — the agent could not conclude
  | 'STEP_BUDGET_EXHAUSTED'
  | 'STEP_TIMEOUT'
  | 'STEP_NO_CONCLUSION'
  // product — the app is broken
  | 'ASSERTION_FAILED';

/** Thrown when an agent action fails; carries evidence for the report. */
export declare class AgentError extends Error {
  code: AgentErrorCode;
  steps: AgentStep[];
  /** The agent's own explanation of what went wrong. */
  explanation: string;
  screenshot?: string;
}

// ---------------------------------------------------------------------------
// expect()
// ---------------------------------------------------------------------------

export interface EventualMatcherOptions {
  /** Poll deadline ms. Default: 15_000. */
  timeout?: number;
}

export interface InboxExpectations {
  toHaveEmail(match: Match<Email>, options?: EventualMatcherOptions): Promise<void>;
  not: InboxExpectations;
}

export interface WebhookCaptureExpectations {
  toHaveReceived(match: Match<{ headers: Record<string, string>; payload: unknown }>, options?: EventualMatcherOptions): Promise<void>;
  not: WebhookCaptureExpectations;
}

/**
 * Locator matchers mirror getByRole state options — one semantic model for
 * querying and asserting, normalized per platform. Paired positives avoid
 * double negations. Implementation-surface matchers (toHaveClass/Attribute/
 * Style) deliberately absent — they don't exist off-web.
 */
export interface LocatorExpectations {
  toBeVisible(options?: EventualMatcherOptions): Promise<void>;
  toBeHidden(options?: EventualMatcherOptions): Promise<void>;
  toBeEnabled(options?: EventualMatcherOptions): Promise<void>;
  toBeDisabled(options?: EventualMatcherOptions): Promise<void>;
  toBeChecked(options?: EventualMatcherOptions): Promise<void>;
  toBeSelected(options?: EventualMatcherOptions): Promise<void>;
  toBeExpanded(options?: EventualMatcherOptions): Promise<void>;
  toHaveText(text: TextMatch, options?: TextMatchOptions & EventualMatcherOptions): Promise<void>;
  toContainText(text: TextMatch, options?: EventualMatcherOptions): Promise<void>;
  toHaveValue(value: TextMatch, options?: EventualMatcherOptions): Promise<void>;
  toHaveCount(count: number, options?: EventualMatcherOptions): Promise<void>;
  toHaveAccessibleName(name: TextMatch, options?: EventualMatcherOptions): Promise<void>;
  not: LocatorExpectations;
}

export interface WebExpectations {
  toHaveURL(url: string | RegExp, options?: EventualMatcherOptions): Promise<void>;
  toHaveTitle(title: TextMatch, options?: EventualMatcherOptions): Promise<void>;
  not: WebExpectations;
}

export interface ExpectFunction {
  (subject: Locator): LocatorExpectations;
  (subject: Web): WebExpectations;
  (subject: Inbox): InboxExpectations;
  (subject: WebhookCapture): WebhookCaptureExpectations;
  <T>(subject: T): any; // generic value assertions (toBe, toEqual, …)

  // Natural-language assertions live on the agent: agent.assert('…').

  /** Soft variant: records failure, continues the test. */
  soft: ExpectFunction;
}

export declare const expect: ExpectFunction;

// ---------------------------------------------------------------------------
// Resources: email
// ---------------------------------------------------------------------------

export interface Email {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  links: string[];
  receivedAt: Date;
}

export interface EmailWaitOptions {
  from?: string | RegExp;
  subject?: string | RegExp;
  /** Default: 60_000. */
  timeout?: number;
}

export interface Inbox {
  /** Unique receiving address for this test run. */
  readonly address: string;

  /** Wait for and extract a verification code. */
  code(options?: EmailWaitOptions): Promise<string>;

  /** Wait for and extract the primary action link. */
  link(options?: EmailWaitOptions & { text?: string | RegExp }): Promise<string>;

  /** Wait for a full email. */
  email(options?: EmailWaitOptions): Promise<Email>;

  /** All emails received so far (no waiting). */
  emails(): Promise<Email[]>;
}

export interface EmailResource {
  /** Create a fresh, isolated inbox. Label is for readability/artifacts. */
  inbox(label?: string): Inbox;
}

export declare const email: EmailResource;

// ---------------------------------------------------------------------------
// Resources: credentials
// ---------------------------------------------------------------------------

export interface Credential {
  readonly name: string;
  readonly username: string;
  /** Secrets are write-only by default; reveal() requires config opt-in. */
  reveal(): Promise<{ username: string; password: string }>;
}

export interface CredentialsResource {
  /** Resolve a named credential (env → config → local store → cloud vault). */
  user(name: string): Credential;
}

export declare const credentials: CredentialsResource;

// ---------------------------------------------------------------------------
// Resources: webhook
// ---------------------------------------------------------------------------

export interface WebhookDelivery {
  headers: Record<string, string>;
  body: unknown;
  receivedAt: Date;
}

export interface WebhookCapture {
  /** URL to point the app (or emulated service) at. */
  readonly url: string;
  waitFor(match?: Match<{ body: unknown }>, options?: { timeout?: number }): Promise<WebhookDelivery>;
  deliveries(): Promise<WebhookDelivery[]>;
}

export interface WebhookResource {
  capture(label?: string): WebhookCapture;
}

export declare const webhook: WebhookResource;

// ---------------------------------------------------------------------------
// Resources: files
// ---------------------------------------------------------------------------

/** File fixture handle; the agent may only use files explicitly given to a step. */
export interface FileRef {
  /**
   * Optional description the agent can use when deciding how/where to use
   * the file ("signed NDA, PDF, 2 pages"). Set manually via files.from()
   * options or generated by files.index().
   */
  readonly context?: string;
  readonly name: string;
  readonly mimeType: string;
}

export interface FilesResource {
  from(path: string, options?: { name?: string; mimeType?: string; context?: string }): FileRef;
  /**
   * Agent-generated context for all registered files (content summary,
   * type, purpose). Optional; improves agent file handling. Results are
   * cached alongside the agent cache.
   */
  index(): Promise<void>;
}

export declare const files: FilesResource;

// ---------------------------------------------------------------------------
// Resources: phone (Cloud-first; reserved shape, not shipped in v0 OSS)
// ---------------------------------------------------------------------------

export interface Sms {
  from: string;
  to: string;
  text: string;
  receivedAt: Date;
}

export interface PhoneNumber {
  /** E.164 string. */
  readonly address: string;
  sms(options?: { from?: string | RegExp; timeout?: number }): Promise<Sms>;
  code(options?: { from?: string | RegExp; timeout?: number }): Promise<string>;
}

export interface PhoneResource {
  number(label?: string): PhoneNumber;
}

export declare const phone: PhoneResource;


// ---------------------------------------------------------------------------
// defineConfig()
// ---------------------------------------------------------------------------

export interface E2EConfig {
  app?: {
    url?: string;
    /** Command to boot the app before tests. */
    command?: string;
    /** URL to poll for readiness. Defaults to app.url. */
    readyUrl?: string;
  };

  /** Default: 'local'. */
  runner?: 'local' | 'cloud';
  /**
   * Cross-platform targets. Default: one implicit web target using app.url.
   * Each test runs once per matching target.
   */
  targets?: Target[];
  /** Browser for the implicit web target. Default: 'chromium'. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Default: 'tests/**\/*.e2e.ts'. */
  tests?: string | string[];
  /** Run once before/after everything (see 11-lifecycle.md). */
  globalSetup?: string;
  globalTeardown?: string;
  /** Default: 120_000. */
  timeout?: number;
  /** Default: 0 locally, 1 in CI. */
  retries?: number;
  workers?: number;
  artifacts?: Array<'trace' | 'screenshot' | 'video' | 'har'>;

  screen?: {
    /** Web attribute for getByTestId. Default: 'data-testid'. */
    testIdAttribute?: string;
  };

  agent?: {
    model?: string;
    /** Default: 25. */
    maxSteps?: number;
    /** Agent path caching (see 10-determinism.md). Default: true. */
    cache?: boolean;
    /**
     * Ambient context prepended to every agent invocation (see
     * 10-determinism.md): app quirks, terminology, standing instructions.
     */
    context?: string;
  };

  credentials?: Record<string, { username: string; password: string }>;

  resources?: {
    email?: 'local' | 'managed';
    phone?: 'managed';
  };

  /** Cloud (runner: 'cloud'). */
  project?: string;
  token?: string;
}

export declare function defineConfig(config: E2EConfig): E2EConfig;

// ---------------------------------------------------------------------------
// 'e2e/cloud' subpath
// ---------------------------------------------------------------------------

export interface CloudRun {
  id: string;
  project: string;
  status: 'queued' | 'running' | 'passed' | 'failed';
  url: string; // hosted replay
  startedAt: Date;
  finishedAt?: Date;
}

export interface CloudApi {
  runs: {
    get(id: string): Promise<CloudRun>;
    list(options?: { project?: string; limit?: number }): Promise<CloudRun[]>;
  };
}

export declare const cloud: CloudApi;

// ---------------------------------------------------------------------------
// 'e2e/driver' subpath — the driver SPI (public, versioned)
//
// Drivers are npm packages exporting a factory built with defineDriver().
// Small on purpose: a driver maps queries, observes, acts, and produces
// artifacts. Caching, budgets, the step ledger, reporting, and retries are
// runner-side — identical across drivers.
// ---------------------------------------------------------------------------

/** A node in the semantic tree. `ref` is stable within one screen state. */
export interface SemanticNode {
  /** Opaque, driver-issued reference — the currency between queries, agent actions, and the locate cache. */
  ref: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  states?: Partial<Record<'checked' | 'disabled' | 'selected' | 'expanded' | 'focused' | 'hidden', boolean>>;
  rect?: { x: number; y: number; width: number; height: number };
  children?: SemanticNode[];
}

/** e2e query, normalized — what the runner hands a driver to resolve. */
export interface ResolvedQuery {
  kind: 'role' | 'label' | 'placeholder' | 'text' | 'displayValue' | 'testId';
  value: string | RegExp;
  options?: RoleOptions & TextMatchOptions;
  /** Scope chain (within): resolve relative to this node. */
  within?: string; // parent ref
}

export interface DriverContext {
  target: Target;
  artifactsDir: string;
}

export interface DriverSession {
  /** Portable app handle backing the `app` fixture. */
  app: {
    open(path?: string): Promise<void>;
    restart(): Promise<void>;
    deepLink(url: string): Promise<void>;
    /** Returns artifact path. */
    screenshot(label?: string): Promise<string>;
  };

  /** Query projection backing `screen` — backend waiting/actionability used as-is. */
  screen: {
    /** Resolve a query to matching node refs (no waiting; the runner drives retry). */
    resolve(query: ResolvedQuery): Promise<string[]>;
    /** Perform a locator action on a resolved node, with backend actionability checks. */
    perform(ref: string, action:
      | { kind: 'tap' | 'longPress' | 'scrollIntoView' | 'check' }
      | { kind: 'fill'; value: string }
      | { kind: 'press'; key: string },
    ): Promise<void>;
    /** Read state for matchers (visible/checked/text/…). */
    read(ref: string): Promise<SemanticNode>;
  };

  /** Observation backing the agent — same contract on every backend. */
  observe: {
    screenshot(): Promise<string>;
    semanticTree(): Promise<SemanticNode>;
  };

  /** Primitive actions the agent performs (by node ref or coordinate). */
  act: {
    tap(target: { ref: string } | { x: number; y: number }): Promise<void>;
    type(target: { ref: string }, text: string): Promise<void>;
    scroll(direction: ScrollDirection, target?: { ref: string }): Promise<void>;
    press(key: string): Promise<void>;
  };

  /** Mobile system utils backing `device`; omit on web drivers. */
  device?: {
    home(): Promise<void>;
    openUrl(url: string): Promise<void>;
    setLocation(lat: number, lng: number): Promise<void>;
    setPermission(permission: string, state: 'allow' | 'deny'): Promise<void>;
    pushNotification(payload: Record<string, unknown>): Promise<void>;
  };

  close(): Promise<void>;
}

export interface Driver {
  readonly id: string;
  readonly platforms: Platform[];
  /** SPI compatibility version. Current: 1. */
  readonly spiVersion: 1;
  launch(ctx: DriverContext): Promise<DriverSession>;
}

/** Identity helper with type checking — the way driver packages are built. */
export declare function defineDriver(driver: Driver): Driver;

/**
 * Reusable conformance suite; driver packages run it in their own CI:
 * `verifyDriver(hyperdrive())` registers tests asserting SPI behavior.
 */
export declare function verifyDriver(driver: Driver): void;
