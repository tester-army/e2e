/** Option resolution and test-target selection (spec 11-lifecycle.md). */

import { ConfigurationError, CollectionError } from '../internal/errors.ts';
import { WELL_KNOWN_DRIVERS } from '../config/drivers.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { Capability, Platform } from '../types.ts';
import type { Collection, CollectedTest } from './collect.ts';
import { groupChain } from './registry.ts';

export interface ResolvedTestOptions {
  readonly timeout: number;
  readonly retries: number;
  readonly tags: readonly string[];
  readonly platforms: readonly Platform[] | undefined;
  readonly requires: readonly Capability[];
  readonly session: string | undefined;
  readonly agentContext: string | undefined;
  readonly skipReason: string | undefined;
  readonly serial: boolean;
}

export interface SkipInfo {
  readonly cause:
    | 'explicit'
    | 'filtered'
    | 'platform-unavailable'
    | 'capability-unavailable'
    | 'setup-failed'
    | 'serial-predecessor-failed'
    | 'hook-failed'
    | 'infrastructure-unavailable';
  readonly reason: string;
  readonly relatedId?: string;
}

export interface TestTargetPair {
  readonly test: CollectedTest;
  readonly target: ResolvedTarget;
  readonly options: ResolvedTestOptions;
  /** run: execute; skip: report skipped; filtered: report as unselected. */
  readonly disposition: 'run' | 'skip' | 'filtered';
  readonly skip: SkipInfo | undefined;
}

/** All pairs for one selected target, in report order. */
export interface TargetSelection {
  readonly target: ResolvedTarget;
  readonly pairs: readonly TestTargetPair[];
}

export interface Selection {
  /** Every pair across all selected targets, in report order. */
  readonly pairs: readonly TestTargetPair[];
  /** Selected targets with their pairs, in config order. */
  readonly perTarget: readonly TargetSelection[];
}

export interface SelectionFilters {
  readonly tags?: readonly string[];
  readonly tagMode?: 'any' | 'all';
  readonly targetIds?: readonly string[];
}

/** Resolves effective options: test > nearest group > outer groups > config > default. */
export function resolveOptions(test: CollectedTest, config: ResolvedConfig): ResolvedTestOptions {
  const chain = groupChain(test.group);
  const layers = [...chain.map((group) => group.options), test.options];

  let timeout = config.timeout;
  let retries = config.retries;
  let platforms: readonly Platform[] | undefined;
  let requires: readonly Capability[] = [];
  let session: string | undefined;
  let skipReason: string | undefined;
  const tags = new Set<string>();
  const agentContextParts: string[] = [];

  for (const layer of layers) {
    if (layer.timeout !== undefined) timeout = layer.timeout;
    if (layer.retries !== undefined) retries = layer.retries;
    if (layer.platforms !== undefined) platforms = layer.platforms;
    if (layer.requires !== undefined) requires = layer.requires;
    if (layer.session !== undefined) session = layer.session;
    if (layer.tags !== undefined) for (const tag of layer.tags) tags.add(tag);
    if (layer.agentContext !== undefined) agentContextParts.push(layer.agentContext);
    if (layer.skip !== undefined && layer.skip !== false) {
      skipReason = typeof layer.skip === 'string' ? layer.skip : 'skipped';
    }
  }

  const serialRoot = test.serialRoot;
  if (serialRoot !== undefined) {
    let serialRetries = config.retries;
    for (const group of chain) {
      if (group.options.retries !== undefined) serialRetries = group.options.retries;
      if (group === serialRoot) break;
    }
    retries = serialRetries;
  }

  return {
    timeout,
    retries,
    tags: [...tags],
    platforms,
    requires,
    session,
    agentContext: agentContextParts.length === 0 ? undefined : agentContextParts.join('\n'),
    skipReason,
    serial: serialRoot !== undefined,
  };
}

function matchesTags(
  options: ResolvedTestOptions,
  tags: readonly string[] | undefined,
  tagMode: 'any' | 'all',
): boolean {
  if (tags === undefined || tags.length === 0) return true;
  if (tagMode === 'all') return tags.every((tag) => options.tags.includes(tag));
  return tags.some((tag) => options.tags.includes(tag));
}

function driverCapabilities(target: ResolvedTarget): readonly Capability[] {
  // Selection runs before any driver is instantiated, so a well-known id is
  // answered from its declared hint; the instance's real manifest is validated
  // against it before the first launch.
  if (typeof target.driver === 'string') return WELL_KNOWN_DRIVERS[target.driver]?.capabilities ?? [];
  // Backend targets serve no driver fixtures; what they can do is graded
  // from the backend's declared capabilities, none of which are fixtures yet.
  if (target.driver === undefined) return [];
  return target.driver.capabilities.fixtures;
}

/**
 * Expands the collection into test-target pairs and applies focus, tag,
 * platform, capability, session, and serial-closure rules.
 */
