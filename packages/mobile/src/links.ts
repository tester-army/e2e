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

/**
 * The link as the report shows it: without its userinfo, query, or fragment,
 * any of which may carry a credential (a magic link's one-time token, a
 * `user:password@` login), as `printableUrl` does on the web. A step label is
 * kept for as long as the report is. Takes any string, since `openApp` labels
 * a bundle id the same way, and never throws: userinfo goes only from a
 * `scheme://user@host` authority (`URL` also reads `https:/` and backslashes
 * as one), so `com.example.app` and `mailto:` addresses stay as they are.
 */
export function linkLabel(input: string): string {
  return input.replace(/[?#][\s\S]*$/, '').replace(USERINFO, '$1');
}

/** A link's scheme and slashes, then the userinfo up to its last `@` before the path. */
const USERINFO = /^(\s*[A-Za-z][A-Za-z0-9+.-]*:[\\/]+)[^/\\]*@/;
