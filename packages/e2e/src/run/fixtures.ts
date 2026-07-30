/** Attempt-scoped fixture graph (spec 02-test-api.md, 08-platforms.md). */

import { createAgent } from '../agent/index.ts';
import type { AgentCacheContext } from '../agent/invocation.ts';
import { createModelRouter } from '../agent/model/router.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type {
  DriverDevice,
  DriverDialog,
  DriverSession,
  DriverWebRoute,
} from '../driver/index.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { registerWebExpectTarget } from '../expect/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { toRoutePattern } from '../internal/route-pattern.ts';
import {
  assertDeviceUrlAllowed,
  resolveNavigationUrl,
  urlMatches,
  type NormalizedBaseUrl,
} from '../internal/urls.ts';
import { Deadline, sleep, withTimeout } from '../internal/time.ts';
import { LocatorEngine } from '../locator/engine.ts';
import { webSelectorExpression } from '../locator/expression.ts';
import {
  createFrameScreen,
  createLocator,
  createScreen,
  isSecret,
  type ScreenContext,
  type SecretResolver,
} from '../locator/screen.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type {
  Agent,
  App,
  Cookie,
  Device,
  Dialog,
  JsonValue,
  Locator,
  Screen,
  SetupSession,
  TestFixtures,
  Web,
  WebResponse,
  WebRoute,
} from '../types.ts';
import type { StepRecord, StepRecorder } from './steps.ts';

export interface ArtifactSink {
  /** Registers a produced artifact and returns its report artifact ID. */
  register(kind: 'screenshot' | 'trace' | 'video' | 'download', relativePath: string): string;
}

export interface AttemptEnvironment {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly driverSession: DriverSession;
  readonly steps: StepRecorder;
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly attemptId: string;
  /** Cache identity and storage for this attempt. */
  readonly cache: AgentCacheContext;
  readonly testDeadline: Deadline;
  readonly artifacts: ArtifactSink;
  /** Completed steps agent prompts quote as prior context; serial members see the whole group. */
  readonly priorSteps: () => readonly StepRecord[];
  /** Trusted test/group agent context appended after config.agent.context. */
  readonly agentContext: string | undefined;
  /** Stages one captured session state; only setup attempts provide this. */
  readonly saveSession: ((name: string) => Promise<void>) | undefined;
  /**
   * Whether the app was opened in the owning driver session. Serial-group
   * members share one session and therefore one open state.
   */
  readonly opened: { value: boolean };
  /** `--debug` phase timings; absent when the caller collects none. */
  readonly debug?: DebugTrace;
}

export interface FixtureGraph {
  readonly fixtures: TestFixtures & { readonly session: SetupSession };
  readonly engine: LocatorEngine;
}

