/** Synchronous registration during module evaluation. */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCaseBrand } from '../internal/brands.ts';
import { describeValue } from '../config/validate.ts';
import { CollectionError } from '../internal/errors.ts';
import { validateTitle } from '../internal/ids.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import { parseSkipCall, skipRunningTest } from '../internal/skip.ts';
import { runTestStep } from '../internal/test-step.ts';
import type {
  DescribeOptions,
  FixtureFn,
  SetupFn,
  SetupOptions,
  SuiteHookFn,
  TestAPI,
  TestCase,
  TestFn,
  TestHookFn,
  TestOptions,
} from '../types.ts';

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface GroupNode {
  readonly title: string;
  readonly options: DescribeOptions;
  readonly parent: GroupNode | undefined;
  readonly serial: boolean;
}

export type TestMode = 'normal' | 'skip' | 'only';

/** One fixture a `test.extend()` call defined: its name and its setup/teardown function. */
export interface FixtureDefinition {
  readonly name: string;
  readonly fn: FixtureFn<object, unknown>;
}

export interface RegisteredTest {
  readonly kind: 'test' | 'setup';
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly declarationIndex: number;
  readonly options: TestOptions;
  readonly sessions: readonly string[];
  /** The tags the test declares: its describe chain's, outermost first, then its own, each once. */
  readonly tags: readonly string[];
  readonly fn: TestFn | SetupFn;
  /** The `test.extend()` chain the test was registered through, outermost definition first. */
  readonly fixtures: readonly FixtureDefinition[];
  readonly group: GroupNode | undefined;
  readonly mode: TestMode;
  readonly source: SourceLocation | undefined;
}

interface HookBase {
  readonly group: GroupNode | undefined;
  readonly declarationIndex: number;
}

/**
 * A per-test hook: runs with the attempt's fixtures. The chain it was
 * registered through is recorded; at run time the hook receives the test's
 * fixture object, which the test's own chain shapes.
 */
export interface TestHook extends HookBase {
  readonly kind: 'beforeEach' | 'afterEach';
  readonly fn: TestHookFn;
  readonly fixtures: readonly FixtureDefinition[];
}

/** A suite hook: runs once per scope instance with suite fixtures only. */
export interface SuiteHook extends HookBase {
  readonly kind: 'beforeAll' | 'afterAll';
  readonly fn: SuiteHookFn;
}

export type RegisteredHook = TestHook | SuiteHook;
type HookDeclaration = Pick<TestHook, 'kind' | 'fn' | 'fixtures'> | Pick<SuiteHook, 'kind' | 'fn'>;

export interface ModuleRegistration {
  readonly tests: readonly RegisteredTest[];
  readonly hooks: readonly RegisteredHook[];
}

const SESSION_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

class Collector {
  readonly tests: RegisteredTest[] = [];
  readonly hooks: RegisteredHook[] = [];
  private currentGroup: GroupNode | undefined = undefined;
  private declarationCounter = 0;
  private closed = false;
  /** Real path of the module being collected, the file a test's source prefers. */
  private readonly moduleFile: string | undefined;

  constructor(moduleFile: string | undefined) {
    this.moduleFile = moduleFile === undefined ? undefined : realPath(moduleFile);
  }

  close(): ModuleRegistration {
    this.closed = true;
    return { tests: this.tests, hooks: this.hooks };
  }

  private assertOpen(api: string): void {
    if (this.closed) {
      throw new CollectionError(
        `${api} was called after module evaluation finished; registration must be synchronous`,
      );
    }
  }

