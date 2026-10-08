/**
 * The TestMu AI credentials a run authenticates with: `LT_USERNAME` and
 * `LT_ACCESS_KEY` from the run's environment. agent-device's `testmu`
 * runtime reads them from the environment of the daemon that drives the
 * sessions, not from a request.
 */

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

/** The run's credentials when both are set, else `undefined`, for a call that can do without them. */
export function optionalTestmuCredentials(env: Readonly<Record<string, string | undefined>>): TestmuCredentials | undefined {
  const username = envValue(env, LT_USERNAME);
  const accessKey = envValue(env, LT_ACCESS_KEY);
  return username === undefined || accessKey === undefined ? undefined : { username, accessKey };
}

/** Daemon calls in flight under one set of credentials, and the values those replaced in `process.env`. */
interface CredentialScope {
  readonly credentials: TestmuCredentials;
  calls: number;
  readonly replaced: { readonly username: string | undefined; readonly accessKey: string | undefined };
  /** Settles once the last call of the scope has finished. */
  readonly closed: Promise<void>;
  readonly close: () => void;
}

let scope: CredentialScope | undefined;

/**
 * Runs a call to the run's daemon with the run's credentials in this
 * process's environment, which is where a daemon the call starts gets them:
 * agent-device's client starts its local daemon with `process.env` and takes
 * no environment of its own, while a run's environment can differ from
 * `process.env` (a host that passes `env`). Calls with the same credentials
 * overlap; a call with other credentials waits until they have finished, so
 * a daemon never starts under another run's user. Once no call is in flight
 * the previous values are put back, so the credentials do not linger for
 * other child processes of a long-lived host. Every worker of the run
 * already starts with these values.
 */
export async function withDaemonCredentials<T>(credentials: TestmuCredentials | undefined, call: () => Promise<T>): Promise<T> {
  if (credentials === undefined) return call();
  const current = await enterScope(credentials);
  try {
    return await call();
  } finally {
    leaveScope(current);
  }
}

async function enterScope(credentials: TestmuCredentials): Promise<CredentialScope> {
  // `scope` changes while this waits: another call may open one first.
  for (let open = scope; open !== undefined && !sameCredentials(open.credentials, credentials); open = scope) await open.closed;
  if (scope === undefined) {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => (close = resolve));
    scope = { credentials, calls: 0, replaced: { username: process.env[LT_USERNAME], accessKey: process.env[LT_ACCESS_KEY] }, closed, close };
  }
  // Set on every call, not only the first: the host may have changed them since.
  process.env[LT_USERNAME] = credentials.username;
  process.env[LT_ACCESS_KEY] = credentials.accessKey;
  scope.calls += 1;
  return scope;
}

function sameCredentials(a: TestmuCredentials, b: TestmuCredentials): boolean {
  return a.username === b.username && a.accessKey === b.accessKey;
}

function leaveScope(current: CredentialScope): void {
  current.calls -= 1;
  if (current.calls > 0) return;
  scope = undefined;
  restore(LT_USERNAME, current.credentials.username, current.replaced.username);
  restore(LT_ACCESS_KEY, current.credentials.accessKey, current.replaced.accessKey);
  current.close();
}

/** Puts back `previous`, unless the host changed the value from the one the scope set: that one is the host's. */
function restore(name: string, set: string, previous: string | undefined): void {
  if (process.env[name] !== set) return;
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

/** A non-empty variable from the run's environment, trimmed, or `undefined`. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}
