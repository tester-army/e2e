/**
 * The Expo project id a run's sessions belong to when `easSimulators()` names
 * none: `extra.eas.projectId` of the app config in the e2e project root, the
 * id `eas init` writes.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isRecord } from './json.ts';

const execFileAsync = promisify(execFile);

/** The dynamic app config names Expo resolves, in its order; one of them wins over `app.json`. */
const DYNAMIC_CONFIGS = ['app.config.ts', 'app.config.mts', 'app.config.cts', 'app.config.mjs', 'app.config.cjs', 'app.config.js'];

/** The static app config names Expo resolves, in its order. */
const STATIC_CONFIGS = ['app.config.json', 'app.json'];

/** How long `expo config` may evaluate a dynamic config; it takes about a second. */
const EXPO_CONFIG_TIMEOUT_MS = 60_000;

const PASS_IT = 'pass `projectId` to easSimulators(), or run `eas init` to link the app to an EAS project';

/**
 * `extra.eas.projectId` from the app config in `projectRoot`. A dynamic
 * config (`app.config.ts` and its siblings) is evaluated by the project's
 * own `expo config`, with the run's environment, since it can compute the
 * id; a static one (`app.config.json`, `app.json`) is read as JSON.
 */
export async function appConfigProjectId(projectRoot: string, env: Readonly<Record<string, string | undefined>>, signal: AbortSignal): Promise<string> {
  const dynamic = DYNAMIC_CONFIGS.find((name) => existsSync(join(projectRoot, name)));
  if (dynamic !== undefined) return projectIdOf(await evaluatedConfig(projectRoot, env, signal), `${dynamic} (through \`expo config\`)`);
  const fixed = STATIC_CONFIGS.find((name) => existsSync(join(projectRoot, name)));
  if (fixed === undefined) throw new Error(`no Expo app config (app.json or app.config.*) in ${projectRoot}; ${PASS_IT}`);
  const path = join(projectRoot, fixed);
  let config: unknown;
  try {
    config = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
  } catch (cause) {
    throw new Error(`could not read the Expo app config at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  // Expo reads the app config from under `expo` when the file has that key, else the whole file.
  const expo = isRecord(config) && isRecord(config['expo']) ? config['expo'] : config;
  return projectIdOf(expo, fixed);
}

/** The public app config `expo config` prints for `projectRoot`, run with the project's own `expo` package. */
async function evaluatedConfig(projectRoot: string, env: Readonly<Record<string, string | undefined>>, signal: AbortSignal): Promise<unknown> {
  const cli = expoCli(projectRoot);
  if (cli === undefined) {
    throw new Error(`the app config in ${projectRoot} is dynamic and \`expo\` is not installed there to evaluate it; install it, or ${PASS_IT}`);
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [cli, 'config', '--json', '--type', 'public'], {
      cwd: projectRoot,
      // As eas-cli runs it: the id comes from the config and the run's environment, never from a `.env` file.
      env: { ...env, EXPO_NO_DOTENV: '1' },
      signal,
      timeout: EXPO_CONFIG_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (cause) {
    const stderr = (cause as { stderr?: unknown }).stderr;
    const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : cause instanceof Error ? cause.message : String(cause);
    throw new Error(`\`expo config\` failed in ${projectRoot}: ${detail}`, { cause });
  }
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`\`expo config\` in ${projectRoot} printed no JSON config`, { cause });
  }
}

/**
 * The `expo` CLI in the `node_modules` of `projectRoot` or a parent, as Expo
 * resolves it: never through `NODE_PATH` or Node's global folders, which
 * pnpm points at its whole store and which hold some other project's `expo`.
 */
function expoCli(projectRoot: string): string | undefined {
  for (let directory = projectRoot; ; directory = dirname(directory)) {
    const cli = join(directory, 'node_modules', 'expo', 'bin', 'cli');
    if (existsSync(cli)) return cli;
    if (dirname(directory) === directory) return undefined;
  }
}

/** `extra.eas.projectId` of an app config, named after the file it came from when it is missing. */
function projectIdOf(config: unknown, source: string): string {
  const extra = isRecord(config) ? config['extra'] : undefined;
  const eas = isRecord(extra) ? extra['eas'] : undefined;
  const projectId = isRecord(eas) ? eas['projectId'] : undefined;
  if (typeof projectId === 'string' && projectId.trim() !== '') return projectId.trim();
  throw new Error(`${source} has no \`extra.eas.projectId\`; ${PASS_IT}`);
}
