/**
 * Pass-through of Playwright's own browser configuration: the options of
 * `browser.newContext` and `browserType.launch` a project needs that the
 * engine has no opinion on (locale, time zone, color scheme, device
 * emulation, a Chrome channel, certificate errors). The engine keeps the
 * keys its own bookkeeping depends on; those are refused at config load with
 * the engine option that replaces them.
 */

import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import { ConfigurationError, type ViewportSize } from 'e2e/engine';
import type { BrowserName } from './browser-connection.ts';

/** The context keys the engine sets itself, each with the option that stands in for it. */
const RESERVED_CONTEXT_KEYS: Readonly<Record<string, string>> = {
  acceptDownloads: 'the engine turns downloads on for web.waitForDownload',
  httpCredentials: 'use web({ basicAuth })',
  recordVideo: 'use e2e run --video',
};

/** The launch keys the engine sets itself, each with the option that stands in for it. */
const RESERVED_LAUNCH_KEYS: Readonly<Record<string, string>> = {
  headless: 'use e2e run --headed',
};

/**
 * Options handed to `browser.newContext` for every context an attempt opens.
 * `viewport` is the same setting as `web({ viewport })`, so a device
 * descriptor spreads in whole; `null` (no fixed viewport) is refused because
 * screenshots and recordings are sized by it.
 */
export type WebContextOptions = Omit<
  BrowserContextOptions,
  'acceptDownloads' | 'httpCredentials' | 'recordVideo' | 'viewport'
> & {
  readonly viewport?: ViewportSize;
};

/** Options handed to `browserType.launch` for the worker's local browser. */
export type WebLaunchOptions = Omit<LaunchOptions, 'headless'>;

/** True for a plain object; the shape every option record takes. Config runs as JavaScript, so the types alone are no guard. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a positive-dimension viewport. */
function isViewport(value: unknown): value is ViewportSize {
  return (
    isRecord(value) &&
    typeof value['width'] === 'number' &&
    typeof value['height'] === 'number' &&
    value['width'] > 0 &&
    value['height'] > 0
  );
}

/**
 * Refuses a `context` the engine could not honour: not an object, a key the
 * engine owns, a `null` viewport, a viewport that disagrees with
 * `web({ viewport })`, or a service-worker policy that would undo the
 * block `headers` depends on.
 */
export function validateContextOptions(
  context: unknown,
  options: { readonly viewport?: ViewportSize | undefined; readonly headers?: unknown },
): void {
  if (!isRecord(context)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ context }) must be an object of Playwright context options');
  }
  for (const [key, replacement] of Object.entries(RESERVED_CONTEXT_KEYS)) {
    if (key in context) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ context }) cannot set "${key}": ${replacement}`);
    }
  }
  if ('viewport' in context) {
    const viewport = context['viewport'];
    if (viewport === null) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'web({ context }) cannot set viewport to null: screenshots and recordings need a fixed viewport',
      );
    }
    if (!isViewport(viewport)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'web({ context }) viewport must be { width, height } with positive dimensions',
      );
    }
    if (options.viewport !== undefined && !sameViewport(options.viewport, viewport)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        'web({ viewport }) and web({ context: { viewport } }) are one setting and disagree; set one of them',
      );
    }
  }
  if (options.headers !== undefined && 'serviceWorkers' in context && context['serviceWorkers'] !== 'block') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'web({ context }) cannot allow service workers together with headers: a worker\'s requests bypass the header route',
    );
  }
}

/**
 * Refuses a `launch` the engine could not honour: not an object, `headless`
 * (the run's `--headed` flag owns it), or a channel on a browser other than
 * chromium, since only chromium has release channels.
 */
export function validateLaunchOptions(launch: unknown, browser: BrowserName): void {
  if (!isRecord(launch)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ launch }) must be an object of Playwright launch options');
  }
  for (const [key, replacement] of Object.entries(RESERVED_LAUNCH_KEYS)) {
    if (key in launch) {
      throw new ConfigurationError('INVALID_CONFIG', `web({ launch }) cannot set "${key}": ${replacement}`);
    }
  }
  if (launch['channel'] !== undefined && browser !== 'chromium') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ launch: { channel } }) requires the chromium browser; release channels are chromium-only, got "${browser}"`,
    );
  }
}

/** The one viewport of the attempt: the engine option, else the context's, else the default. */
export function resolveViewport(
  viewport: ViewportSize | undefined,
  context: WebContextOptions | undefined,
  fallback: ViewportSize,
): ViewportSize {
  return viewport ?? context?.viewport ?? fallback;
}

/**
 * True when a launch names its own executable, so the engine's first-run
 * install of the Playwright-managed browser would fetch a binary that is
 * never launched. `channel: 'chromium'` is the exception: it selects the
 * managed chromium build that `playwright install` provides.
 */
export function bringsOwnExecutable(launch: WebLaunchOptions | undefined): boolean {
  if (launch === undefined) return false;
  return launch.executablePath !== undefined || (launch.channel !== undefined && launch.channel !== 'chromium');
}

function sameViewport(a: ViewportSize, b: ViewportSize): boolean {
  return a.width === b.width && a.height === b.height;
}
