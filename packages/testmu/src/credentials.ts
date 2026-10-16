const LT_USERNAME = 'LT_USERNAME';
const LT_ACCESS_KEY = 'LT_ACCESS_KEY';

export interface TestmuCredentials {
  readonly username: string;
  readonly accessKey: string;
}

/** `LT_USERNAME` and `LT_ACCESS_KEY` from the run's environment; throws naming each one that is unset or blank. */
export function testmuCredentials(env: Readonly<Record<string, string | undefined>>): TestmuCredentials {
  const username = envValue(env, LT_USERNAME);
  const accessKey = envValue(env, LT_ACCESS_KEY);
  if (username === undefined || accessKey === undefined) {
    const missing = [username === undefined ? LT_USERNAME : undefined, accessKey === undefined ? LT_ACCESS_KEY : undefined].filter((name) => name !== undefined);
    throw new Error(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set; set ${LT_USERNAME} and ${LT_ACCESS_KEY} to your TestMu AI username and access key in the environment \`e2e run\` starts in`,
    );
  }
  return { username, accessKey };
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
