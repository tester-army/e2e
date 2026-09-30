/**
 * The command a target's `app.command` is declared with: its shape checked
 * once, where it is declared, so the rest of the resolution only ever sees
 * strings.
 */

import path from 'node:path';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { rejectUnknownKeys } from '../internal/options.ts';
import { insideProjectRoot } from '../internal/paths.ts';
import { isSecret } from '../secrets.ts';
import type { CommandConfig } from '../types.ts';
import { describeValue, positiveInt } from './validate.ts';

/**
 * How a spawned process counts as ready: a URL that answers, or the process
 * itself exiting with code 0.
 */
export type Readiness = { readonly readyUrl: string } | { readonly waitForExit: true };

/** The keys of a `CommandConfig`, kept equal to the type by the compiler. */
const COMMAND_KEYS: readonly string[] = Object.keys({
  executable: true,
  args: true,
  cwd: true,
  env: true,
  startupTimeout: true,
  shutdownTimeout: true,
  log: true,
  reuseExisting: true,
} satisfies Record<keyof CommandConfig, true>);

/** True for an object that is not an array: the shape options and commands take. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A config value that must be a string. A `secrets.get()` handle is named as
 * one: the process would receive `[object Object]`, and only an engine option
 * that declares secrets resolves a handle to its value.
 */
function commandString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (isSecret(value)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be a string, got secrets.get(${JSON.stringify(value.name)}): only an engine option that declares secrets accepts a handle, such as web({ basicAuth: { password } }); pass the value itself, read from process.env`,
    );
  }
  throw new ConfigurationError('INVALID_CONFIG', `${label} must be a string, got ${describeValue(value)}`);
}

/**
 * Checks the shape of one command and returns a frozen copy: only the keys a
 * command takes, a non-empty executable, string args and env values, when
 * set positive integer timeouts, a non-empty `log`, and a boolean
 * `reuseExisting`. A misspelled key would otherwise be dropped without a
 * word; a NaN or infinite budget would make the readiness loop spin without
 * a deadline. An `env` entry whose value is `undefined` is dropped, as
 * `spawn` drops it: `env: { KEY: process.env.KEY }` with the variable unset
 * starts the process without it.
 */
export function normalizeCommand(command: CommandConfig, label: string): CommandConfig {
  if (!isRecord(command)) throw new ConfigurationError('INVALID_CONFIG', `${label} must be an object`);
  rejectUnknownKeys(label, command, COMMAND_KEYS);
  const { executable, args, cwd, env, startupTimeout, shutdownTimeout, log, reuseExisting } = command;
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.executable is required`);
  }
  if (args !== undefined && !Array.isArray(args)) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.args must be an array of strings`);
  }
  const strings = args?.map((arg: unknown, index) => commandString(arg, `${label}.args[${index}]`));
  if (env !== undefined && !isRecord(env)) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.env must be an object of variable name to string`);
  }
  const variables =
    env === undefined
      ? undefined
      : Object.entries(env)
          .filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, commandString(entry, `${label}.env.${key}`)] as const);
  if (cwd !== undefined && typeof cwd !== 'string') throw new ConfigurationError('INVALID_CONFIG', `${label}.cwd must be a string`);
  positiveInt(startupTimeout, `${label}.startupTimeout`, 'milliseconds');
  positiveInt(shutdownTimeout, `${label}.shutdownTimeout`, 'milliseconds');
  if (log !== undefined && (typeof log !== 'string' || log.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.log must be a non-empty path`);
  }
  if (reuseExisting !== undefined && typeof reuseExisting !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `${label}.reuseExisting must be a boolean`);
  }
  return Object.freeze(
    obj({
      executable,
      args: strings === undefined ? undefined : Object.freeze(strings),
      cwd,
      env: variables === undefined ? undefined : Object.freeze(Object.fromEntries(variables)),
      startupTimeout,
      shutdownTimeout,
      log,
      reuseExisting,
    }),
  );
}

/** A `log` must be a file inside the project root: a log outside it would let config write anywhere. */
export function checkLog(command: CommandConfig, label: string, projectRoot: string): void {
  if (command.log !== undefined && !insideProjectRoot(projectRoot, path.resolve(projectRoot, command.log))) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label}.log must be a file inside the project root, got ${JSON.stringify(command.log)}`,
    );
  }
}

/** A command as it enters the config digest: env values reduced to their names. */
export function digestCommand(command: CommandConfig) {
  const { env, ...rest } = command;
  return obj({ ...rest, env: env === undefined ? undefined : Object.fromEntries(Object.keys(env).map((key) => [key, { envName: key }])) });
}
