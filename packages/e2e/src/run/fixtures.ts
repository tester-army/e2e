/** Attempt-scoped fixture graph (spec 02-test-api.md, 08-platforms.md). */

import { createAgentFixture } from '../agent/index.ts';
import type { StepExecutor } from '../agent/executor.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import { createModelRouter } from '../agent/model/router.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { BackendFixtureContext } from '../backend/index.ts';
import type { TargetSession } from '../backend/surface.ts';
import { expectationBrand } from '../internal/brands.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { SecretLedger } from '../internal/redact.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import { Deadline, withTimeout } from '../internal/time.ts';
import { LocatorEngine } from '../locator/engine.ts';
import {
  createLocator,
  createScopedScreen,
  createScreen,
  type ScreenContext,
  type SecretResolver,
} from '../locator/screen.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { Agent, App, Expectable, SetupSession, TestFixtures } from '../types.ts';
import type { StepKind, StepRecord, StepRecorder } from './steps.ts';

export interface ArtifactSink {
  /** Absolute attempt artifact directory, for runner-written artifacts. */
  readonly dir: string;
  /** Registers a produced artifact and returns its report artifact ID. */
  register(
    kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log',
    relativePath: string,
  ): string;
}

export interface AttemptEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly attemptId: string;
  readonly testDeadline: Deadline;
  readonly artifacts: ArtifactSink;
  /** Completed steps agent prompts quote as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted test/group agent context appended after config.agent.context. */
  readonly agentContext: string | undefined;
  /** Stages one captured session state; only setup attempts provide this. */
  readonly saveSession: ((name: string) => Promise<void>) | undefined;
  /** The attempt's trace cache context, or undefined when caching is off. */
  readonly cache?: AgentCacheContext;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
}

export interface FixtureGraph {
  readonly fixtures: TestFixtures & { readonly session: SetupSession };
  readonly engine: LocatorEngine;
}

/** Builds the lazy fixture graph for one attempt. */
export function createFixtures(environment: AttemptEnvironment): FixtureGraph {
  const engine = new LocatorEngine({
    session: environment.session,
    signal: environment.signal,
    runId: environment.runId,
    attemptId: environment.attemptId,
    actionTimeout: environment.config.actionTimeout,
    assertionTimeout: environment.config.assertionTimeout,
    testDeadline: environment.testDeadline,
  });

  /**
   * Any resolved secret leaves the viewport pixel-tainted for the rest of the
   * attempt: an untrusted app may mirror the value anywhere on screen.
   */
  const taint = { value: false };

  const ledger = attemptSecretLedger(environment);
  const secrets: SecretResolver = {
    async resolve(secret) {
      const credential = environment.config.credentials.get(secret.name);
      if (credential === undefined) {
        throw new ConfigurationError(
          'AUTH_CREDENTIAL_UNAVAILABLE',
          `credential "${secret.name}" is not configured`,
        );
      }
      const password = credential.password;
      const plaintext = typeof password === 'function' ? await password() : password;
      if (typeof plaintext !== 'string' || plaintext === '') {
        throw new ConfigurationError(
          'AUTH_CREDENTIAL_UNAVAILABLE',
          `credential "${secret.name}" provider did not return a non-empty string`,
        );
      }
      // Only a value that exists can reach the screen: a failed provider
      // leaves nothing to taint the viewport with.
      taint.value = true;
      // A provider-resolved value joins redaction the moment it exists.
      ledger.register(secret.name, plaintext);
      return plaintext;
    },
  };

  const screenContext: ScreenContext = {
    engine,
    steps: environment.steps,
    secrets,
    projectRoot: environment.config.projectRoot,
  };
  const screen = createScreen(screenContext);
  const app = createApp(environment, engine);

  let agent: Agent | undefined;

  const fixtures: TestFixtures & { session: SetupSession } = {
    get agent(): Agent {
      agent ??= createAgentFixture({
        engine,
        steps: environment.steps,
        executor: environment.config.agent.executor ?? missingExecutor(),
        customExecutor: environment.config.agent.judgments === 'executor',
        models: createModelRouter(environment.config.agent, createModelAdapter),
        config: environment.config,
        target: {
          name: environment.target.name,
          platform: environment.target.platform,
          verbs: environment.session.verbs,
        },
        priorSteps: environment.priorSteps,
        agentContext: joinAgentContext(
          environment.config.agent.context,
          environment.agentContext,
        ),
        secrets,
        redact: ledger.redact,
        taint,
        artifacts: environment.artifacts,
        signal: environment.signal,
        ...(environment.cache !== undefined ? { cache: environment.cache } : {}),
        ...(environment.debug !== undefined ? { debug: environment.debug } : {}),
      });
      return agent;
    },
    app,
    screen,
    platform: environment.target.platform,
    session: {
      save: async (name: string) => {
        const saveSession = environment.saveSession;
        if (saveSession === undefined) {
          throw new ConfigurationError(
            'INVALID_CONFIG',
            'session.save() is only available inside setup tests',
          );
        }
        await environment.steps.run('session', 'session.save', name, () => saveSession(name));
      },
    },
  };
  // Defined as accessors, not spread: spreading would invoke every factory
  // eagerly, before the test body and whether or not it touches the fixture.
  Object.defineProperties(
    fixtures,
    Object.getOwnPropertyDescriptors(contributedFixtures(environment, engine, screenContext)),
  );

  return { fixtures: gateUnknownFixtures(fixtures, environment), engine };
}

