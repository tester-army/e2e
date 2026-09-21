/**
 * The one rule for a name that leaves the machine as it is. An engine name,
 * a platform, a public model id, or a fleet name is a short token of
 * letters, digits, dots, dashes, and underscores; a path, a URL, a hostname,
 * or a sentence is not, and folds to `other`. A runner error code is the
 * upper-case form of the same rule and folds to `OTHER`.
 */

const PLAIN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;

/** The name as it is when it is a plain token, `other` otherwise. */
export function plainToken(value: string): string {
  return PLAIN_TOKEN.test(value) ? value : 'other';
}

/** A runner error code as it is, `OTHER` for a code shaped like a project's own. */
export function errorCodeToken(code: string): string {
  return ERROR_CODE.test(code) ? code : 'OTHER';
}
