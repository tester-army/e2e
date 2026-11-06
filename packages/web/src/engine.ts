/**
 * The web engine for e2e: a browser driven over WebDriver BiDi, built with
 * the public `defineEngine`, validated by the same rules and graded by the
 * same capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `e2e/engine` and contributes the `browser`
 * fixture the way a device engine contributes `device`.
 */

import {
  ConfigurationError,
  defineEngine,
  type AppPermissionState,
  isSecret,
  obj,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  rejectUnknownKeys,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
} from 'e2e/engine';
import { createRequire } from 'node:module';
import { asBrowserProvider, LeasedBrowsers } from './provider.ts';
import { DEFAULT_VIEWPORT, MEDIA_KEYS, mediaProblem, type WebOptions } from './options.ts';
import { BidiSurface } from './driver/surface.ts';
import { cdpSource, launchSource, leaseSource, type BrowserSource } from './driver/browser-source.ts';
import type { Browser } from './fixture/types.ts';
import { createBrowserFixture } from './fixture/browser.ts';
import { ConfiguredInitScripts, validateInitScripts } from './init-scripts.ts';
import { FIELD_VALUE_CONTROL, headerProblem } from './protected-app.ts';
import { BROWSER_TRAITS, isBrowserName, type BrowserName } from './browsers.ts';

/** App fields only a device target reads. */
const NATIVE_APP_KEYS = ['bundleId', 'appPath', 'launchArguments'] as const;

export function web(options: WebOptions = {}): EngineHandle<{ browser: Browser }> {
  return createWeb(options);
}

/**
 * The web engine for `options`, its browser from `attachTo` when given:
 * `attachBrowser`'s source, whose attempt drives the tab already open in the
 * browser's own user context and leaves both behind, so the target needs no
 * `app.url`. Otherwise the browser comes from what `options` name.
 */
export function createWeb(options: WebOptions, attachTo?: BrowserSource): EngineHandle<{ browser: Browser }> {
  if ('allowedOrigins' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'web({ allowedOrigins }) is gone: navigation and secret fills are not gated by origin; remove the option',
    );
  }
  if ('video' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "web({ video }) was renamed web({ screencast }): it takes { size?, quality? } for the page screencast; which attempts record is the video mode on the config or a target",
    );
  }
  rejectUnknownKeys('web()', options, WEB_OPTION_KEYS);
  const provider = typeof options.browser === 'object' && options.browser !== null ? asBrowserProvider(options.browser) : undefined;
  if (provider !== undefined && options.connect !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ browser, connect }) names two browser sources; browser provider "${provider.name}" leases its own browsers, so remove connect`,
    );
  }
  if (options.connect !== undefined) validateConnect(options.connect);
  if (options.connect !== undefined && typeof options.browser === 'string' && !(isBrowserName(options.browser) && BROWSER_TRAITS[options.browser].cdp)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect }) requires the chromium browser; CDP attach is chromium-only, got "${options.browser}"`,
    );
  }
  if (options.headers !== undefined) validateHeaders(options.headers);
  if (options.basicAuth !== undefined) validateBasicAuth(options.basicAuth);
  if (options.testIdAttribute !== undefined) validateTestIdAttribute(options.testIdAttribute);
  if (options.userAgent !== undefined) validateUserAgent(options.userAgent, options.headers);
  if (options.locale !== undefined) validateLocale(options.locale, options.headers);
  if (options.timezoneId !== undefined) validateTimezoneId(options.timezoneId);
  validateMedia(options);
  if (options.initScripts !== undefined) validateInitScripts(options.initScripts);
  if (options.screencast !== undefined) validateScreencast(options.screencast);
  const browser: unknown = provider === undefined ? options.browser ?? 'chromium' : 'chromium';
  if (typeof browser !== 'string' || !isBrowserName(browser)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ browser }) drives chromium or firefox over WebDriver BiDi, got ${JSON.stringify(browser)}`);
  }
  const media = obj({ colorScheme: options.colorScheme, reducedMotion: options.reducedMotion });
  const source = attachTo
    ?? (provider !== undefined ? leaseSource(new LeasedBrowsers(provider)) : options.connect !== undefined ? cdpSource('connect', options.connect.cdpEndpoint) : launchSource(browser, media));
  // Clearing state and saved sessions replace the user context, which only an attempt in a fresh one may do.
  const ownsContext = source.userContext === 'fresh';
  const surface = new BidiSurface({
    viewport: options.viewport === undefined ? DEFAULT_VIEWPORT : options.viewport,
    testIdAttribute: options.testIdAttribute ?? 'data-testid',
    initScripts: new ConfiguredInitScripts(options.initScripts ?? []),
    screencast: options.screencast ?? {},
    headers: options.headers,
    basicAuth: options.basicAuth,
    userAgent: options.userAgent,
    locale: options.locale,
    timezoneId: options.timezoneId,
    media,
    source,
  });
  return defineEngine({
    name: 'web',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'web',
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    doctor: (info) => surface.doctor(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    settleAttempt: (context) => surface.settleAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    // A browser honors every action kind of the contract.
    actions: LOCATOR_ACTION_KINDS,
    // The click holds each modifier.
    tapModifiers: true,
    // A page takes every pointer action of the contract at a bare point too.
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: POINTER_ACTION_KINDS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressKey(key, operation),
    },
    validateApp: (app, info) => validateApp(app, info, browser, source.userContext !== 'adopt-tab'),
    ...(isSecret(options.basicAuth?.password) ? { secrets: [options.basicAuth.password] } : {}),
    session: {
      open: (url, operation) => surface.open(url, operation),
      back: (operation) => surface.back(operation),
      resize: (size, operation) => surface.resize(size, operation),
      restart: (operation) => surface.restart(operation),
      reset: ownsContext ? (operation) => surface.reset(operation) : () => Promise.reject(defaultContextLimit('app.clearState()', source)),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    ...(ownsContext
      ? {
          state: {
            capture: (operation) => surface.captureState(operation),
            restore: (state, operation) => surface.restoreState(state, operation),
          },
        }
      : {}),
    fixtures: {
      browser: (context) => createBrowserFixture(surface, context),
    },
  });
}

/** Every option `web()` takes, kept equal to `WebOptions` by the compiler. */
const WEB_OPTION_KEYS: readonly string[] = Object.keys({
  browser: true,
  viewport: true,
  screencast: true,
  connect: true,
  headers: true,
  basicAuth: true,
  testIdAttribute: true,
  userAgent: true,
  locale: true,
  timezoneId: true,
  colorScheme: true,
  reducedMotion: true,
  initScripts: true,
} satisfies Record<keyof WebOptions, true>);

/**
 * What riding the browser's own context rules out, named with its cause:
 * `what` replaces the browser context, which a per-attempt lease and
 * `attachBrowser` both ride.
 */
function defaultContextLimit(what: string, source: BrowserSource): ConfigurationError {
  if (source.kind !== 'lease') {
    return new ConfigurationError('UNSUPPORTED_CAPABILITY', `${what} is unavailable on an attached browser: it replaces the browser context, and the attach drives the browser's own`);
  }
  return new ConfigurationError(
    'UNSUPPORTED_CAPABILITY',
    `${what} is unavailable with browser provider "${source.leases.name}" with scope "attempt": it replaces the browser context, and the attempt rides the leased browser's own; every attempt already starts on a fresh browser, and scope "worker" can clear one mid-test`,
  );
}