  registerTest(
    kind: 'test' | 'setup',
    mode: TestMode,
    title: string,
    options: TestOptions,
    sessions: readonly string[],
    fn: TestFn | SetupFn,
    fixtures: readonly FixtureDefinition[],
  ): TestCase {
    this.assertOpen(kind === 'setup' ? 'test.setup()' : 'test()');
    const titleError = validateTitle(title);
    if (titleError !== null) throw new CollectionError(titleError);
    const normalizedTitle = title.normalize('NFC');
    if (typeof fn !== 'function') throw new CollectionError('test body must be a function');
    if (kind === 'setup') {
      if (this.currentGroup !== undefined) {
        throw new CollectionError('setup tests must be top-level; they cannot appear in describe');
      }
      if (sessions.length === 0) {
        throw new CollectionError('setup tests must declare at least one session');
      }
      if (Array.isArray(options.agent)) {
        throw new CollectionError(
          'a setup test runs once per target and pins at most one agent; agent must be a single name',
        );
      }
      for (const name of sessions) {
        if (!SESSION_NAME_PATTERN.test(name)) {
          throw new CollectionError(
            `invalid session name ${JSON.stringify(name)}: names are 1 through 128 ASCII letters, numbers, "_", "-", or "."`,
          );
        }
      }
      if (new Set(sessions).size !== sessions.length) {
        throw new CollectionError('duplicate session names in one setup declaration');
      }
    }
    validateTestOptions(options, this.currentGroup);
    const titlePath = [...groupTitles(this.currentGroup), normalizedTitle];
    const registered: RegisteredTest = {
      kind,
      title: normalizedTitle,
      titlePath,
      declarationIndex: this.declarationCounter,
      options,
      sessions,
      tags: declaredTags(this.currentGroup, options),
      fn,
      fixtures,
      group: this.currentGroup,
      mode,
      source: captureSource(this.moduleFile),
    };
    this.declarationCounter += 1;
    this.tests.push(registered);
    return Object.freeze({ [testCaseBrand]: true as const });
  }

  registerDescribe(title: string, options: DescribeOptions, body: () => unknown): void {
    this.assertOpen('test.describe()');
    const titleError = validateTitle(title);
    if (titleError !== null) throw new CollectionError(titleError);
    if (typeof body !== 'function') throw new CollectionError('describe body must be a function');
    validateDescribeOptions(options, this.currentGroup);
    const group: GroupNode = {
      title: title.normalize('NFC'),
      options,
      parent: this.currentGroup,
      serial: options.serial === true,
    };
    const previous = this.currentGroup;
    this.currentGroup = group;
    try {
      const result = body();
      if (isPromiseLike(result)) {
        throw new CollectionError(
          `describe body for ${JSON.stringify(title)} must finish synchronously`,
        );
      }
    } finally {
      this.currentGroup = previous;
    }
  }

  registerHook(hook: HookDeclaration): void {
    this.assertOpen(`test.${hook.kind}()`);
    if (typeof hook.fn !== 'function') {
      throw new CollectionError(`${hook.kind} hook must be a function`);
    }
    this.hooks.push({
      ...hook,
      group: this.currentGroup,
      declarationIndex: this.declarationCounter,
    });
    this.declarationCounter += 1;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Canonical group-tree walk: the enclosing groups of a node, outermost first. */
export function groupChain(group: GroupNode | undefined): GroupNode[] {
  const chain: GroupNode[] = [];
  for (let node = group; node !== undefined; node = node.parent) {
    chain.unshift(node);
  }
  return chain;
}

/** Group titles along the chain, outermost first. */
export function groupTitles(group: GroupNode | undefined): string[] {
  return groupChain(group).map((node) => node.title);
}

/** The tags along the describe chain and the test's own, outermost first, each once. */
function declaredTags(group: GroupNode | undefined, options: TestOptions): string[] {
  const layers = [...groupChain(group).map((node) => node.options), options];
  return [...new Set(layers.flatMap((layer) => layer.tags ?? []))];
}

/** Finds the outermost serial group enclosing a node, if any. */
export function outermostSerialGroup(group: GroupNode | undefined): GroupNode | undefined {
  return groupChain(group).find((node) => node.serial);
}

function validateCommonOptions(options: TestOptions | DescribeOptions, label: string): void {
  if (options.timeout !== undefined) {
    if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0) {
      throw new CollectionError(`${label}: timeout must be a positive safe integer`);
    }
  }
  if (options.retries !== undefined) {
    if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 10) {
      throw new CollectionError(`${label}: retries must be an integer from 0 through 10`);
    }
  }
  if (options.agent !== undefined) validateAgentOption(options.agent, label);
  if (options.tags !== undefined) validateTagsOption(options.tags, label);
}