/** Keys a test body may probe without meaning a fixture. */
const PROBED_KEYS = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf', 'inspect']);

/**
 * Reaching for a fixture the target's backend does not contribute fails at
 * the first touch with the earliest honest error: the backend's name and what
 * it does declare, instead of a TypeError three lines later.
 */
function gateUnknownFixtures<T extends object>(fixtures: T, environment: AttemptEnvironment): T {
  return new Proxy(fixtures, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target || PROBED_KEYS.has(property)) {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const backend = environment.target.backend;
      const declared = Object.keys(backend?.fixtures ?? {});
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${environment.target.name}" has no "${property}" fixture: backend ${backend?.name ?? 'none'} contributes ${declared.length === 0 ? 'no fixtures' : declared.join(', ')}`,
      );
    },
  });
}

/**
 * Backend-contributed fixtures (RFC0002): the backend declares what calls
 * exist, the harness owns how every call runs. Each async method becomes a
 * recorded step named `<fixture>.<method>`, bounded by the action timeout (or
 * the call's own `timeout` option) and the attempt signal; a synchronous
 * member is an accessor and passes through. Core validates shape, never
 * meaning.
 */
function contributedFixtures(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
): Record<string, unknown> {
  const declared = environment.target.backend?.fixtures;
  if (declared === undefined) return {};
  const contributed: Record<string, unknown> = {};
  const attachments = new StepAttachments();
  const context = fixtureContext(environment, engine, screenContext, attachments);
  for (const [name, factory] of Object.entries(declared)) {
    let instance: object | undefined;
    Object.defineProperty(contributed, name, {
      enumerable: true,
      get() {
        instance ??= recordedSurface(factory(context), environment, attachments, {
          path: [name],
          kind: 'resource',
          bounded: true,
        });
        return instance;
      },
    });
  }
  return contributed;
}

/**
 * Attributes what a fixture method records to the step that wraps the call.
 * The method runs before its step opens (that is what lets a synchronous
 * accessor stay an accessor), so anything it attaches synchronously is held
 * here and released into the step once the step exists, or into the current
 * step when the call turns out to be synchronous.
 */
class StepAttachments {
  private deferred: (() => void)[] | null = null;

  /** Runs `attach` now, or holds it while a fixture call is being invoked. */
  record(attach: () => void): void {
    if (this.deferred === null) attach();
    else this.deferred.push(attach);
  }

  /** Invokes `call` with attachments held, returning them for release. */
  collect<T>(call: () => T): { result: T; release: () => void } {
    const outer = this.deferred;
    const held: (() => void)[] = [];
    this.deferred = held;
    try {
      const result = call();
      return {
        result,
        release: () => {
          for (const attach of held) attach();
        },
      };
    } finally {
      this.deferred = outer;
    }
  }
}

