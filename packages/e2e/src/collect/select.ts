/** Option resolution and test-target selection. */

import { ConfigurationError, CollectionError } from '../internal/errors.ts';
import { didYouMean, suggest } from '../internal/suggest.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { Capability } from '../types.ts';
import type { Collection, CollectedTest } from './collect.ts';
import { groupChain } from './registry.ts';

export interface ResolvedTestOptions {
  readonly timeout: number;
  readonly retries: number;
  /** The tags the test declares (`TestIdentity.tags`), here for the wire and the filter. */
  readonly tags: readonly string[];
  readonly platforms: readonly string[] | undefined;
  readonly requires: readonly Capability[];
  readonly session: string | undefined;
  readonly agentContext: string | undefined;
  /**
   * The configured agents the test runs as, one pair (and one result) each,
   * in order: its pin narrowed to the names `--agent` also names, the whole
   * pin when the flag names none of them, or the run's agents when it has no
   * pin. Never empty; a setup test has exactly one.
   */
  readonly agents: readonly string[];
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
  /** The configured agent this pair runs as: one of `options.agents`. */
  readonly agent: string;
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
  let platforms: readonly string[] | undefined;
  let requires: readonly Capability[] = [];
  let session: string | undefined;
  let pin: readonly string[] | undefined;
  let skipReason: string | undefined;
  const agentContextParts: string[] = [];