/**
 * `tags` lists distinct tag names, checked here beside `timeout`, `retries`,
 * and `agent`. Unchecked, the mistake is silent: a bare string is iterable,
 * so `tags: 'smoke'` would register the tags `s`, `m`, `o`, `k`, `e` and
 * `--tag smoke` would never select the test.
 */
function validateTagsOption(tags: unknown, label: string): void {
  if (!Array.isArray(tags)) {
    throw new CollectionError(
      `${label}: tags must be a list of tag names, e.g. tags: ['smoke'], got ${describeValue(tags)}`,
    );
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!isTagName(tag)) {
      throw new CollectionError(
        `${label}: every tag must be a non-blank string with no comma and no leading or trailing whitespace, got ${describeValue(tag)}`,
      );
    }
    if (seen.has(tag)) throw new CollectionError(`${label}: tags lists ${JSON.stringify(tag)} twice`);
    seen.add(tag);
  }
}

/**
 * A tag name is whatever `--tag` can spell back: the flag splits its values
 * on commas and trims them, so a name holds no comma and no leading or
 * trailing whitespace. Inner spaces are fine (`'Login Form'`, quoted).
 */
function isTagName(tag: unknown): tag is string {
  return typeof tag === 'string' && tag !== '' && tag.trim() === tag && !tag.includes(',');
}

/** `agent` names one configured agent, or lists several distinct ones to run the test once each. */
function validateAgentOption(agent: unknown, label: string): void {
  if (typeof agent === 'string') {
    if (agent === '') throw new CollectionError(`${label}: agent must be the name of a configured agent`);
    return;
  }
  if (!Array.isArray(agent) || agent.length === 0) {
    throw new CollectionError(
      `${label}: agent must be the name of a configured agent, or a non-empty list of names`,
    );
  }
  for (const name of agent) {
    if (typeof name !== 'string' || name === '') {
      throw new CollectionError(`${label}: every entry of agent must be the name of a configured agent`);
    }
  }
  if (new Set(agent).size !== agent.length) {
    throw new CollectionError(`${label}: agent lists each name once`);
  }
}

function insideSerial(group: GroupNode | undefined): boolean {
  return outermostSerialGroup(group) !== undefined;
}

function validateTestOptions(options: TestOptions, group: GroupNode | undefined): void {
  validateCommonOptions(options, 'test options');
  if (insideSerial(group)) {
    const forbidden: (keyof TestOptions)[] = [
      'retries',
      'session',
      'platforms',
      'requires',
      'skip',
      'only',
    ];
    for (const key of forbidden) {
      if (options[key] !== undefined) {
        throw new CollectionError(
          `test option "${key}" cannot be overridden inside a serial group; it belongs to the unit`,
        );
      }
    }
  }
}

function validateDescribeOptions(options: DescribeOptions, parent: GroupNode | undefined): void {
  validateCommonOptions(options, 'describe options');
  if (options.serial === true && insideSerial(parent)) {
    throw new CollectionError('nested serial groups are collection errors');
  }
}

/**
 * The active collector lives on globalThis because test modules load in an
 * isolated module realm (tsx) and must reach the runner's collector instance.
 */
const collectorSlot = realmSlot<Collector>('e2e.activeCollector.v1');

/**
 * Runs `load` with a fresh collector active and returns everything it
 * registered. `moduleFile` is the absolute path of the module `load` imports;
 * a test's source prefers a frame in that file.
 */
export async function collectModule(
  load: () => Promise<unknown>,
  moduleFile?: string,
): Promise<ModuleRegistration> {
  if (collectorSlot.get(globalThis) !== undefined) {
    throw new CollectionError('collection is already in progress');
  }
  const collector = new Collector(moduleFile);
  collectorSlot.set(globalThis, collector);
  try {
    await load();
  } finally {
    collectorSlot.delete(globalThis);
  }
  return collector.close();
}

