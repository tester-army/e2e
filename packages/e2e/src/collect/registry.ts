/** Synchronous registration during module evaluation (spec 11-lifecycle.md). */

import { testCaseBrand } from '../internal/brands.ts';
import { CollectionError } from '../internal/errors.ts';
import { validateTitle } from '../internal/ids.ts';
import { realmSlot } from '../internal/realm-slot.ts';
import type {
  DescribeOptions,
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

export interface RegisteredTest {
  readonly kind: 'test' | 'setup';
  readonly title: string;
  readonly titlePath: readonly string[];
  readonly declarationIndex: number;
  readonly options: TestOptions;
  readonly sessions: readonly string[];
  readonly fn: TestFn | SetupFn;
  readonly group: GroupNode | undefined;
  readonly mode: TestMode;
  readonly source: SourceLocation | undefined;
}

export type HookKind = 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll';

export interface RegisteredHook {
  readonly kind: HookKind;
  readonly fn: TestHookFn | SuiteHookFn;
  readonly group: GroupNode | undefined;
  readonly declarationIndex: number;
}

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
  ): TestCase {
    this.assertOpen(kind === 'setup' ? 'test.setup()' : 'test()');
    const titleError = validateTitle(title);
    if (titleError !== null) throw new CollectionError(titleError);
    if (typeof fn !== 'function') throw new CollectionError('test body must be a function');
    if (kind === 'setup') {
      if (this.currentGroup !== undefined) {
        throw new CollectionError('setup tests must be top-level; they cannot appear in describe');
      }
      if (sessions.length === 0) {
        throw new CollectionError('setup tests must declare at least one session');
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
    const titlePath = [...groupTitles(this.currentGroup), title.normalize('NFC')];
    const registered: RegisteredTest = {
      kind,
      title: title.normalize('NFC'),
      titlePath,
      declarationIndex: this.declarationCounter,
      options,
      sessions,
      fn,
      group: this.currentGroup,
      mode,
      source: captureSource(),
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

  registerHook(kind: HookKind, fn: TestHookFn | SuiteHookFn): void {
    this.assertOpen(`test.${kind}()`);
    if (typeof fn !== 'function') throw new CollectionError(`${kind} hook must be a function`);
    this.hooks.push({
      kind,
      fn,
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

/** Runs `load` with a fresh collector active and returns everything it registered. */
export async function collectModule(load: () => Promise<unknown>): Promise<ModuleRegistration> {
  if (collectorSlot.get(globalThis) !== undefined) {
    throw new CollectionError('collection is already in progress');
  }
  const collector = new Collector();
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

function captureSource(): SourceLocation | undefined {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  const lines = stack.split('\n').slice(1);
  for (const line of lines) {
    const match = /\(?(?:file:\/\/)?([^()\s]+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (match === null) continue;
    const file = decodeURIComponent(match[1]!);
    if (file.includes('/e2e/src/') || file.includes('/e2e/dist/') || file.includes('node:')) {
      continue;
    }
    return { file, line: Number(match[2]), column: Number(match[3]) };
  }
  return undefined;
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

const testFunction = (
  title: string,
  optionsOrFn: TestOptions | TestFn,
  maybeFn?: TestFn,
): TestCase => {
  const { options, fn } = normalizeArgs(optionsOrFn, maybeFn);
  const mode: TestMode = options.only === true ? 'only' : options.skip !== undefined && options.skip !== false ? 'skip' : 'normal';
  return requireCollector('test()').registerTest('test', mode, title, options, [], fn);
};

export const test: TestAPI = Object.assign(testFunction, {
  skip(title: string, fn: TestFn): TestCase {
    return requireCollector('test.skip()').registerTest('test', 'skip', title, { skip: true }, [], fn);
  },
  only(title: string, fn: TestFn): TestCase {
    return requireCollector('test.only()').registerTest('test', 'only', title, { only: true }, [], fn);
  },
  setup(title: string, options: SetupOptions, fn: SetupFn): TestCase {
    if (options === undefined || !Array.isArray(options.sessions)) {
      throw new CollectionError('test.setup() requires a static sessions list');
    }
    const { sessions, ...rest } = options;
    return requireCollector('test.setup()').registerTest('setup', 'normal', title, rest, sessions, fn);
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
    requireCollector('test.beforeEach()').registerHook('beforeEach', fn);
  },
  afterEach(fn: TestHookFn): void {
    requireCollector('test.afterEach()').registerHook('afterEach', fn);
  },
  beforeAll(fn: SuiteHookFn): void {
    requireCollector('test.beforeAll()').registerHook('beforeAll', fn);
  },
  afterAll(fn: SuiteHookFn): void {
    requireCollector('test.afterAll()').registerHook('afterAll', fn);
  },
}) as TestAPI;
