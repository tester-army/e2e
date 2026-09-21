/**
 * The links `device.openLink` takes: the scheme rule the runner applies to
 * every navigation, and the label a link enters the report under.
 *
 * The runner's own rule (`resolveNavigationUrl`, reached by a fixture as
 * `context.app.resolveUrl`) first demands an app URL, which a device engine
 * never declares, so the same small check lives here rather than behind a
 * gate that would refuse every link.
 */

import { ConfigurationError, TestError } from 'e2e/engine';

const FORBIDDEN_PROTOCOLS = new Set(['file:', 'data:', 'javascript:']);

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
  if (FORBIDDEN_PROTOCOLS.has(url.protocol)) {
    throw new ConfigurationError('POLICY_DENIED', `forbidden URL scheme: ${url.protocol}`);
  }
  return url;
}

/**
 * The link as the report shows it, cut before its query and fragment. A
 * magic link carries its one-time token there, and a step label is kept for
 * as long as the report is.
 */
export function linkLabel(input: string): string {
  return input.replace(/[?#][\s\S]*$/, '');
}