function requireCollector(api: string): Collector {
  const collector = collectorSlot.get(globalThis);
  if (collector === undefined) {
    throw new CollectionError(
      `${api} can only be called while a test module is being collected by the e2e runner`,
    );
  }
  return collector;
}

const PACKAGE_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
/**
 * The runner's own source roots, whose frames are never a test's location.
 * `dist/` is where the published module runs; `src/` is where tsx's source maps
 * relocate those very frames (and where the module runs in this repository).
 */
const RUNNER_ROOTS = ['src', 'dist'].map((dir) => `${path.join(PACKAGE_ROOT, dir)}${path.sep}`);
/** `at name (file:line:column)` or `at file:line:column`, with or without a `file://` scheme. */
const STACK_FRAME = /\(?(?:file:\/\/)?([^()\s]+?):(\d+):(\d+)\)?$/;
const NODE_MODULES_SEGMENT = /[\\/]node_modules[\\/]/;

/** The path with symlinks resolved, or the path itself when it cannot be resolved. */
function realPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/**
 * Where a test was declared, read off the stack of its `test()` call. The
 * innermost frame in the module being collected wins, so a test declared
 * through a project helper (`dashboardTest()` in `support/test.ts`) points at
 * the helper's call in the test file. When no frame is in that module (the
 * file imports a module that declares the tests), the innermost frame outside
 * the runner and outside `node_modules` stands. The runner's own frames,
 * whether source maps relocate them to `src/` or not, and an installed
 * package's frames are never a test's location.
 */