function fixtureContext(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
  attachments: StepAttachments,
): BackendFixtureContext {
  const { config, steps } = environment;
  return {
    targetName: environment.target.name,
    app: {
      ...(config.app.configured ? { baseUrl: config.app.base.href } : {}),
      allowedOrigins: config.app.allowedOrigins,
      resolveUrl: (url) => {
        requireAppUrl(config);
        return resolveNavigationUrl(url, config.app.base, config.app.allowedOrigins).url;
      },
    },
    timeouts: {
      test: config.timeout,
      action: config.actionTimeout,
      assertion: config.assertionTimeout,
    },
    signal: environment.signal,
    operation: (timeoutMs) => engine.operation(timeoutMs),
    attachArtifact: (kind, relativePath) =>
      attachments.record(() =>
        steps.attachArtifact(environment.artifacts.register(kind, relativePath)),
      ),
    attachViewport: (viewport) => attachments.record(() => steps.attachViewport(viewport)),
    locator: (expression) => createLocator(screenContext, expression),
    screen: (wrap) => createScopedScreen(screenContext, wrap),
    expectable<T extends object, E extends object>(target: T, factory: () => E): T & Expectable<E> {
      let surface: E | undefined;
      Object.defineProperty(target, expectationBrand, {
        enumerable: false,
        configurable: true,
        get: () => {
          surface ??= recordedSurface(factory(), environment, attachments, {
            path: ['expect'],
            kind: 'assertion',
            bounded: false,
          });
          return surface;
        },
      });
      return target as T & Expectable<E>;
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Longest label a fixture argument may contribute to the report. */
const LABEL_LIMIT = 80;

/** Method names whose string argument is typed input, labelled by length only. */
const INPUT_METHODS = new Set(['type', 'fill', 'insertText']);

/**
 * Step label heuristic: the first string or pattern argument, if any. Fixture
 * arguments are report-visible by this rule; secret material travels as
 * `Secret` handles, never as strings, so it cannot land here. Typed input is
 * the exception: it is user data, so only its length is recorded.
 */
function labelFor(api: string, args: readonly unknown[]): string {
  const method = api.slice(api.lastIndexOf('.') + 1);
  if (INPUT_METHODS.has(method) && typeof args[0] === 'string') return `${args[0].length} chars`;
  for (const arg of args) {
    if (typeof arg === 'string') return arg.length > LABEL_LIMIT ? `${arg.slice(0, LABEL_LIMIT)}...` : arg;
    if (arg instanceof RegExp) return String(arg);
  }
  return '';
}

/** A call's own `timeout` option wins over the action timeout, as on Locator. */
function timeoutFor(args: readonly unknown[], fallback: number): number {
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) continue;
    const timeout = (arg as { timeout?: unknown }).timeout;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) return timeout;
  }
  return fallback;
}

interface RecordingOptions {
  /** Dotted step-name prefix, e.g. `['gadget', 'knobs']`. */
  readonly path: readonly string[];
  readonly kind: StepKind;
  /** Whether calls are bounded by the action timeout (or their own `timeout` option). */
  readonly bounded: boolean;
}

/**
 * Wraps a contributed surface so every async method call is one recorded
 * step. Nested plain objects (namespaces such as `keyboard`) are wrapped
 * recursively with a dotted path; symbol-keyed members and synchronous
 * results pass through untouched.
 *
 * The member is invoked first and the step opens around the promise it
 * returns, which is what lets a synchronous accessor stay an accessor. A
 * synchronous throw is recorded as the failed step it would have been, and
 * anything the call attached through the context is released into that step,
 * however early in the call it happened.
 */
