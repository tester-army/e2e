/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
export function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
