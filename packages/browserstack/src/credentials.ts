const BROWSERSTACK_USERNAME = 'BROWSERSTACK_USERNAME';
const BROWSERSTACK_ACCESS_KEY = 'BROWSERSTACK_ACCESS_KEY';

export interface BrowserStackCredentials {
  readonly username: string;
  readonly accessKey: string;
}

/** `BROWSERSTACK_USERNAME` and `BROWSERSTACK_ACCESS_KEY` from the run's environment; throws naming each one that is unset or blank. */
export function browserstackCredentials(env: Readonly<Record<string, string | undefined>>): BrowserStackCredentials {
  const username = envValue(env, BROWSERSTACK_USERNAME);
  const accessKey = envValue(env, BROWSERSTACK_ACCESS_KEY);
  if (username === undefined || accessKey === undefined) {
    const missing = [username === undefined ? BROWSERSTACK_USERNAME : undefined, accessKey === undefined ? BROWSERSTACK_ACCESS_KEY : undefined].filter((name) => name !== undefined);
    throw new Error(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set; set ${BROWSERSTACK_USERNAME} and ${BROWSERSTACK_ACCESS_KEY} to your BrowserStack username and access key in the environment \`e2e run\` starts in`,
    );
  }
  return { username, accessKey };
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