/** True for a plain object; the shape both options take. Config runs as JavaScript, so the types alone are no guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names a value's kind for a config error without echoing it: a CDP URL can carry a session token. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}

/**
 * `cdpEndpoint` is the resolver `connect` attaches through. Without it the
 * attach would call an undefined resolver, so a config missing it fails
 * here, at load, instead of at worker init with `ENGINE_FAILURE: ... resolve
 * is not a function`. Any other key, a removed `reconnectEndpoint` included,
 * is refused.
 */
function validateConnect(connect: unknown): void {
  if (!isRecord(connect)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect }) must be a plain object: { cdpEndpoint }, got ${kindOf(connect)}`);
  }
  rejectUnknownKeys('web({ connect })', connect, ['cdpEndpoint']);
  const { cdpEndpoint } = connect;
  if (cdpEndpoint === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ connect }) requires cdpEndpoint, the resolver that provisions the browser: (signal) => url');
  }
  if (typeof cdpEndpoint !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect: { cdpEndpoint } }) must be a resolver function (signal) => url, got ${kindOf(cdpEndpoint)}`);
  }
}

/**
 * Refuses a header the browser could not send, at config load rather than at
 * the first request: a name outside the token grammar, a value carrying a
 * control character (a line break is a header-injection vector), or a value
 * that is not a string at all.
 */
function validateHeaders(headers: unknown): void {
  if (!isRecord(headers)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ headers }) must be an object of header name to value');
  }
  for (const [name, value] of Object.entries(headers)) {
    const problem = headerProblem(name, value);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ headers }) ${problem}`);
  }
}

/** Refuses credentials the browser could not present: a missing field, or a `:` in the user name (RFC 7617). */
function validateBasicAuth(basicAuth: unknown): void {
  if (!isRecord(basicAuth)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) must be an object with username and password');
  }
  rejectUnknownKeys('web({ basicAuth })', basicAuth, ['username', 'password']);
  const { username, password } = basicAuth;
  if (typeof username !== 'string' || username === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a non-empty username string');
  }
  if (username.includes(':')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) username must not contain ":"');
  }
  if (typeof password !== 'string' && !isSecret(password)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a password string or secrets.get(name)');
  }
}

/**
 * Refuses a user agent the browser could not send (not a string, empty, or
 * carrying a control character) and one a `user-agent` header would override
 * on the app's site while `navigator.userAgent` kept reporting it.
 */
function validateUserAgent(userAgent: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof userAgent !== 'string' || userAgent === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must be a non-empty string');
  }
  if (FIELD_VALUE_CONTROL.test(userAgent)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must not contain a control character');
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) and a user-agent header in web({ headers }) conflict; set userAgent only');
  }
}

/**
 * Refuses a locale that is not a BCP 47 tag, and one an `accept-language`
 * header would override on the app's site while `navigator.language` kept
 * reporting it.
 */
function validateLocale(locale: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof locale !== 'string' || locale === '' || !isLanguageTag(locale)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ locale }) must be a BCP 47 language tag such as "de-DE", got ${JSON.stringify(locale)}`);
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'accept-language')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ locale }) and an accept-language header in web({ headers }) conflict; set locale only');
  }
}