/** Builds the lazy fixture graph for one attempt. */
export function createFixtures(environment: AttemptEnvironment): FixtureGraph {
  const opened = environment.opened;
  const engine = new LocatorEngine({
    session: environment.driverSession,
    signal: environment.signal,
    runId: environment.runId,
    attemptId: environment.attemptId,
    actionTimeout: environment.config.actionTimeout,
    assertionTimeout: environment.config.assertionTimeout,
    testDeadline: environment.testDeadline,
    requireOpen: () => {
      if (!opened.value) {
        throw new TestError(
          'APP_NOT_OPEN',
          'no app page is open; call app.open() or web.goto() first',
        );
      }
    },
  });

  /**
   * Any resolved secret leaves the viewport pixel-tainted for the rest of the
   * attempt: an untrusted app may mirror the value anywhere on screen.
   */
  const taint = { value: false };

  const secrets: SecretResolver = {
    resolve(secret) {
      const credential = environment.config.credentials.get(secret.name);
      if (credential === undefined) {
        throw new ConfigurationError(
          'AUTH_CREDENTIAL_UNAVAILABLE',
          `credential "${secret.name}" is not configured`,
        );
      }
      taint.value = true;
      return credential.password;
    },
  };

  const screenContext: ScreenContext = {
    engine,
    steps: environment.steps,
    secrets,
    projectRoot: environment.config.projectRoot,
  };
  const screen = createScreen(screenContext);
  const app = createApp(environment, engine, opened);
  const web = createWeb(environment, engine, screenContext, opened);
  const device = createDevice(environment, engine);

  let agent: Agent | undefined;

  const fixtures: TestFixtures & { session: SetupSession } = {
    get agent(): Agent {
      agent ??= createAgent({
        engine,
        steps: environment.steps,
        models: createModelRouter(environment.config.agent, createModelAdapter),
        config: environment.config,
        priorSteps: environment.priorSteps,
        agentContext: joinAgentContext(
          environment.config.agent.context,
          environment.agentContext,
        ),
        secrets,
        secretValues: secretValues(environment),
        taint,
        artifacts: environment.artifacts,
        signal: environment.signal,
        cache: environment.cache,
        ...(environment.debug !== undefined ? { debug: environment.debug } : {}),
      });
      return agent;
    },
    app,
    screen,
    platform: environment.target.platform,
    web,
    device,
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

  return { fixtures, engine };
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

/** Registered secret values, used only for runner-side observation redaction. */
function secretValues(environment: AttemptEnvironment): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [name, credential] of environment.config.credentials) {
    values.set(name, credential.password);
  }
  return values;
}

