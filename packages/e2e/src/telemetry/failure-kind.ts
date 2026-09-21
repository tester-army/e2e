/**
 * What kind of failure hides behind a code that only says where it surfaced.
 * `ENGINE_FAILURE` is anything the engine could not name, `MODEL_PROVIDER_FAILED`
 * anything the provider refused, `ERROR` a plain throw. For those the message
 * is matched against a closed list of kinds, and the kind's name is all that
 * leaves the machine.
 *
 * This is a stopgap read off prose. The exact facts (an HTTP status, an
 * errno, an engine code) exist on the cause chain where the error is raised
 * and are dropped before the report; a kind assigned there and carried in
 * `ReportError.details` would replace this table, and is a wire change.
 */

import type { ReportError } from '../report/build.ts';

/** The codes whose message is worth reading; every other code says what it is already. */
const KINDED_CODES: ReadonlySet<string> = new Set(['ENGINE_FAILURE', 'MODEL_PROVIDER_FAILED', 'ERROR']);

/**
 * First match wins, so the order is the rule: an exact status before its
 * family (`503` is `overloaded`, not `server`; `429` is `rate-limit`, not
 * `bad-request`), the protocol word before the surface it happened on
 * (`timeout` and `network` before `device` and `browser`), and the surface
 * before what was missing on it (`browser` before `not-found`).
 */
const FAILURE_KINDS: readonly (readonly [kind: string, pattern: RegExp])[] = [
  ['auth', /\b(?:401|403|unauthori[sz]ed|forbidden|api key|credentials?|authentication)\b/iu],
  ['rate-limit', /\b(?:429|rate.?limits?|quota|too many requests)\b/iu],
  ['overloaded', /\b(?:529|503|overloaded|capacity|service unavailable)\b/iu],
  ['timeout', /\b(?:timed?\s?out|timeouts?|ETIMEDOUT)\b/iu],
  ['network', /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|network)\b/iu],
  ['server', /\b(?:5\d\d|internal server error|bad gateway)\b/iu],
  ['bad-request', /\b(?:400|422|bad request|invalid request|unprocessable)\b/iu],
  ['device', /\b(?:simulator|emulator|simctl|xcrun|xcodebuild|adb|idb|devices?)\b/iu],
  ['daemon', /\bdaemon\b/iu],
  ['browser', /\b(?:browser|chromium|chrome|webkit|firefox|cdp|page crashed|target closed)\b/iu],
  ['permission', /\b(?:EACCES|EPERM|permission denied|not permitted)\b/iu],
  ['not-found', /\b(?:ENOENT|no such file|not found)\b/iu],
  ['memory', /\b(?:out of memory|heap|ENOMEM)\b/iu],
];

/** `CODE:kind` for an error whose code only says where it surfaced; nothing for every other code. */
export function failureKind(error: ReportError): string[] {
  if (!KINDED_CODES.has(error.code)) return [];
  const kind = FAILURE_KINDS.find(([, pattern]) => pattern.test(error.message))?.[0] ?? 'other';
  return [`${error.code}:${kind}`];
}
