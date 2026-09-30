/** The fixture names the runner itself hands out, in one place for every check that guards them. */

/** Fixtures every attempt has without any engine or `test.extend()` defining them. */
export const CORE_FIXTURE_NAMES: ReadonlySet<string> = new Set(['agent', 'app', 'screen', 'platform', 'session']);

/**
 * Every fixture the runner may hand out: the core ones and `email`, which
 * exists only with `config.email` set. An engine may take none of them; a
 * `test.extend()` may take `email` in a project without email.
 */
export const RUNNER_FIXTURE_NAMES: ReadonlySet<string> = new Set([...CORE_FIXTURE_NAMES, 'email']);
