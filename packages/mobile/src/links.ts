/**
 * The links `device.openLink` takes: the scheme rule the runner applies to
 * every navigation, the label a link enters the report under, and the guard
 * that keeps a link out of `device.openApp`.
 *
 * The runner's own rule (`resolveNavigationUrl`, reached by a fixture as
 * `context.app.resolveUrl`) first demands an app URL, which a device engine
 * never declares, and admits http(s) alone, where a device link is any app's
 * custom scheme. So the check here is a list of refused schemes: the ones
 * that read local content or inline a document, and the browser wrappers
 * (`view-source:file:...`, `blob:`, `filesystem:`) that carry one inside.
 */

import { ConfigurationError, TestError } from 'e2e/engine';

const FORBIDDEN_PROTOCOLS = new Set(['file:', 'data:', 'javascript:', 'view-source:', 'blob:', 'filesystem:']);

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
 * is `INVALID_ARGUMENT`; a `file:`, `data:`, `javascript:`, `view-source:`,
 * `blob:`, or `filesystem:` link is `POLICY_DENIED`, as it is for `app.open`
 * on the web. The message never echoes the input: a malformed link can carry
 * a magic-link token in its query, path, or userinfo, and nothing about a
 * string that failed to parse says which part is safe to repeat.
 */
export function linkTarget(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TestError(
      'INVALID_ARGUMENT',
      'openLink needs an absolute URL such as myapp://orders/42 or https://example.com/verify',
    );
  }
  denyForbiddenScheme(url.protocol);
  return url;
}

/**
 * Refuses a link handed to `openApp`, which opens an app by bundle id,
 * package, or display name. agent-device opens any `scheme:rest` string as
 * a URL, so the check runs before the device sees it: a link with a
 * forbidden scheme is `POLICY_DENIED` as it is for `openLink`, any
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

/** What the report shows for a link that did not parse, or an app id that looks like a link. */
const LINK_PLACEHOLDER = '<link>';

/**
 * The link as the report shows it: parsed with the parser `openLink` opens
 * it with, then without its userinfo, query, or fragment, any of which may
 * carry a credential (a magic link's one-time token, a `user:password@`
 * login), as `printableUrl` does on the web. A step label is kept for as long
 * as the report is. A string that fails to parse is never echoed, as
 * `linkTarget` never echoes it, and the label is a placeholder.
 */
export function linkLabel(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return LINK_PLACEHOLDER;
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * The label of an `openApp` step: the app id as it is. `assertAppId` refuses
 * a link, but the step is labeled before it runs, so a string shaped like a
 * link gets the placeholder instead of whatever userinfo it carries.
 */
export function appLabel(app: string): string {
  return isLink(app) ? LINK_PLACEHOLDER : app;
}
