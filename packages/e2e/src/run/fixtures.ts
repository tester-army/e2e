/** Attempt-scoped fixture graph. */

import { createAgentFixture } from '../agent/index.ts';
import type { AgentContext, AgentSelection } from '../agent/invocation.ts';
import type { ExecutorAttempt, StepExecutor } from '../agent/executor.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import { createModelRouter } from '../agent/model/router.ts';
import type { WorkerModels } from './worker-models.ts';
import type { EngineFixtureContext } from '../engine/index.ts';
import type { TargetSession } from '../engine/surface.ts';
import { expectationBrand } from '../internal/brands.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, errorMessage, InfrastructureError, TestError } from '../internal/errors.ts';
import { didYouMean } from '../internal/suggest.ts';
import { sessionSecrecy, type SessionSecrecy } from './secrecy.ts';
import { obj } from '../internal/objects.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import { FixtureRecorder } from './fixture-recording.ts';
import type { AttemptBudget } from './budget.ts';
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
import type { ArtifactRecord } from './records.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

export interface ArtifactSink {
  /** Absolute attempt artifact directory, for runner-written artifacts. */
  readonly dir: string;
  /** Registers a produced artifact and returns its report artifact ID. */
  register(
    kind: 'screenshot' | 'trace' | 'video' | 'download' | 'log',
    relativePath: string,
    options?: ArtifactRegistration,
  ): string;
}

/** Facts about a produced artifact its file does not carry. */
export interface ArtifactRegistration {
  /** When a time-based artifact (a video segment) began recording. */
  readonly startedAt?: string;
  /**
   * How much of the file the runner masked, when that was decided per
   * artifact (a trace, rewritten or found to need no rewriting) rather than
   * per kind.
   */
  readonly redaction?: ArtifactRecord['redaction'];
}

export interface AttemptEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly session: TargetSession;
  readonly steps: StepRecorder;
  /** The running phase's signal and deadline; read at call time, never captured. */
  readonly budget: AttemptBudget;
  readonly runId: string;
  readonly attemptId: string;
  /** The attempt as executors see it: identity, end-of-attempt signal, scratch memory. */
  readonly attempt: ExecutorAttempt;
  readonly artifacts: ArtifactSink;
  /** Completed steps agent prompts quote as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted test/group agent context appended after the agent's own `context`. */
  readonly agentContext: string | undefined;
  /** The configured agent the pair runs as; undefined falls back to the run's first agent. */
  readonly agent?: string | undefined;
  /** Stages one captured session state; only setup attempts provide this. */
  readonly saveSession: ((name: string) => Promise<void>) | undefined;
  /** The attempt's trace cache context, or undefined when caching is off. */
  readonly cache?: AgentCacheContext;
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
  /** The worker's model adapters, checked once on the first `agent` acquisition. */
  readonly models: WorkerModels;
}

/** Builds the lazy fixture graph for one attempt. */
export interface AttemptFixtures {
  readonly fixtures: TestFixtures & { readonly session: SetupSession };
  /** The runtime behind `fixtures.agent`, for a host that opens steps itself (`e2e mcp`). */
  readonly agentRuntime: AgentContext;
}

