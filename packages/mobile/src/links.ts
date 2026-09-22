/**
 * The links `device.openLink` takes: the scheme rule the runner applies to
 * every navigation, the label a link enters the report under, and the guard
 * that keeps a link out of `device.openApp`.
 *
 * The runner's own rule (`resolveNavigationUrl`, reached by a fixture as
 * `context.app.resolveUrl`) first demands an app URL, which a device engine
 * never declares, so the same small check lives here rather than behind a
 * gate that would refuse every link.
 */

import { ConfigurationError, TestError } from 'e2e/engine';

const FORBIDDEN_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

/**
 * What agent-device opens as a URL instead of resolving as an app: a
 * `scheme:rest` string with no whitespace. Every string the device would
 * route as a link matches; a display name with a space (`Notes: Pro`) does
 * not.
 */
const LINK_SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\S+$/;

/** Whether agent-device would open this string as a URL rather than resolve it as an app. */
export function isLink(value: string): boolean {
  return LINK_SHAPE.test(value.trim());
}

function denyForbiddenScheme(protocol: string): void {
  if (FORBIDDEN_PROTOCOLS.has(protocol)) {
    throw new ConfigurationError('POLICY_DENIED', `forbidden URL scheme: ${protocol}`);
  }
}

/**
 * Parses a link a test asked to open. A string that is not an absolute URL
 * is `INVALID_ARGUMENT`; a `file:`, `data:`, or `javascript:` link is
 * `POLICY_DENIED`, as it is for `app.open` on the web.
 */
export function linkTarget(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TestError(
      'INVALID_ARGUMENT',
      `openLink needs an absolute URL such as myapp://orders/42 or https://example.com/verify, got "${input}"`,
    );
  }
  denyForbiddenScheme(url.protocol);
  return url;
}

/**
 * Refuses a link handed to `openApp`, which opens an app by bundle id,
 * package, or display name. agent-device opens any `scheme:rest` string as
 * a URL, so the check runs before the device sees it: a `file:`, `data:`,
 * or `javascript:` link is `POLICY_DENIED` as it is for `openLink`, any
 * other link is `INVALID_ARGUMENT` pointing at `openLink`. The message
 * never echoes the link, whose query may carry a magic-link token.
 */
export function assertAppId(app: string): void {
  const link = LINK_SHAPE.exec(app.trim());
  if (link === null) return;
  denyForbiddenScheme(`${(link[1] ?? '').toLowerCase()}:`);
  throw new TestError(
    'INVALID_ARGUMENT',
    'openApp opens an app by bundle id, package, or display name; open a deep link or web link with device.openLink',
  );
}

/**
 * Refuses a link in the engine's `app` option, which the pool opens on every
 * device in `prepare`, before any attempt's `openApp` would. Config is the
 * project's own code, so a link there is a mistake, not a policy breach:
 * `INVALID_CONFIG` whatever the scheme, pointing at `device.openLink`.
 */
export function assertConfiguredApp(app: string | undefined): void {
  if (app === undefined || !isLink(app)) return;
  throw new ConfigurationError(
    'INVALID_CONFIG',
    'mobile: `app` names an app by bundle id, package, or display name, not a link; a test opens a deep link or web link with device.openLink',
  );
}

/**
 * The link as the report shows it, cut before its query and fragment. A
 * magic link carries its one-time token there, and a step label is kept for
 * as long as the report is.
 */
export function linkLabel(input: string): string {
  return input.replace(/[?#][\s\S]*$/, '');
}
