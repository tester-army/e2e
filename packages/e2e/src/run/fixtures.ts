/** Attempt-scoped fixture graph (spec 02-test-api.md, 08-platforms.md). */

import type { DriverSession, DriverWebRoute } from '../driver/index.js';
import { registerWebExpectTarget } from '../expect/index.js';
import { ConfigurationError, TestError } from '../internal/errors.js';
import { toRoutePattern } from '../internal/route-pattern.js';
import { resolveNavigationUrl } from '../internal/urls.js';
import { Deadline, sleep, withTimeout } from '../internal/time.js';
import { LocatorEngine } from '../locator/engine.js';
import { webSelectorExpression } from '../locator/expression.js';
import {
  createFrameScreen,
  createLocator,
  createScreen,
  isSecret,
  type ScreenContext,
  type SecretResolver,
} from '../locator/screen.js';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.js';
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
} from '../types.js';
import type { StepRecorder } from './steps.js';

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
  readonly testDeadline: Deadline;
  readonly artifacts: ArtifactSink;
  readonly saveSession?: (name: string) => Promise<void>;
}

export interface FixtureGraph {
  readonly fixtures: TestFixtures & { readonly session: SetupSession };
  readonly engine: LocatorEngine;
}

/** Builds the lazy fixture graph for one attempt. */
export function createFixtures(environment: AttemptEnvironment): FixtureGraph {
  const opened = { value: false };
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

  const secrets: SecretResolver = {
    resolve(secret) {
      const credential = environment.config.credentials.get(secret.name);
      if (credential === undefined) {
        throw new ConfigurationError(
          'AUTH_CREDENTIAL_UNAVAILABLE',
          `credential "${secret.name}" is not configured`,
        );
      }
      return credential.password;
    },
  };

  const screenContext: ScreenContext = { engine, steps: environment.steps, secrets };
  const screen = createScreen(screenContext);
  const app = createApp(environment, engine, opened);
  const web = createWeb(environment, engine, screenContext, opened);

  const fixtures: TestFixtures & { session: SetupSession } = {
    get agent(): Agent {
      throw new ConfigurationError(
        'MODEL_UNAVAILABLE',
        'the agent fixture requires model configuration (agent.model or E2E_MODEL); agentic execution is not implemented yet',
      );
    },
    app,
    screen,
    platform: environment.target.platform,
    web,
    get device(): Device {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        'the device fixture is reserved for future mobile profiles; web-0.1 does not provide it',
      );
    },
    session: {
      save: async (name: string) => {
        if (environment.saveSession === undefined) {
          throw new ConfigurationError(
            'INVALID_CONFIG',
            'session.save() is only available inside setup tests',
          );
        }
        await environment.steps.run('session', 'session.save', name, () =>
          environment.saveSession!(name),
        );
      },
    },
  };

  return { fixtures, engine };
}

function createApp(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  opened: { value: boolean },
): App {
  const { config, steps } = environment;
  const allowed = config.app.allowedOrigins;

  return {
    async open(openPath?: string): Promise<void> {
      await steps.run('app', 'app.open', openPath ?? '/', async () => {
        const resolved =
          openPath === undefined
            ? config.app.base.href
            : resolveNavigationUrl(openPath, config.app.base, allowed).url;
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
        const resolved = resolveNavigationUrl(url, config.app.base, allowed).url;
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

function createWeb(
  environment: AttemptEnvironment,
  engine: LocatorEngine,
  screenContext: ScreenContext,
  opened: { value: boolean },
): Web {
  const { config, steps } = environment;
  const allowed = config.app.allowedOrigins;

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
        const resolved = resolveNavigationUrl(url, config.app.base, allowed).url;
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
        const { urlMatches } = await import('../internal/urls.js');
        const deadline = engine.deadline(options?.timeout ?? config.assertionTimeout);
        for (;;) {
          const current = await driverWeb().url(engine.operation());
          if (urlMatches(current, url, config.app.base)) return;
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
            cookie.url ?? `${config.app.base.origin.startsWith('https') ? 'https' : 'http'}://${cookie.domain?.replace(/^\./, '')}`;
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
      await steps.run('web', 'web.setViewport', `${size.width}x${size.height}`, () =>
        driverWeb().setViewport(size, engine.operation()),
      );
    },
    async onDialog(handler): Promise<() => Promise<void>> {
      const wrapped =
        typeof handler === 'string'
          ? handler
          : async (driverDialog: { message: string; accept(text: string | undefined, operation: unknown): Promise<void>; dismiss(operation: unknown): Promise<void> }) => {
              const publicDialog: Dialog = {
                message: driverDialog.message,
                accept: (text?: string) => driverDialog.accept(text, engine.operation()),
                dismiss: () => driverDialog.dismiss(engine.operation()),
              };
              await handler(publicDialog);
            };
      const id = await driverWeb().setDialogHandler(
        wrapped as Parameters<ReturnType<typeof driverWeb>['setDialogHandler']>[0],
        engine.operation(),
      );
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
    base: config.app.base,
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