export function createFixtures(environment: AttemptEnvironment): AttemptFixtures {
  const engine = new LocatorEngine({
    session: environment.session,
    budget: environment.budget,
    runId: environment.runId,
    attemptId: environment.attemptId,
    actionTimeout: environment.config.actionTimeout,
    assertionTimeout: environment.config.assertionTimeout,
  });

  const { ledger, taint } = sessionSecrecy(environment.session, environment.config.credentials);
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
  const app = createApp(environment, engine, taint);

  let agent: Agent | undefined;

  /**
   * The agents this attempt can run with, resolved once each: the test's pin
   * (else the run's agent) when a call names none, or any configured agent a
   * call names. Each is preflighted on first use, so a second agent's missing
   * credential surfaces where it is first needed, as one run-level failure.
   */
  const { config } = environment;
  const attemptAgentName = environment.agent ?? config.agentNames[0]!;
  const selections = new Map<string, AgentSelection>();
  const select = (requested: string | undefined): AgentSelection => {
    if (requested !== undefined && (typeof requested !== 'string' || requested === '')) {
      throw new TestError('INVALID_ARGUMENT', 'agent must be the name of a configured agent');
    }
    const name = requested ?? attemptAgentName;
    const cached = selections.get(name);
    if (cached !== undefined) return cached;
    const resolved = config.agents.get(name);
    if (resolved === undefined) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `unknown agent "${name}"; configured: ${[...config.agents.keys()].join(', ')}`,
      );
    }
    environment.models.preflight(resolved);
    const selection: AgentSelection = {
      name,
      config: resolved,
      executor: resolved.executor ?? lazyDefaultExecutor(),
      customExecutor: resolved.executor !== undefined,
      models: createModelRouter(resolved, environment.models.build),
      agentContext: joinAgentContext(resolved.context, environment.agentContext),
    };
    selections.set(name, selection);
    return selection;
  };

  const agentRuntime: AgentContext = {
    engine,
    steps: environment.steps,
    select,
    config: environment.config,
    target: {
      name: environment.target.name,
      platform: environment.target.platform,
      verbs: environment.session.verbs,
    },
    app: environment.target.app,
    attempt: environment.attempt,
    priorSteps: environment.priorSteps,
    secrets,
    redact: ledger.redact,
    taint,
    artifacts: environment.artifacts,
    ...(environment.cache !== undefined ? { cache: environment.cache } : {}),
    ...(environment.debug !== undefined ? { debug: environment.debug } : {}),
  };

  const fixtures: TestFixtures & { session: SetupSession } = {
    get agent(): Agent {
      if (agent !== undefined) return agent;
      // The attempt's own agent is checked as the fixture is acquired, as before.
      select(undefined);
      agent = createAgentFixture(agentRuntime);
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

  return { fixtures: gateUnknownFixtures(fixtures, environment), agentRuntime };
}

/** Keys a test body may probe without meaning a fixture. */
const PROBED_KEYS = new Set(['then', 'constructor', 'toJSON', 'toString', 'valueOf', 'inspect']);

/** Fixtures other runners hand out, each pointed at the e2e way of doing the same thing. */
const FOREIGN_FIXTURE_HINTS: Readonly<Record<string, string>> = {
  page: 'there is no Playwright page: open the app with app.open() and find elements through screen; browser-only APIs are on the web fixture of a Playwright target',
  browser: 'the browser is owned by the engine: drive it through app, screen, and (on a Playwright target) web',
  context: 'the browser context is owned by the engine: cookies, routes, and storage are on the web fixture of a Playwright target',
  request: 'there is no request fixture: call fetch() directly, or reach the browser through the web fixture of a Playwright target',
  driver: 'there is no WebDriver session: drive the device through app, screen, and (on an agent-device target) device',
};

/**
 * Reaching for a fixture the target's engine does not contribute fails at
 * the first touch with the earliest honest error: the engine's name and what
 * it does declare, instead of a TypeError three lines later.
 */
function gateUnknownFixtures<T extends object>(fixtures: T, environment: AttemptEnvironment): T {
  return new Proxy(fixtures, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target || PROBED_KEYS.has(property)) {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const engine = environment.target.engine;
      const declared = Object.keys(engine?.fixtures ?? {});
      const available = Object.keys(target).toSorted();
      const contributed = `engine ${engine?.name ?? 'none'} contributes ${declared.length === 0 ? 'no fixtures' : declared.join(', ')}`;
      const foreign = FOREIGN_FIXTURE_HINTS[property];
      const hint = foreign === undefined ? didYouMean(property, available) : `; ${foreign}`;
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `target "${environment.target.name}" has no "${property}" fixture; available: ${available.join(', ')} (${contributed})${hint}`,
      );
    },
  });
}

/**
 * Engine-contributed fixtures: factories declare operation metadata
 * through context.fixture and must return the surface they declared. Factories
 * stay lazy and each instance belongs to one test's fixture graph; the
 * session's secrecy state outlives that graph.
 */
function contributedFixtures(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
): Record<string, unknown> {
  const declared = environment.target.engine?.fixtures;
  if (declared === undefined) return {};
  const contributed: Record<string, unknown> = {};
  const recorder = new FixtureRecorder(environment);
  const context = fixtureContext(environment, engine, screenContext, recorder);
  for (const [name, factory] of Object.entries(declared)) {
    let instance: object | undefined;
    Object.defineProperty(contributed, name, {
      enumerable: true,
      get() {
        instance ??= recorder.require(name, factory(context));
        return instance;
      },
    });
  }
  return contributed;
}

