/**
 * The runner's config: the project config (`resolveProjectConfig`), plus
 * the reporters and test filters only a run reads.
 */

import { ConfigurationError } from 'e2e-core/lib/internal/errors';
import { didYouMean } from 'e2e-core/lib/internal/suggest';
import { BUILTIN_REPORTER_LIST, BUILTIN_REPORTERS, isBuiltinReporter } from '../report/builtin.ts';
import { ellipsize } from '../report/format.ts';
import type { BuiltinReporter, E2EConfig, Reporter, TestFilter } from '../run-types.ts';
import { resolveProjectConfig, type CliOverrides, type ResolvedConfig } from 'e2e-core/lib/config/resolve';
import { TARGET_NAME_PATTERN } from 'e2e-core/lib/config/targets';

/** A resolved config with what only a run reads. */
export interface ResolvedRunConfig extends ResolvedConfig {
  /** The built-in renderers in force: `--reporter` when given, else the config's ids. */
  readonly reporters: readonly BuiltinReporter[];
  /** The reporter objects the config names; `--reporter` never removes one. */
  readonly customReporters: readonly Reporter[];
  /** The test filters, in order; empty when unset. A run with `--changed-since` applies them. */
  readonly filters: readonly TestFilter[];
}

/** The flags that replace config keys, `--reporter` among them. */
export interface RunCliOverrides extends CliOverrides {
  reporters?: readonly BuiltinReporter[];
}

/** Resolves a config file's export for the runner: the project config, then its reporters and filters. */
export function resolveConfig(
  raw: E2EConfig,
  options: {
    projectRoot: string;
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    cli?: RunCliOverrides;
  },
): ResolvedRunConfig {
  const resolved = resolveProjectConfig(raw, options);
  const { reporters, customReporters } = resolveReporters(raw, options.cli ?? {});
  return { ...resolved, reporters, customReporters, filters: resolveTestFilters(raw.filters) };
}

/**
 * Splits `reporters` into the built-in ids and the reporter objects.
 * `--reporter` replaces the ids only: an object has no id to name on the
 * command line, so a CI flag choosing `list,junit` never drops the upload a
 * config asked for.
 */
function resolveReporters(
  raw: E2EConfig,
  cli: RunCliOverrides,
): { reporters: readonly BuiltinReporter[]; customReporters: readonly Reporter[] } {
  const configured = raw.reporters ?? ['list'];
  if (!Array.isArray(configured)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'reporters must be an array of reporter ids and reporter objects',
    );
  }
  const ids: BuiltinReporter[] = [];
  const customReporters: Reporter[] = [];
  for (const reporter of configured as readonly unknown[]) {
    if (typeof reporter === 'string') {
      if (!isBuiltinReporter(reporter)) {
        throw new ConfigurationError(
          'INVALID_CONFIG',
          `unknown reporter "${reporter}"; reporters are ${BUILTIN_REPORTER_LIST}${didYouMean(reporter, BUILTIN_REPORTERS)}`,
        );
      }
      ids.push(reporter);
    } else if (isReporter(reporter)) {
      customReporters.push(reporter);
    } else {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `a reporter is a built-in id (${BUILTIN_REPORTERS.join(', ')}) or an object with a name and an onEvent or onRunFinished method`,
      );
    }
  }
  const reporters = cli.reporters ?? ids;
  if (reporters.includes('json') && reporters.includes('list')) {
    throw new ConfigurationError('INVALID_CONFIG', 'the json renderer cannot be combined with list');
  }
  return { reporters, customReporters };
}

const MAX_FILTER_NAME = 256;

/**
 * Resolves `filters`: a list of test filters, each checked structurally,
 * never with `instanceof`, since the config may import another copy of
 * `e2e`. A filter's name is how the report and errors tell it apart, so
 * names are unique. Workers resolve it too and never call a filter, so the
 * check stays synchronous.
 */
function resolveTestFilters(raw: E2EConfig['filters']): readonly TestFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigurationError('INVALID_CONFIG', 'filters must be a list of test filters: filters: [{ name, filter(tests, context) }]');
  }
  const names = new Set<string>();
  return Array.from(raw as readonly unknown[], (value, index) => {
    const label = `filters[${index}]`;
    if (typeof value === 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `${label} is ${value.name ? `the function ${value.name}` : 'a function'}; call it, such as filters: [decisionFilter({ model })]`);
    }
    if (!isTestFilter(value)) {
      throw new ConfigurationError('INVALID_CONFIG', `${label} must be a TestFilter: { name, filter(tests, context) }`);
    }
    const { name } = value;
    if (!TARGET_NAME_PATTERN.test(name)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid filter name ${JSON.stringify(name)}: names are ASCII letters, numbers, "_", "-", or ".", and cannot be only dots`,
      );
    }
    if (name.length > MAX_FILTER_NAME) {
      throw new ConfigurationError('INVALID_CONFIG', `filter name ${JSON.stringify(ellipsize(name, 32))} is longer than ${MAX_FILTER_NAME} characters`);
    }
    if (names.has(name)) {
      throw new ConfigurationError('INVALID_CONFIG', `filters has two filters named ${JSON.stringify(name)}; the report tells filters apart by name`);
    }
    names.add(name);
    return value;
  });
}

/** Structural test filter check: a string name and a `filter` function. */
function isTestFilter(value: unknown): value is TestFilter {
  if (typeof value !== 'object' || value === null) return false;
  const { name, filter } = value as { name?: unknown; filter?: unknown };
  return typeof name === 'string' && typeof filter === 'function';
}

/** Structural reporter check: a non-empty name and at least one handler, each a function when present. */
function isReporter(value: unknown): value is Reporter {
  if (typeof value !== 'object' || value === null) return false;
  const { name, onEvent, onRunFinished } = value as { name?: unknown; onEvent?: unknown; onRunFinished?: unknown };
  if (typeof name !== 'string' || name.length === 0) return false;
  const optionalFunction = (handler: unknown): boolean => handler === undefined || typeof handler === 'function';
  return optionalFunction(onEvent) && optionalFunction(onRunFinished) && (onEvent ?? onRunFinished) !== undefined;
}

