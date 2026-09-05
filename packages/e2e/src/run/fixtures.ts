/** Attempt-scoped fixture graph (spec 02-test-api.md, 08-platforms.md). */

import { createAgentFixture } from '../agent/index.ts';
import type { ExecutorAttempt, StepExecutor } from '../agent/executor.ts';
import type { AgentCacheContext } from '../cache/context.ts';
import { createModelRouter } from '../agent/model/router.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { BackendFixtureContext } from '../backend/index.ts';
import type { TargetSession } from '../backend/surface.ts';
import { expectationBrand } from '../internal/brands.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { SecretLedger } from '../internal/redact.ts';
import { resolveNavigationUrl } from '../internal/urls.ts';
import { FixtureRecorder } from './fixture-recording.ts';
import { recordedSurface, StepAttachments } from './fixture-legacy.ts';
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
import type { StepRecord, StepRecorder } from './steps.ts';

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
  /** The running phase's signal and deadline; read at call time, never captured. */
  readonly budget: AttemptBudget;
  readonly runId: string;
  readonly attemptId: string;
  /** The attempt as executors see it: identity, end-of-attempt signal, scratch memory. */
  readonly attempt: ExecutorAttempt;
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

/** Secrets survive every fixture graph that shares the same live isolation. */
const sessionSecrets = new WeakMap<TargetSession, { ledger: SecretLedger; taint: { value: boolean } }>();

/** Builds the lazy fixture graph for one attempt. */
export function createFixtures(
  environment: AttemptEnvironment,
): TestFixtures & { readonly session: SetupSession } {
  const engine = new LocatorEngine({
    session: environment.session,
    budget: environment.budget,
    runId: environment.runId,
    attemptId: environment.attemptId,
    actionTimeout: environment.config.actionTimeout,
    assertionTimeout: environment.config.assertionTimeout,
  });

  let secrecy = sessionSecrets.get(environment.session);
  if (secrecy === undefined) {
    secrecy = { ledger: initialSecretLedger(environment), taint: { value: false } };
    sessionSecrets.set(environment.session, secrecy);
  }
  const { ledger, taint } = secrecy;
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
        executor: environment.config.agent.executor ?? lazyDefaultExecutor(),
        customExecutor: environment.config.agent.executor !== undefined,
        models: createModelRouter(environment.config.agent, createModelAdapter),
        config: environment.config,
        target: {
          name: environment.target.name,
          platform: environment.target.platform,
          verbs: environment.session.verbs,
        },
        attempt: environment.attempt,
        priorSteps: environment.priorSteps,
        agentContext: joinAgentContext(
          environment.config.agent.context,
          environment.agentContext,
        ),
        secrets,
        redact: ledger.redact,
        taint,
        artifacts: environment.artifacts,
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

  return gateUnknownFixtures(fixtures, environment);
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
 * Backend-contributed fixtures (RFC0002): factories declare operation metadata
 * through context.fixture. The legacy adapter preserves older factories that
 * return a plain surface. Factories stay lazy and each instance belongs to
 * one test's fixture graph; the session's secrecy state outlives that graph.
 */
function contributedFixtures(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
): Record<string, unknown> {
  const declared = environment.target.backend?.fixtures;
  if (declared === undefined) return {};
  const contributed: Record<string, unknown> = {};
  const attachments = new StepAttachments(environment.steps);
  const recorder = new FixtureRecorder(environment);
  const context = fixtureContext(environment, engine, screenContext, attachments, recorder);
  for (const [name, factory] of Object.entries(declared)) {
    let instance: object | undefined;
    Object.defineProperty(contributed, name, {
      enumerable: true,
      get() {
        instance ??= recorder.adapt(factory(context), (surface) => recordedSurface(surface, environment, attachments, {
          path: [name],
          kind: 'resource',
          bounded: true,
        }));
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
  attachments: StepAttachments,
  recorder: FixtureRecorder,
): BackendFixtureContext {
  const { config, steps } = environment;
  return {
    targetName: environment.target.name,
    fixture: (name, surface, operations) => recorder.fixture(name, surface, operations),
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
    // A getter, not a snapshot: the SPI promises the running phase's signal.
    get signal() {
      return engine.signal;
    },
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
          surface ??= recorder.adapt(factory(), (value) => recordedSurface(value, environment, attachments, {
            path: ['expect'],
            kind: 'assertion',
            bounded: false,
          }));
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

/**
 * The session's secret ledger, seeded with the passwords known up front.
 * Provider-backed values join through the resolver at fill time.
 */
function initialSecretLedger(environment: AttemptEnvironment): SecretLedger {
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