/**
 * True when `tag` names a language the browser can run in: a Unicode locale
 * `Intl.Locale` parses, other than the undetermined `und`, which Chromium
 * refuses at context creation as it does a private-use-only tag.
 */
function isLanguageTag(tag: string): boolean {
  try {
    const { language } = new Intl.Locale(tag);
    return language !== undefined && language !== 'und';
  } catch {
    return false;
  }
}

/**
 * Refuses, at config load, a time zone the browser would otherwise refuse at
 * the first context. Best effort: Node cannot tell a miscased alias
 * (`us/eastern`) from the real one, so the browser's own `Invalid timezone ID`
 * stays the final word.
 */
function validateTimezoneId(timezoneId: unknown): void {
  if (typeof timezoneId !== 'string' || timezoneId === '' || !isTimeZone(timezoneId)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ timezoneId }) must be an IANA time zone such as "Europe/Berlin", got ${JSON.stringify(timezoneId)}`);
  }
}

/**
 * Refuses a media feature value the browser does not emulate, at config load
 * rather than at the first page. A persistent context takes these too: they
 * are set on each page, not only on a context the engine creates.
 */
function validateMedia(options: WebOptions): void {
  for (const key of MEDIA_KEYS) {
    const problem = mediaProblem((name) => `web({ ${name} })`, key, options[key]);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', problem);
  }
}

/**
 * True when `timeZone` is an IANA name `Intl` resolves, spelled with its own
 * case. Node also takes an offset (`+01:00`) and any casing (`europe/berlin`),
 * both of which Chromium refuses; an alias resolving to another name
 * (`US/Eastern`) is fine.
 */
function isTimeZone(timeZone: string): boolean {
  if (/^[+-]/.test(timeZone)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    return resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match nothing
 * and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** `web({ screencast })`: a whole-pixel frame size and a 0-100 JPEG quality, each optional. */
function validateScreencast(screencast: unknown): void {
  if (!isPlainObject(screencast)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast }) must be a plain object: { size?, quality? }');
  }
  for (const key of Object.keys(screencast as object)) {
    if (key !== 'size' && key !== 'quality') {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast }) has unknown key "${key}"; it is { size?, quality? }, and which attempts record is the config's video`);
    }
  }
  const { size, quality } = screencast as { size?: unknown; quality?: unknown };
  if (size !== undefined) {
    const fields = isPlainObject(size) ? size : {};
    const { width, height } = fields as { width?: unknown; height?: unknown };
    const unknownKey = Object.keys(fields).find((key) => key !== 'width' && key !== 'height');
    if (unknownKey !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast: { size } }) has unknown key "${unknownKey}"; it is { width, height }`);
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
      throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { size } }) must be { width, height } in whole pixels, each at least 1');
    }
  }
  if (quality !== undefined && (!Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { quality } }) must be an integer from 0 through 100');
  }
}

/** An object literal (or `Object.create(null)`): not an array, a class instance, or a primitive. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Refuses a test-id attribute no element could carry, at config load. */
function validateTestIdAttribute(attribute: unknown): void {
  if (typeof attribute !== 'string' || !ATTRIBUTE_NAME.test(attribute)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(attribute)}`,
    );
  }
}

/**
 * A browser target opens a URL: without `app.url` there is nothing for
 * `app.open()` to open, and the fields that describe an installed device app
 * have nothing to act on here. `permissions` must be ones `browser` grants.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo, browser: BrowserName, urlRequired: boolean): void {
  for (const key of NATIVE_APP_KEYS) {
    if (app[key] !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${targetName}" declares app.${key}, which describes an installed device app; a web() target opens app.url`,
      );
    }
  }
  if (urlRequired && app.url === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${targetName}" needs app.url: a web() target opens the app at a URL, targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }]`,
    );
  }
  if (app.permissions !== undefined) validatePermissions(targetName, browser, app.permissions);
}

/**
 * Refuses a permission `browser` cannot grant, and any state but `grant`:
 * the engine only grants, and Chromium denies every permission a grant
 * leaves out, so neither `deny` nor `reset` can mean what it does on a
 * device. The harness has checked the map's shape and states already.
 */
function validatePermissions(targetName: string, browser: BrowserName, permissions: Readonly<Record<string, AppPermissionState>>): void {
  const where = `target "${targetName}" app.permissions`;
  rejectUnknownKeys(`${where} on ${browser}`, permissions, BROWSER_TRAITS[browser].permissions);
  for (const [name, state] of Object.entries(permissions)) {
    if (state !== 'grant') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where}.${name} is ${state}, but a web() target only grants; leave the permission out instead`,
      );
    }
  }
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