export function select(
  collection: Collection,
  config: ResolvedConfig,
  filters: SelectionFilters = {},
  flags: { passWithNoTests?: boolean } = {},
): Selection {
  const tagMode = filters.tagMode ?? 'any';
  const targets =
    filters.targetIds === undefined || filters.targetIds.length === 0
      ? config.targets
      : config.targets.filter((target) => filters.targetIds!.includes(target.name));
  if (filters.targetIds !== undefined) {
    for (const id of filters.targetIds) {
      if (!config.targets.some((target) => target.name === id)) {
        throw new ConfigurationError('UNKNOWN_TARGET', `unknown target ID "${id}"`);
      }
    }
  }

  const focused = collection.tests.filter((test) => test.mode === 'only');
  if (focused.length > 0 && config.ci) {
    throw new ConfigurationError(
      'ONLY_IN_CI',
      `.only is rejected in CI: ${focused.map((test) => test.id).join(', ')}`,
    );
  }

  const optionsByTest = new Map<string, ResolvedTestOptions>();
  for (const test of collection.tests) {
    optionsByTest.set(test.id, resolveOptions(test, config));
  }

  const sessionProducers = collectSessionProducers(collection.tests);

  const pairs: TestTargetPair[] = [];
  for (const target of targets) {
    for (const test of collection.tests) {
      const options = optionsByTest.get(test.id)!;
      pairs.push(classifyPair(test, target, options, focused, filters, tagMode));
    }
  }

  const withClosure = applySerialClosure(pairs);
  const withSessions = applySessionSelection(withClosure, sessionProducers);

  const runnableOrdinary = withSessions.filter(
    (pair) => pair.disposition === 'run' && pair.test.kind === 'test',
  );
  if (runnableOrdinary.length === 0 && flags.passWithNoTests !== true) {
    throw new ConfigurationError(
      'NO_TESTS',
      'zero runnable ordinary test-target pairs; pass --pass-with-no-tests to allow this',
    );
  }

  return {
    pairs: withSessions,
    perTarget: targets.map((target) => ({
      target,
      pairs: withSessions.filter((pair) => pair.target.name === target.name),
    })),
  };
}

/** Maps each session name to its unique producer setup test. */
function collectSessionProducers(
  tests: readonly CollectedTest[],
): ReadonlyMap<string, CollectedTest> {
  const producers = new Map<string, CollectedTest>();
  for (const test of tests) {
    if (test.kind !== 'setup') continue;
    for (const session of test.sessions) {
      const existing = producers.get(session);
      if (existing !== undefined) {
        throw new CollectionError(
          `session "${session}" has duplicate producers: ${existing.id} and ${test.id}`,
        );
      }
      producers.set(session, test);
    }
  }
  return producers;
}

function classifyPair(
  test: CollectedTest,
  target: ResolvedTarget,
  options: ResolvedTestOptions,
  focused: readonly CollectedTest[],
  filters: SelectionFilters,
  tagMode: 'any' | 'all',
): TestTargetPair {
  const base = { test, target, options };

  if (test.kind === 'test') {
    if (focused.length > 0 && test.mode !== 'only') {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: 'not focused by .only' },
      };
    }
    if (!matchesTags(options, filters.tags, tagMode)) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: 'tag filter did not match' },
      };
    }
  }

  if (options.platforms !== undefined && !options.platforms.includes(target.platform)) {
    return {
      ...base,
      disposition: 'filtered',
      skip: {
        cause: 'platform-unavailable',
        reason: `test declares platforms [${options.platforms.join(', ')}]`,
      },
    };
  }

  const capabilities = driverCapabilities(target);
  const missing = options.requires.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    return {
      ...base,
      disposition: 'skip',
      skip: {
        cause: 'capability-unavailable',
        reason: `driver lacks required capabilities: ${missing.join(', ')}`,
      },
    };
  }

  if (options.skipReason !== undefined) {
    return {
      ...base,
      disposition: 'skip',
      skip: { cause: 'explicit', reason: options.skipReason },
    };
  }

  if (test.kind === 'setup') {
    return { ...base, disposition: 'filtered', skip: { cause: 'filtered', reason: 'setup test not required by selection' } };
  }

  return { ...base, disposition: 'run', skip: undefined };
}

function applySerialClosure(pairs: readonly TestTargetPair[]): TestTargetPair[] {
  const selectedSerialUnits = new Set<string>();
  for (const pair of pairs) {
    if (pair.disposition === 'run' && pair.test.serialId !== undefined) {
      selectedSerialUnits.add(`${pair.target.name}::${pair.test.serialId}`);
    }
  }
  return pairs.map((pair) => {
    if (pair.test.serialId === undefined) return pair;
    const key = `${pair.target.name}::${pair.test.serialId}`;
    if (!selectedSerialUnits.has(key)) return pair;
    if (pair.disposition === 'run') return pair;
    if (pair.disposition === 'filtered' && pair.skip?.cause === 'filtered') {
      return { ...pair, disposition: 'run' as const, skip: undefined };
    }
    return pair;
  });
}

function applySessionSelection(
  pairs: readonly TestTargetPair[],
  sessionProducers: ReadonlyMap<string, CollectedTest>,
): TestTargetPair[] {
  const neededSetups = new Set<string>();
  for (const pair of pairs) {
    if (pair.disposition !== 'run' || pair.options.session === undefined) continue;
    const producer = sessionProducers.get(pair.options.session);
    if (producer === undefined) {
      throw new CollectionError(
        `test ${pair.test.id} consumes session "${pair.options.session}" but no setup test produces it`,
      );
    }
    neededSetups.add(`${pair.target.name}::${producer.id}`);
  }
  return pairs.map((pair) => {
    if (pair.test.kind !== 'setup') return pair;
    const key = `${pair.target.name}::${pair.test.id}`;
    if (!neededSetups.has(key)) return pair;
    if (pair.disposition === 'skip') {
      throw new CollectionError(
        `setup test ${pair.test.id} is required by a session consumer but is skipped: ${pair.skip?.reason ?? ''}`,
      );
    }
    return { ...pair, disposition: 'run' as const, skip: undefined };
  });
}