  for (const layer of layers) {
    if (layer.timeout !== undefined) timeout = layer.timeout;
    if (layer.retries !== undefined) retries = layer.retries;
    if (layer.platforms !== undefined) platforms = layer.platforms;
    if (layer.requires !== undefined) requires = layer.requires;
    if (layer.session !== undefined) session = layer.session;
    if (layer.agent !== undefined) pin = typeof layer.agent === 'string' ? [layer.agent] : layer.agent;
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

  // A pin names configured agents, or the test never runs: the error lands
  // at selection, before any process starts, like every other config fact.
  for (const name of pin ?? []) {
    if (config.agents.has(name)) continue;
    throw new CollectionError(
      `test "${test.titlePath.join(' > ')}" in ${test.file} names agent "${name}", which agents does not define; configured: ${[...config.agents.keys()].join(', ')}${didYouMean(name, [...config.agents.keys()])}`,
    );
  }

  return {
    timeout,
    retries,
    tags: test.tags,
    platforms,
    requires,
    session,
    agents: effectiveAgents(test, pin, config.agentNames),
    agentContext: agentContextParts.length === 0 ? undefined : agentContextParts.join('\n'),
    skipReason,
    serial: serialRoot !== undefined,
  };
}

/**
 * The agents one test runs as. `--agent` selects among what a pin allows
 * and never adds to it: a pin naming none of the run's agents stands whole,
 * which is the old "a pin is never overridden" rule with a pin of one. A
 * setup test produces its sessions once per target, so it runs as one agent:
 * its pin, else the first the run names.
 */
function effectiveAgents(
  test: CollectedTest,
  pin: readonly string[] | undefined,
  runAgents: readonly string[],
): readonly string[] {
  if (test.kind === 'setup') return [pin?.[0] ?? runAgents[0]!];
  if (pin === undefined) return runAgents;
  const narrowed = pin.filter((name) => runAgents.includes(name));
  return narrowed.length === 0 ? pin : narrowed;
}

/**
 * A serial group runs as one unit per agent, so every member must run as
 * the same agents; a member pinned elsewhere would leave its variant of the
 * flow with a hole. The fix is the pin on the serial describe, with a call's
 * own `agent` option for a step under another brain.
 */
function assertSerialAgentsAgree(
  tests: readonly CollectedTest[],
  optionsByTest: ReadonlyMap<string, ResolvedTestOptions>,
): void {
  const agentsByGroup = new Map<string, readonly string[]>();
  for (const test of tests) {
    if (test.serialId === undefined) continue;
    const agents = optionsByTest.get(test.id)!.agents;
    const groupAgents = agentsByGroup.get(test.serialId);
    if (groupAgents === undefined) {
      agentsByGroup.set(test.serialId, agents);
      continue;
    }
    if (groupAgents.length === agents.length && groupAgents.every((name, i) => name === agents[i])) continue;
    throw new CollectionError(
      `serial group "${test.serialRoot?.title ?? test.serialId}" in ${test.file} runs as agents [${groupAgents.join(', ')}] but its member "${test.title}" pins [${agents.join(', ')}]; pin the agent on the serial describe and name another per call with { agent }`,
    );
  }
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

/** Validates target IDs and selects targets once each, in config order. */
export function selectTargets(
  targets: readonly ResolvedTarget[],
  targetIds: readonly string[] | undefined,
): readonly ResolvedTarget[] {
  if (targetIds === undefined || targetIds.length === 0) return targets;
  const names = targets.map((target) => target.name);
  const known = new Set(names);
  for (const id of targetIds) {
    if (!known.has(id)) {
      throw new ConfigurationError(
        'UNKNOWN_TARGET',
        `unknown target ID "${id}"; the config declares ${names.map((name) => `"${name}"`).join(', ')}${didYouMean(id, names)}`,
      );
    }
  }
  const selected = new Set(targetIds);
  return targets.filter((target) => selected.has(target.name));
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
  const targets = selectTargets(config.targets, filters.targetIds);

  // Focus is decided among the tests positionals selected: a `.only` left in
  // a file the run did not name neither runs nor silences the named files.
  const focused = collection.tests.filter((test) => test.mode === 'only' && test.selected);
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

  assertSerialAgentsAgree(collection.tests, optionsByTest);
  const sessionProducers = collectSessionProducers(collection.tests);

  // One pair per target, test, and agent the test runs as, in that order,
  // so a persona sweep reports its variants side by side.
  const pairs: TestTargetPair[] = [];
  for (const target of targets) {
    for (const test of collection.tests) {
      const options = optionsByTest.get(test.id)!;
      for (const agent of options.agents) {
        pairs.push(classifyPair(test, target, agent, options, focused, filters, tagMode));
      }
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
      `${describeNoTests(collection, config, filters, withSessions)}; pass --pass-with-no-tests to allow this`,
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

/** At most this many file names are spelled out in a `NO_TESTS` message. */
const MAX_NAMED_FILES = 3;

function nameFiles(files: readonly string[]): string {
  const shown = files.slice(0, MAX_NAMED_FILES).join(', ');
  const rest = files.length - MAX_NAMED_FILES;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Why nothing is runnable, told from the most upstream cause: the globs
 * matched no file (naming look-alike files when there are any), a positional
 * selected none, the files registered no tests, or every collected test was
 * filtered or skipped. Each ends where the author's next edit goes.
 */
function describeNoTests(
  collection: Collection,
  config: ResolvedConfig,
  filters: SelectionFilters,
  pairs: readonly TestTargetPair[],
): string {
  const { files, nearMisses, unmatchedPositionals, tests } = collection;
  const discovered = files.map((file) => file.file);
  if (discovered.length === 0) {
    const globs = config.tests.map((glob) => `"${glob}"`).join(', ');
    const where = `no test file matched ${globs} under ${config.projectRoot}`;
    if (nearMisses.length > 0) {
      return `${where}; found ${nameFiles(nearMisses)}, which the pattern does not match: rename to *.e2e.ts, or set tests in the config to a glob that matches`;
    }
    return `${where}; create tests/example.e2e.ts (e2e init writes one), or set tests in the config`;
  }
  if (!files.some((file) => file.selected) && unmatchedPositionals.length > 0) {
    // A positional may be a whole path or just a file name, so a near miss is looked for as either.
    const baseNames = discovered.map((file) => file.slice(file.lastIndexOf('/') + 1));
    const named = unmatchedPositionals
      .map((positional) => {
        const match = suggest(positional, discovered) ?? suggest(positional, baseNames);
        return match === undefined ? positional : `${positional} (did you mean ${match}?)`;
      })
      .join(', ');
    return `no test file matched ${named}; the config globs discovered ${nameFiles(discovered)}`;
  }
  if (tests.length === 0) {
    const named = nameFiles(discovered);
    return `${named} registered no tests; import { test } from 'e2e' (or from the engine package) and call test() at the top level of the module`;
  }
  const reasons = new Map<string, Set<string>>();
  const count = (reason: string, test: CollectedTest): void => {
    const ids = reasons.get(reason) ?? new Set<string>();
    ids.add(test.id);
    reasons.set(reason, ids);
  };
  for (const pair of pairs) {
    if (pair.disposition === 'run' && pair.test.kind === 'test') continue;
    if (pair.test.kind === 'setup') {
      count('setup tests, which run only for the sessions selected tests need', pair.test);
      continue;
    }
    switch (pair.skip?.cause) {
      case 'explicit':
        count('skipped with test.skip', pair.test);
        break;
      case 'platform-unavailable':
        count(`declare platforms other than ${pair.target.platform}`, pair.test);
        break;
      case 'capability-unavailable':
        count('require capabilities the engine lacks', pair.test);
        break;
      case 'filtered':
        count(
          filters.tags !== undefined && filters.tags.length > 0
            ? `carry none of the tags ${filters.tags.join(', ')}`
            : pair.skip.reason,
          pair.test,
        );
        break;
      default:
        count('unselected', pair.test);
    }
  }
  const summary = [...reasons].map(([reason, ids]) => `${ids.size} ${reason}`).join(', ');
  return `${tests.length} tests were collected but none is runnable: ${summary}`;
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
  agent: string,
  options: ResolvedTestOptions,
  focused: readonly CollectedTest[],
  filters: SelectionFilters,
  tagMode: 'any' | 'all',
): TestTargetPair {
  const base = { test, target, agent, options };

  if (test.kind === 'test') {
    // A file no positional named is collected for its setup tests only; its
    // ordinary tests are unselected, exactly as a tag filter leaves them.
    if (!test.selected) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: 'file not selected by a positional argument' },
      };
    }
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

  // Targets are graded from the engine's declared capability set: harness
  // tiers plus one name per contributed fixture. Selection runs at config
  // load, before any engine boots, which is why the manifest is synchronous.
  const capabilities = target.engine?.capabilities;
  const missing = options.requires.filter((capability) => capabilities?.has(capability) !== true);
  if (missing.length > 0) {
    return {
      ...base,
      disposition: 'skip',
      skip: {
        cause: 'capability-unavailable',
        reason: `engine lacks required capabilities: ${missing.join(', ')}`,
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
  // A serial group is one unit per target and agent; members of one variant
  // are selected together and never pull another variant in.
  const selectedSerialUnits = new Set<string>();
  for (const pair of pairs) {
    if (pair.disposition === 'run' && pair.test.serialId !== undefined) {
      selectedSerialUnits.add(`${pair.target.name}::${pair.agent}::${pair.test.serialId}`);
    }
  }
  return pairs.map((pair) => {
    if (pair.test.serialId === undefined) return pair;
    const key = `${pair.target.name}::${pair.agent}::${pair.test.serialId}`;
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
    // A producer the target cannot run - skipped for a missing capability or
    // filtered out by its own platform list - cannot be promoted; a consumer
    // that needs it is a configuration error, not a silent run elsewhere.
    if (pair.disposition === 'skip' || pair.skip?.cause === 'platform-unavailable') {
      throw new CollectionError(
        `setup test ${pair.test.id} is required by a session consumer but cannot run on target "${pair.target.name}": ${pair.skip?.reason ?? ''}`,
      );
    }
    return { ...pair, disposition: 'run' as const, skip: undefined };
  });
}
