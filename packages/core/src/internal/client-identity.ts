/** How e2e names itself to the vendors it calls. */

import { packageVersion } from './package-version.ts';

/** `e2e/<version> (<platform>; <arch>)`: what every vendor request identifies as. Never another client's name. */
export const USER_AGENT = `e2e/${packageVersion(import.meta.url, '../../package.json', '0.0.0')} (${process.platform}; ${process.arch})`;

/**
 * Sent with every model call, whichever provider serves it. The AI SDK appends
 * its own user agent after ours; `http-referer` and `x-title` are the app
 * attribution the Vercel AI Gateway and OpenRouter read, and others ignore.
 */
export const MODEL_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': USER_AGENT,
  'http-referer': 'https://tester.army/e2e',
  'x-title': 'e2e',
};
