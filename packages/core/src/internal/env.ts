/** Reading the process environment: presence, and boolean flags the way `CI` is read. */

/** The variable's value when it is set and not blank; undefined otherwise. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** True for a set variable that is not blank, `0`, or `false`. */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = envValue(env, name)?.trim().toLowerCase();
  return value !== undefined && value !== '0' && value !== 'false';
}