function recordedSurface<T extends object>(
  surface: T,
  environment: AttemptEnvironment,
  attachments: StepAttachments,
  options: RecordingOptions,
): T {
  return new Proxy(surface, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string') return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const api = [...options.path, property].join('.');
          let collected: { result: unknown; release: () => void };
          try {
            collected = attachments.collect(() =>
              (value as (...inner: unknown[]) => unknown).apply(target, args),
            );
          } catch (cause) {
            // Recorded as the failed step it was, then rethrown as it was thrown:
            // a synchronous caller must not receive a promise in place of a throw.
            environment.steps
              .run(options.kind, api, labelFor(api, args), () => Promise.reject(cause))
              .catch(() => undefined);
            throw cause;
          }
          const { result, release } = collected;
          if (!isThenable(result)) {
            release();
            return result;
          }
          return environment.steps.run(options.kind, api, labelFor(api, args), () => {
            release();
            const pending = Promise.resolve(result);
            if (!options.bounded) return pending;
            const timeout = timeoutFor(args, environment.config.actionTimeout);
            // A call that outlives its budget is a failed action, like a
            // locator action that never became actionable; the test clock is
            // a separate matter.
            return withTimeout(
              pending,
              timeout,
              () => new TestError('ACTION_FAILED', `${api} exceeded its timeout of ${timeout}ms`),
            );
          });
        };
      }
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        !isThenable(value) &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        return recordedSurface(value, environment, attachments, {
          ...options,
          path: [...options.path, property],
        });
      }
      return value;
    },
  });
}

/**
 * The executor `agent.act()` dispatches to when the config named none. The
 * runner ships no agent: the socket, the budgets, the observation pipeline,
 * the ledger, and the trace cache are the standard, and the brain that runs
 * on them is the project's to supply (`agent.executor`, or `agent` set to the
 * executor itself). Judgment steps — `assert`, `waitFor`, `extract` — need
 * only a model and keep working without one.
 */
function missingExecutor(): StepExecutor {
  return {
    name: 'no-executor',
    version: '0',
    runStep(): Promise<never> {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'agent.act() needs a step executor and the config names none: set agent.executor to a StepExecutor ' +
          '(for example one built with createToolLoopExecutor from e2e/agent), or set agent to the executor itself',
      );
    },
  };
}

/** Trusted config context first, then test/group context. */
function joinAgentContext(
  configContext: string | undefined,
  testContext: string | undefined,
): string | undefined {
  const parts = [configContext, testContext].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  return parts.length === 0 ? undefined : parts.join('\n');
}

/**
 * The attempt's secret ledger, seeded with the passwords known up front.
 * Provider-backed values join through the resolver at fill time.
 */
function attemptSecretLedger(environment: AttemptEnvironment): SecretLedger {
  return new SecretLedger(
    [...environment.config.credentials].flatMap(([name, { password }]) =>
      typeof password === 'string' ? [[name, password] as const] : [],
    ),
  );
}

/** Navigation needs a real app URL; the placeholder base never leaves the harness. */
function requireAppUrl(config: ResolvedConfig): void {
  if (config.app.configured) return;
  throw new ConfigurationError(
    'APP_URL_REQUIRED',
    'navigation needs an app URL: set app.url in e2e.config.ts or the APP_URL environment variable',
  );
}

function createApp(environment: AttemptEnvironment, engine: LocatorEngine): App {
  const { config, steps } = environment;
  const allowed = config.app.allowedOrigins;

  /** One recorded navigation: policy-resolved against the base URL, on the test budget. */
  const navigate = (api: string, label: string, target: string | undefined): Promise<void> =>
    steps.run('app', api, label, async () => {
      requireAppUrl(config);
      const resolved =
        target === undefined
          ? config.app.base.href
          : resolveNavigationUrl(target, config.app.base, allowed).url;
      await engine.session.app.open(resolved, engine.operation(config.timeout));
    });

  return {
    open: (openPath?: string) => navigate('app.open', openPath ?? '/', openPath),
    deepLink: (url: string) => navigate('app.deepLink', url, url),
    async restart(): Promise<void> {
      await steps.run('app', 'app.restart', '', async () => {
        await engine.session.app.restart(engine.operation(config.timeout));
      });
    },
    async clearState(): Promise<void> {
      await steps.run('app', 'app.clearState', '', async () => {
        await engine.session.app.clearState(engine.operation(config.timeout));
      });
    },
    async back(): Promise<void> {
      await steps.run('app', 'app.back', '', async () => {
        await engine.session.app.back(engine.operation());
      });
    },
    async screenshot(label?: string): Promise<string> {
      return steps.run('app', 'app.screenshot', label ?? '', async () => {
        const relative = await engine.session.artifacts.screenshot(label, engine.operation());
        environment.steps.attachArtifact(environment.artifacts.register('screenshot', relative));
        return relative;
      });
    },
  };
}