function fixtureContext(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
  recorder: FixtureRecorder,
): EngineFixtureContext {
  const { config, steps } = environment;
  const { app } = environment.target;
  return {
    targetName: environment.target.name,
    fixture: (name, surface, operations) => recorder.fixture(name, surface, operations),
    app: {
      ...obj({ baseUrl: app.base?.href }),
      allowedOrigins: app.allowedOrigins,
      resolveUrl: (url) => {
        requireAppUrl(environment.target);
        return resolveNavigationUrl(url, app.base, app.allowedOrigins).url;
      },
    },
    timeouts: {
      test: config.timeout,
      action: config.actionTimeout,
      assertion: config.assertionTimeout,
    },
    // A getter, not a snapshot: the SPI promises the running phase's signal.
    get signal() {
      return engine.signal;
    },
    operation: (timeoutMs) => engine.operation(timeoutMs),
    attachArtifact: (kind, relativePath) =>
      steps.attachArtifact(environment.artifacts.register(kind, relativePath)),
    attachViewport: (viewport) => steps.attachViewport(viewport),
    locator: (expression) => createLocator(screenContext, expression),
    screen: (wrap) => createScopedScreen(screenContext, wrap),
    expectable<T extends object, E extends object>(target: T, factory: () => E): T & Expectable<E> {
      let surface: E | undefined;
      Object.defineProperty(target, expectationBrand, {
        enumerable: false,
        configurable: true,
        get: () => {
          surface ??= recorder.require('expect', factory());
          return surface;
        },
      });
      return target as T & Expectable<E>;
    },
  };
}

/**
 * The built-in executor behind a dynamic import, so the optional `ai` peer
 * dependency loads only if an `agent.act()` step actually runs. Deterministic
 * suites and custom-executor projects never pay for - or fail on - it.
 */
function lazyDefaultExecutor(): StepExecutor {
  let executor: StepExecutor | undefined;
  return {
    name: 'e2e-default-agent',
    // Keep in lockstep with createAgent's version: cache provenance and model
    // policyVersion record this wrapper, not the delegate it constructs.
    version: '2',
    async runStep(context) {
      if (executor === undefined) {
        const { createAgent } = await import('../agent/default-agent.ts');
        executor = createAgent();
      }
      return executor.runStep(context);
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

/** Navigation needs an app URL, and only the target's engine can declare one. */
function requireAppUrl(target: ResolvedTarget): asserts target is ResolvedTarget & {
  app: { base: NonNullable<ResolvedTarget['app']['base']> };
} {
  if (target.app.base !== undefined) return;
  throw new ConfigurationError(
    'APP_URL_REQUIRED',
    `navigation needs an app URL: the engine of target "${target.name}" declares none (${target.engine?.name ?? 'no engine'})`,
  );
}

/**
 * Network-level failures a browser or device reports when nothing is
 * listening where the app should be. Anything else that fails a navigation
 * (a certificate, a 500, a crash mid-load) stays an engine failure.
 */
const NOTHING_LISTENING =
  /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ERR_ADDRESS_UNREACHABLE|EHOSTUNREACH|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/;

/**
 * A navigation the network refused means the app is down, which is the
 * first thing a new project runs into and the last thing an engine failure
 * message suggests. Named by its own code, with the URL and the three ways
 * to fix it.
 */
function unreachableApp(cause: unknown, url: string): InfrastructureError | undefined {
  const match = NOTHING_LISTENING.exec(errorMessage(cause));
  if (match === null) return undefined;
  return new InfrastructureError(
    'APP_UNREACHABLE',
    `nothing answered at ${url} (${match[0]}); start the app there, point the engine's url at where it runs, or give the engine a command so the runner starts it`,
    { cause },
  );
}

/** Builds the portable app fixture with the session's shared screenshot policy. */
function createApp(environment: AttemptEnvironment, engine: LocatorEngine, taint: SessionSecrecy['taint']): App {
  const { config, steps, target } = environment;

  /** One recorded navigation: policy-resolved against the base URL, on the test budget. */
  const navigate = (api: string, label: string, url: string | undefined): Promise<void> =>
    steps.run('app', api, label, async () => {
      requireAppUrl(target);
      const resolved =
        url === undefined
          ? target.app.base.href
          : resolveNavigationUrl(url, target.app.base, target.app.allowedOrigins).url;
      try {
        await engine.session.app.open(resolved, engine.operation(config.timeout));
      } catch (cause) {
        throw unreachableApp(cause, resolved) ?? cause;
      }
    });

  return {
    open: (openPath?: string) => navigate('app.open', openPath ?? '/', openPath),
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
        if (taint.value) {
          throw new ConfigurationError(
            'POLICY_DENIED',
            'app.screenshot() is denied after a secret fill because the app may display the secret outside a secure field',
          );
        }
        const relative = await engine.session.artifacts.screenshot(label, engine.operation());
        environment.steps.attachArtifact(environment.artifacts.register('screenshot', relative));
        return relative;
      });
    },
  };
}
