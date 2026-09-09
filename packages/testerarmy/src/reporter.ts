import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import type { Reporter } from '@e2edev/e2e';
import { DEFAULT_API_KEY_ENV, uploadRun } from './upload.ts';

export interface TesterArmyOptions {
  /**
   * The TesterArmy project the runs land in, by id. Unset, the API key's
   * default project takes them.
   */
  project?: string;
  /**
   * The NAME of the environment variable holding the API key, never the key
   * itself; `TESTERARMY_API_KEY` by default. With the variable unset, the key
   * `testerarmy auth` saved is used; with neither, the reporter uploads
   * nothing and says so in one summary row.
   */
  apiKey?: string;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The TesterArmy reporter. Add it to `reporters` beside the built-in ids:
 *
 * ```ts
 * import { testerarmy } from '@e2edev/testerarmy';
 * export default { targets, reporters: ['list', testerarmy()] } satisfies E2EConfig;
 * ```
 *
 * Everything it reads — the key, the host (`TESTERARMY_BASE_URL`), the CI
 * variables that attribute the run — is read when the run finishes, never
 * when the config loads, so constructing it has no side effects.
 */
export function testerarmy(options: TesterArmyOptions = {}): Reporter {
  const apiKeyEnv = options.apiKey ?? DEFAULT_API_KEY_ENV;
  if (!ENV_NAME_PATTERN.test(apiKeyEnv)) {
    throw new Error(
      `testerarmy: apiKey names the environment variable holding the key, got "${apiKeyEnv}"`,
    );
  }
  return {
    name: 'testerarmy',
    onRunFinished: (run, signal) =>
      uploadRun(
        run,
        signal,
        { apiKeyEnv, ...(options.project === undefined ? {} : { project: options.project }) },
        {
          fetch: globalThis.fetch,
          env: process.env,
          homeDir: os.homedir(),
          fileExists: (file) => access(file).then(() => true, () => false),
          readFile: (file) => readFile(file),
        },
      ),
  };
}