function createApp(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  opened: { value: boolean },
): App {
  const { config, steps } = environment;
  const allowed = config.app.allowedOrigins;
  const base = config.app.base;

  /**
   * Resolves a navigation-ish argument for the target's platform family. A web
   * target resolves against its base URL under origin policy. A mobile target
   * has no base URL: an `http(s)` URL is still origin-checked, and a
   * custom-scheme deep link skips origin checking because it cannot leave the
   * device — but never the forbidden-scheme check.
   */
  const resolveTargetUrl = (value: string): string => {
    if (base !== undefined) return resolveNavigationUrl(value, base, allowed).url;
    return /^https?:/i.test(value)
      ? resolveNavigationUrl(value, undefined, allowed).url
      : assertDeviceUrlAllowed(value);
  };

  return {
    async open(openPath?: string): Promise<void> {
      await steps.run('app', 'app.open', openPath ?? '/', async () => {
        const resolved =
          openPath === undefined ? base?.href : resolveTargetUrl(openPath);
        await engine.session.app.open(resolved, engine.operation(config.timeout));
        opened.value = true;
      });
    },
    async restart(): Promise<void> {
      await steps.run('app', 'app.restart', '', async () => {
        await engine.session.app.restart(engine.operation(config.timeout));
        opened.value = true;
      });
    },
    async clearState(): Promise<void> {
      await steps.run('app', 'app.clearState', '', async () => {
        await engine.session.app.clearState(engine.operation(config.timeout));
        opened.value = true;
      });
    },
    async back(): Promise<void> {
      await steps.run('app', 'app.back', '', async () => {
        await engine.session.app.back(engine.operation());
      });
    },
    async deepLink(url: string): Promise<void> {
      await steps.run('app', 'app.deepLink', url, async () => {
        const resolved = resolveTargetUrl(url);
        await engine.session.app.deepLink(resolved, engine.operation(config.timeout));
        opened.value = true;
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

/**
 * Builds the `device` capability proxy. Every call is deadline-bounded and
 * step-recorded by the runner; the driver only performs the operation.
 */
function createDevice(environment: AttemptEnvironment, engine: LocatorEngine): Device {
  const { config, steps, target } = environment;

  const driverDevice = (): DriverDevice => {
    const device = engine.session.device;
    if (device === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `driver for target "${target.name}" does not provide the device capability`,
      );
    }
    return device;
  };

  return {
    get platform(): 'ios' | 'android' {
      if (target.platform !== 'ios' && target.platform !== 'android') {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `target "${target.name}" is not a mobile target`,
        );
      }
      return target.platform;
    },
    home: () => steps.run('device', 'device.home', '', () => driverDevice().home(engine.operation())),
    hideKeyboard: () =>
      steps.run('device', 'device.hideKeyboard', '', () =>
        driverDevice().hideKeyboard(engine.operation()),
      ),
    openUrl: (url) =>
      steps.run('device', 'device.openUrl', url, () => {
        // A device URL follows app deep-link policy: http(s) is origin-checked,
        // a custom scheme skips origin checking but not the scheme check.
        const resolved = /^https?:/i.test(url)
          ? resolveNavigationUrl(url, config.app.base, config.app.allowedOrigins).url
          : assertDeviceUrlAllowed(url);
        return driverDevice().openUrl(resolved, engine.operation(config.timeout));
      }),
    setLocation: (location) =>
      steps.run('device', 'device.setLocation', `${location.latitude},${location.longitude}`, () =>
        driverDevice().setLocation(location, engine.operation()),
      ),
    setPermission: (permission, state) =>
      steps.run('device', 'device.setPermission', `${permission}=${state}`, () =>
        driverDevice().setPermission(permission, state, engine.operation()),
      ),
    pushNotification: (payload) =>
      steps.run('device', 'device.pushNotification', '', () =>
        driverDevice().pushNotification(payload, engine.operation()),
      ),
  };
}

/**
 * Returns the base URL the web capability requires. It is resolved per call
 * rather than when the fixture is built, because every attempt builds the web
 * fixture eagerly while a mobile target never uses it.
 */
function requireWebBase(config: ResolvedConfig): NormalizedBaseUrl {
  const base = config.app.base;
  if (base === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'the web capability requires a configured app URL',
    );
  }
  return base;
}

function createWeb(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
  opened: { value: boolean },
): Web {
  const { config, steps } = environment;
  const allowed = config.app.allowedOrigins;
  // Lazy: a mobile attempt builds this fixture too, and must not fail merely
  // for having no base URL when no web method is ever called.
  const base = () => requireWebBase(config);

  const driverWeb = () => {
    const web = engine.session.web;
    if (web === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `driver for target "${environment.target.name}" does not provide the web capability`,
      );
    }
    return web;
  };

  const web: Web = {
    async goto(url, options): Promise<void> {
      await steps.run('web', 'web.goto', url, async () => {
        const resolved = resolveNavigationUrl(url, base(), allowed).url;
        await driverWeb().goto(resolved, options?.waitUntil, engine.operation(options?.timeout ?? config.timeout));
        opened.value = true;
      });
    },
    async reload(options): Promise<void> {
      await steps.run('web', 'web.reload', '', () =>
        driverWeb().reload(engine.operation(options?.timeout ?? config.timeout)),
      );
    },
    async back(options): Promise<void> {
      await steps.run('web', 'web.back', '', () =>
        driverWeb().back(engine.operation(options?.timeout ?? config.timeout)),
      );
    },
    async forward(options): Promise<void> {
      await steps.run('web', 'web.forward', '', () =>
        driverWeb().forward(engine.operation(options?.timeout ?? config.timeout)),
      );
    },
    async url(): Promise<string> {
      return driverWeb().url(engine.operation());
    },
    async title(): Promise<string> {
      return driverWeb().title(engine.operation());
    },
    async waitForURL(url, options): Promise<void> {
      const label = typeof url === 'string' ? url : String(url);
      await steps.run('web', 'web.waitForURL', label, async () => {
        const deadline = engine.deadline(options?.timeout ?? config.assertionTimeout);
        for (;;) {
          const current = await driverWeb().url(engine.operation());
          if (urlMatches(current, url, base())) return;
          if (deadline.expired()) {
            throw new TestError(
              'ASSERTION_FAILED',
              `waitForURL timed out; expected ${label}, current URL is ${current}`,
            );
          }
          await sleep(100, environment.signal);
        }
      });
    },
    locator(selector: string): Locator {
      return createLocator(screenContext, webSelectorExpression(selector));
    },
    frameLocator(selector: string): Screen {
      return createFrameScreen(screenContext, selector);
    },
    async evaluate<T extends JsonValue>(
      fn: string | ((arg?: never) => T | Promise<T>),
      arg?: JsonValue,
    ): Promise<T> {
      return steps.run('web', 'web.evaluate', '', async () => {
        const source = typeof fn === 'string' ? fn : fn.toString();
        validateJsonValue(arg, 'evaluate argument');
        const result = await driverWeb().evaluate<T>(source, arg, engine.operation());
        validateJsonValue(result, 'evaluate result');
        return result;
      });
    },
    async route(pattern, handler): Promise<void> {
      await steps.run('web', 'web.route', String(pattern), async () => {
        const wirePattern = toRoutePattern(pattern);
        await driverWeb().route(
          wirePattern,
          async (driverRoute: DriverWebRoute) => {
            let decided = false;
            const guard = (name: string) => {
              if (decided) {
                throw new TestError(
                  'ACTION_FAILED',
                  `route handler already decided; ${name} called twice`,
                );
              }
              decided = true;
            };
            const publicRoute: WebRoute = {
              request: driverRoute.request,
              fulfill: async (response) => {
                guard('fulfill');
                await driverRoute.fulfill(response, engine.operation());
              },
              continue: async () => {
                guard('continue');
                await driverRoute.continue(engine.operation());
              },
              abort: async () => {
                guard('abort');
                await driverRoute.abort(engine.operation());
              },
            };
            await handler(publicRoute);
            if (!decided) {
              await driverRoute.abort(engine.operation());
              throw new TestError(
                'ACTION_FAILED',
                'route handler returned without calling fulfill, continue, or abort',
              );
            }
          },
          engine.operation(),
        );
      });
    },
    async unroute(pattern): Promise<void> {
      await steps.run('web', 'web.unroute', String(pattern), () =>
        driverWeb().unroute(toRoutePattern(pattern), engine.operation()),
      );
    },
    async waitForResponse(pattern, options): Promise<WebResponse> {
      return steps.run('web', 'web.waitForResponse', String(pattern), async () => {
        const response = await driverWeb().waitForResponse(
          toRoutePattern(pattern),
          engine.operation(options?.timeout ?? config.actionTimeout),
        );
        const decoder = new TextDecoder();
        return {
          url: response.url,
          status: response.status,
          headers: response.headers,
          json: async <T = unknown>() => JSON.parse(decoder.decode(response.body)) as T,
          text: async () => decoder.decode(response.body),
        };
      });
    },
    async cookies(): Promise<Cookie[]> {
      const cookies = await driverWeb().cookies(engine.operation());
      return [...cookies];
    },
    async setCookies(cookies): Promise<void> {
      await steps.run('web', 'web.setCookies', `${cookies.length} cookie(s)`, async () => {
        for (const cookie of cookies) {
          const originSource =
            cookie.url ?? `${base().origin.startsWith('https') ? 'https' : 'http'}://${cookie.domain?.replace(/^\./, '')}`;
          let origin: string;
          try {
            origin = new URL(originSource).origin;
          } catch {
            throw new ConfigurationError('POLICY_DENIED', `invalid cookie target: ${originSource}`);
          }
          if (!allowed.includes(origin)) {
            throw new ConfigurationError(
              'POLICY_DENIED',
              `cookie origin ${origin} is not in allowedOrigins`,
            );
          }
        }
        await driverWeb().setCookies(cookies, engine.operation());
      });
    },
    async setViewport(size): Promise<void> {
      await steps.run('web', 'web.setViewport', `${size.width}x${size.height}`, async () => {
        await driverWeb().setViewport(size, engine.operation());
        const runtime = await engine.session.runtime(engine.operation());
        steps.attachViewport(runtime.viewport);
      });
    },
    async onDialog(handler): Promise<() => Promise<void>> {
      const wrapped =
        typeof handler === 'string'
          ? handler
          : async (driverDialog: DriverDialog) => {
              const publicDialog: Dialog = {
                message: driverDialog.message,
                accept: (text?: string) => driverDialog.accept(text, engine.operation()),
                dismiss: () => driverDialog.dismiss(engine.operation()),
              };
              await handler(publicDialog);
            };
      const id = await driverWeb().setDialogHandler(wrapped, engine.operation());
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        await driverWeb().removeDialogHandler(id, engine.operation());
      };
    },
    async waitForDownload(trigger, options): Promise<{ path: string; suggestedFilename: string }> {
      return steps.run('web', 'web.waitForDownload', '', async () => {
        const timeout = options?.timeout ?? config.actionTimeout;
        const id = await driverWeb().beginDownload(engine.operation(timeout));
        try {
          await trigger();
          const result = await withTimeout(
            driverWeb().finishDownload(id, engine.operation(timeout)),
            timeout,
            () => new TestError('ACTION_FAILED', 'download did not complete in time'),
          );
          environment.steps.attachArtifact(environment.artifacts.register('download', result.path));
          return result;
        } catch (cause) {
          await driverWeb().cancelDownload(id, engine.operation()).catch(() => undefined);
          throw cause;
        }
      });
    },
    keyboard: {
      press: (key: string) =>
        steps.run('web', 'web.keyboard.press', key, () =>
          driverWeb().keyboardPress(key, engine.operation()),
        ),
      type: (text: string) =>
        steps.run('web', 'web.keyboard.type', `${text.length} chars`, () =>
          driverWeb().keyboardType(text, engine.operation()),
        ),
    },
    mouse: {
      move: (x: number, y: number) =>
        steps.run('web', 'web.mouse.move', `${x},${y}`, () =>
          driverWeb().mouseMove(x, y, engine.operation()),
        ),
      wheel: (deltaX: number, deltaY: number) =>
        steps.run('web', 'web.mouse.wheel', `${deltaX},${deltaY}`, () =>
          driverWeb().mouseWheel(deltaX, deltaY, engine.operation()),
        ),
      down: () =>
        steps.run('web', 'web.mouse.down', '', () => driverWeb().mouseDown(engine.operation())),
      up: () => steps.run('web', 'web.mouse.up', '', () => driverWeb().mouseUp(engine.operation())),
    },
  };

  registerWebExpectTarget(web, {
    // Resolved here: registration happens only for an attempt that has a web
    // capability, and a web target always has a base URL.
    get base() {
      return base();
    },
    assertionTimeout: config.assertionTimeout,
    signal: environment.signal,
    url: () => driverWeb().url(engine.operation()),
    title: () => driverWeb().title(engine.operation()),
    runStep: (api, label, body) => steps.run('assertion', api, label, body),
  });

  return web;
}

function validateJsonValue(value: unknown, label: string): void {
  if (value === undefined) return;
  const seen = new Set<unknown>();
  const visit = (item: unknown): void => {
    if (item === null) return;
    switch (typeof item) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(item)) {
          throw new TestError('INVALID_ARGUMENT', `${label} contains a non-finite number`);
        }
        return;
      case 'object': {
        if (isSecret(item)) {
          throw new ConfigurationError('POLICY_DENIED', `${label} must not contain a Secret`);
        }
        if (seen.has(item)) {
          throw new TestError('INVALID_ARGUMENT', `${label} contains a cycle`);
        }
        seen.add(item);
        if (Array.isArray(item)) {
          for (const entry of item) visit(entry);
          return;
        }
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
          throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe`);
        }
        for (const entry of Object.values(item)) visit(entry);
        return;
      }
      default:
        throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe, found ${typeof item}`);
    }
  };
  visit(value);
}
