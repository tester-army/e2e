/**
 * The Expo credentials a run authenticates with, in eas-cli's order:
 * `EXPO_TOKEN` when it is set, else the session `eas login` stored, so a
 * machine signed in to eas-cli needs no token. Only the production login is
 * read: the sessions API is always `api.expo.dev`, and eas-cli's staging and
 * local logins belong to other hosts.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { envValue } from './env.ts';
import { isRecord } from './json.ts';

export const EXPO_TOKEN = 'EXPO_TOKEN';

/** An access token goes out as `Authorization: Bearer`, an eas-cli session secret as `expo-session`. */
export type ExpoCredentials = { readonly accessToken: string } | { readonly sessionSecret: string };

/**
 * `EXPO_TOKEN` from the run's environment, else the `auth.sessionSecret` eas-cli
 * keeps in `state.json`; `undefined` when there is neither.
 */
export async function expoCredentials(env: Readonly<Record<string, string | undefined>>): Promise<ExpoCredentials | undefined> {
  const accessToken = envValue(env, EXPO_TOKEN);
  if (accessToken !== undefined) return { accessToken };
  const path = stateJsonPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`could not read the eas-cli login at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    // No cause: a JSON parse error quotes the text around the fault, which can be the secret.
    throw new Error(`the eas-cli login at ${path} is not valid JSON; run \`eas login\` again, or set ${EXPO_TOKEN}`);
  }
  const auth = isRecord(state) ? state['auth'] : undefined;
  const sessionSecret = isRecord(auth) ? auth['sessionSecret'] : undefined;
  return typeof sessionSecret === 'string' && sessionSecret.trim() !== '' ? { sessionSecret: sessionSecret.trim() } : undefined;
}

/** eas-cli's production `state.json` under the run's home: `USERPROFILE` on Windows and `HOME` elsewhere, as `os.homedir()` resolves it. */
function stateJsonPath(env: Readonly<Record<string, string | undefined>>): string {
  const home = envValue(env, process.platform === 'win32' ? 'USERPROFILE' : 'HOME') ?? homedir();
  return join(home, '.expo', 'state.json');
}