function captureSource(moduleFile: string | undefined): SourceLocation | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  let outsideModule: SourceLocation | undefined;
  for (const line of stack.split('\n').slice(1)) {
    const match = STACK_FRAME.exec(line.trim());
    if (match === null) continue;
    // The loader imports every module with a cache-busting query, which is not part of the file.
    const file = decodeURIComponent(match[1]!).replace(/[?#].*$/, '');
    if (RUNNER_ROOTS.some((root) => file.startsWith(root)) || file.startsWith('node:')) continue;
    const location = { file, line: Number(match[2]), column: Number(match[3]) };
    if (moduleFile !== undefined && (file === moduleFile || realPath(file) === moduleFile)) {
      return location;
    }
    if (outsideModule === undefined && !NODE_MODULES_SEGMENT.test(file)) outsideModule = location;
  }
  return outsideModule;
}

function normalizeArgs(
  optionsOrFn: TestOptions | TestFn,
  maybeFn: TestFn | undefined,
): { options: TestOptions; fn: TestFn } {
  if (typeof optionsOrFn === 'function') {
    return { options: {}, fn: optionsOrFn };
  }
  if (maybeFn === undefined) throw new CollectionError('test body function is required');
  return { options: optionsOrFn, fn: maybeFn };
}

/** Fixtures every attempt has without any engine or `test.extend()` defining them. */
const CORE_FIXTURE_NAMES: ReadonlySet<string> = new Set(['agent', 'app', 'screen', 'platform', 'session']);

/**
 * Checks one `test.extend()` argument against the chain it extends. Names
 * are validated here, at import time, so a typo or a clash fails the file
 * before any attempt runs; the engine's own fixtures are only known per
 * target and are checked when the attempt builds its fixtures.
 */
function validateFixtureDefinitions(
  definitions: unknown,
  chain: readonly FixtureDefinition[],
): FixtureDefinition[] {
  if (
    typeof definitions !== 'object' ||
    definitions === null ||
    Array.isArray(definitions) ||
    (Object.getPrototypeOf(definitions) !== Object.prototype &&
      Object.getPrototypeOf(definitions) !== null)
  ) {
    throw new CollectionError(
      'test.extend() takes a plain object of fixture definitions, one function per fixture name',
    );
  }
  const taken = new Set(chain.map((definition) => definition.name));
  const added: FixtureDefinition[] = [];
  for (const [name, fn] of Object.entries(definitions)) {
    if (name === '') throw new CollectionError('test.extend(): a fixture name must not be empty');
    if (CORE_FIXTURE_NAMES.has(name)) {
      throw new CollectionError(
        `test.extend(): "${name}" is a core fixture and cannot be redefined`,
      );
    }
    if (taken.has(name)) {
      throw new CollectionError(
        `test.extend(): fixture "${name}" is already defined by an earlier test.extend()`,
      );
    }
    if (typeof fn !== 'function') {
      throw new CollectionError(
        `test.extend(): fixture "${name}" must be a function (fixtures, use) => Promise<void>`,
      );
    }
    taken.add(name);
    added.push({ name, fn: fn as FixtureFn<object, unknown> });
  }
  return added;
}

/**
 * One `test` object per fixture chain. Every registration made through it
 * records the chain, so an attempt knows which fixtures to set up; the
 * shared `test` is the empty chain.
 */
function createTestAPI(chain: readonly FixtureDefinition[]): TestAPI {
  const testFunction = (
    title: string,
    optionsOrFn: TestOptions | TestFn,
    maybeFn?: TestFn,
  ): TestCase => {
    const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);
    const mode: TestMode = options.only === true ? 'only' : options.skip !== undefined && options.skip !== false ? 'skip' : 'normal';
    return requireCollector('test()').registerTest('test', mode, title, options, [], fn, chain);
  };

  const api: TestAPI = Object.assign(testFunction, {
    skip(first?: string | boolean, second?: TestFn | string): TestCase | undefined {
      const call = parseSkipCall(first, second);
      if (call.kind === 'register') {
        return requireCollector('test.skip()').registerTest('test', 'skip', call.title, { skip: true }, [], call.fn as TestFn, chain);
      }
      skipRunningTest(call.condition, call.reason);
      return undefined;
    },
    step<T>(title: string, body: () => T | Promise<T>): Promise<T> {
      return runTestStep(title, body);
    },
    only(title: string, fn: TestFn): TestCase {
      return requireCollector('test.only()').registerTest('test', 'only', title, { only: true }, [], fn, chain);
    },
    setup(title: string, options: SetupOptions, fn: SetupFn): TestCase {
      if (options === undefined || !Array.isArray(options.sessions)) {
        throw new CollectionError('test.setup() requires a static sessions list');
      }
      const { sessions, ...rest } = options;
      return requireCollector('test.setup()').registerTest('setup', 'normal', title, rest, sessions, fn, chain);
    },
    describe<Result>(
      title: string,
      optionsOrBody: DescribeOptions | (() => Result),
      maybeBody?: () => Result,
    ): void {
      const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
      const body = typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody;
      if (body === undefined) throw new CollectionError('describe body function is required');
      requireCollector('test.describe()').registerDescribe(title, options, body);
    },
    beforeEach(fn: TestHookFn): void {
      requireCollector('test.beforeEach()').registerHook({ kind: 'beforeEach', fn, fixtures: chain });
    },
    afterEach(fn: TestHookFn): void {
      requireCollector('test.afterEach()').registerHook({ kind: 'afterEach', fn, fixtures: chain });
    },
    beforeAll(fn: SuiteHookFn): void {
      requireCollector('test.beforeAll()').registerHook({ kind: 'beforeAll', fn });
    },
    afterAll(fn: SuiteHookFn): void {
      requireCollector('test.afterAll()').registerHook({ kind: 'afterAll', fn });
    },
    // Without definitions this is a type-only refinement: contributed
    // fixtures resolve from the engine at runtime, so the same object serves.
    // With definitions it is a new object, so the shared `test` never changes.
    extend(definitions?: unknown): TestAPI {
      if (definitions === undefined) return api;
      return createTestAPI([...chain, ...validateFixtureDefinitions(definitions, chain)]);
    },
  }) as TestAPI;
  return api;
}

export const test: TestAPI = createTestAPI([]);
