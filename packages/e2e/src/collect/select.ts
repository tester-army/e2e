/** Option resolution and test-target selection. */

import { ConfigurationError, CollectionError } from '../internal/errors.ts';
import { resultId } from '../internal/ids.ts';
import { didYouMean, suggestionNote } from '../internal/suggest.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import type { ResolvedRecording } from '../internal/recording-modes.ts';
import type { Capability, RecordingMode, TestOptions } from '../types.ts';
import { excludingEntry, type Collection, type CollectedTest, type UncollectedFile } from './collect.ts';
import { groupChain } from './registry.ts';

export interface ResolvedTestOptions {
  readonly timeout: number;
  readonly retries: number;
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
  /**
   * The test's own `video`, innermost layer first; undefined leaves it to
   * the target (`pairVideo`). A serial group records one video per group
   * attempt, so its members share the group's value.
   */
  readonly video: RecordingMode | undefined;
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
    | 'infrastructure-unavailable'
    | 'failure-limit';
  readonly reason: string;
  readonly relatedId?: string;
}

export interface TestTargetPair {
  readonly test: CollectedTest;
  readonly target: ResolvedTarget;
  /** The configured agent this pair runs as: one of `options.agents`. */
  readonly agent: string;
  /**
   * Which run of the test this is under `--repeat-each`: 0 for the one every
   * run has, then 1 through `n - 1`. Part of the pair's identity with the
   * test, the target, and the agent.
   */
  readonly repeat: number;
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

/** How several `--tag` values combine: a test carries any of them, or every one. */
export type TagMode = 'any' | 'all';

/** One shard of a run split `total` ways, `index` counted from 1 (`--shard 2/3`). */
export interface Shard {
  readonly index: number;
  readonly total: number;
}

export interface SelectionFilters {
  readonly tags?: readonly string[];
  readonly tagMode?: TagMode;
  /** Tags that leave a test out whatever else selects it (`--exclude-tag`). */
  readonly excludeTags?: readonly string[];
  /** Patterns a test's title must match, any of them (`--grep`); see `grepText`. */
  readonly grep?: readonly RegExp[];
  /** Patterns that leave a test out when its title matches any of them (`--grep-invert`). */
  readonly grepInvert?: readonly RegExp[];
  /**
   * The result ids (`resultId(testId, target, agent)`) of the tests the
   * previous run did not pass (`--last-failed`): only those run, and the
   * consumers of a setup among them. Empty means nothing failed, so nothing
   * is selected.
   */
  readonly lastFailed?: ReadonlySet<string>;
  /** The one shard of the selection to run, once every other filter applied (`--shard`). */
  readonly shard?: Shard;
  readonly targetIds?: readonly string[];
}

/**
 * The reasons a `filtered` pair carries. `classifyPair` writes them and
 * `describeNoTests` reads them back, so they are shared constants; the
 * strings also reach the report on unselected results, which is why they
 * are prose rather than codes.
 */
const FILTERED_REASON = {
  file: 'file not selected by a positional argument',
  line: 'not declared at a line a positional named',
  focus: 'not focused by .only',
  tags: 'tag filter did not match',
  excludedTag: 'carries an excluded tag',
  grep: 'title does not match --grep',
  grepInvert: 'title matches --grep-invert',
  lastFailed: 'did not fail in the last run',
  shard: 'outside the shard',
} as const;

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
  let video: TestOptions['video'];
  const agentContextParts: string[] = [];

  for (const layer of layers) {
    if (layer.timeout !== undefined) timeout = layer.timeout;
    if (layer.retries !== undefined) retries = layer.retries;
    if (layer.video !== undefined) video = layer.video;
    if (layer.platforms !== undefined) platforms = layer.platforms;
    if (layer.requires !== undefined) requires = layer.requires;
    if (layer.session !== undefined) session = layer.session;
    if (layer.agent !== undefined) pin = typeof layer.agent === 'string' ? [layer.agent] : layer.agent;
    if (layer.agentContext !== undefined) agentContextParts.push(layer.agentContext);
    if (layer.skip !== undefined && layer.skip !== false) {
      skipReason = typeof layer.skip === 'string' ? layer.skip : 'skipped';
    }
  }

  // Retries and recordings belong to the serial unit: one retry loop and one
  // shared session, so one video, per group attempt.
  const serialRoot = test.serialRoot;
  if (serialRoot !== undefined) {
    let serialRetries = config.retries;
    let serialVideo: TestOptions['video'];
    for (const group of chain) {
      if (group.options.retries !== undefined) serialRetries = group.options.retries;
      if (group.options.video !== undefined) serialVideo = group.options.video;
      if (group === serialRoot) break;
    }
    retries = serialRetries;
    video = serialVideo;
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
    platforms,
    requires,
    session,
    agents: effectiveAgents(test, pin, config.agentNames),
    agentContext: agentContextParts.length === 0 ? undefined : agentContextParts.join('\n'),
    skipReason,
    serial: serialRoot !== undefined,
    video,
  };
}

/**
 * Which attempts of a pair record a video, and where the mode came from: the
 * test's own, else its target's (which the flag and the config already
 * decided).
 */
export function pairVideo(pair: Pick<TestTargetPair, 'options' | 'target'>): ResolvedRecording {
  const own = pair.options.video;
  return own === undefined ? pair.target.video : { mode: own, source: 'test' };
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

/** Whether a test's declared tags satisfy the filter: any of the filter's tags, or every one under `all`. */
function matchesTags(declared: readonly string[], tags: readonly string[] | undefined, tagMode: TagMode): boolean {
  if (tags === undefined || tags.length === 0) return true;
  const has = (tag: string): boolean => declared.includes(tag);
  return tagMode === 'all' ? tags.every(has) : tags.some(has);
}

/**
 * The text `--grep` and `--grep-invert` match: the describe titles and the
 * test title joined by one space (`checkout pays`). The file is not part of
 * it, positionals select files; nor are tags, `--tag` selects those.
 */
function grepText(test: Pick<CollectedTest, 'titlePath'>): string {
  return test.titlePath.join(' ');
}

/** Whether any of the patterns matches the text; none given matches nothing, so callers guard for the filter being absent. */
function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  // A global or sticky pattern remembers where its last match ended; every test is matched from the start.
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** The pattern-shaped filters, present only when they hold at least one pattern. */
function patternFilters(filters: SelectionFilters): { grep: readonly RegExp[] | undefined; grepInvert: readonly RegExp[] | undefined } {
  const present = (patterns: readonly RegExp[] | undefined): readonly RegExp[] | undefined =>
    patterns !== undefined && patterns.length > 0 ? patterns : undefined;
  return { grep: present(filters.grep), grepInvert: present(filters.grepInvert) };
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
  const selectedFiles = new Set(collection.files.filter((file) => file.selected).map((file) => file.file));

  assertSerialAgentsAgree(collection.tests, optionsByTest);
  const sessionProducers = collectSessionProducers(collection.tests);
  const pairFilters =
    filters.lastFailed === undefined
      ? filters
      : { ...filters, lastFailed: withSetupConsumers(filters.lastFailed, collection.tests, targets, optionsByTest, sessionProducers) };

  // One pair per target, test, and agent the test runs as, in that order,
  // so a persona sweep reports its variants side by side.
  const pairs: TestTargetPair[] = [];
  for (const target of targets) {
    for (const test of collection.tests) {
      const options = optionsByTest.get(test.id)!;
      for (const agent of options.agents) {
        pairs.push(classifyPair(test, target, agent, options, focused, selectedFiles, pairFilters, tagMode));
      }
    }
  }

  const withClosure = applySerialClosure(pairs);
  const withShard = filters.shard === undefined ? withClosure : applyShard(withClosure, filters.shard);
  const withSessions = applySessionSelection(withShard, sessionProducers, collection.uncollected);

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

/**
 * The selection with every runnable ordinary pair run `times` times: the
 * pair itself, then a copy per further repeat right after it, so a test's
 * runs are adjacent in report order. Setup tests run once whatever the
 * count, and a filtered or skipped pair is reported once.
 */
export function repeatEach(selection: Selection, times: number): Selection {
  if (times <= 1) return selection;
  const expand = (pairs: readonly TestTargetPair[]): TestTargetPair[] =>
    pairs.flatMap((pair) => {
      if (pair.disposition !== 'run' || pair.test.kind !== 'test') return [pair];
      return Array.from({ length: times }, (_, repeat) => ({ ...pair, repeat }));
    });
  return {
    pairs: expand(selection.pairs),
    perTarget: selection.perTarget.map(({ target, pairs }) => ({ target, pairs: expand(pairs) })),
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
 * Why nothing is runnable, told from the most upstream cause: a `!` entry
 * excluding the file a positional names, the globs matched no file (naming
 * look-alike files when there are any), a positional
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
  const exclusions = new Map(
    unmatchedPositionals.map((positional) => [positional, excludingEntry(config.projectRoot, config.tests, positional)]),
  );
  const excludedNote = (positional: string): string => {
    const entry = exclusions.get(positional);
    return entry === undefined ? '' : ` (excluded by the tests entry ${JSON.stringify(entry)})`;
  };
  const excluded = unmatchedPositionals.filter((positional) => exclusions.get(positional) !== undefined);
  if (discovered.length === 0 && excluded.length > 0) {
    return `no test file matched ${excluded.map((positional) => `${positional}${excludedNote(positional)}`).join(', ')}; the config globs discovered no file`;
  }
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
      .map((positional) => `${positional}${excludedNote(positional) || suggestionNote(positional, discovered) || suggestionNote(positional, baseNames)}`)
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
  // Told once for the run, against every tag the suite declares, and applied
  // only to the pairs the tag filter itself left out: a test a positional or
  // a `.only` excluded is not a tag mismatch.
  const declaredTags = [...new Set(pairs.flatMap((pair) => pair.test.tags))];
  const tagFilter =
    filters.tags === undefined || filters.tags.length === 0
      ? undefined
      : describeTagFilter(filters.tags, filters.tagMode ?? 'any', declaredTags);
  const { grep, grepInvert } = patternFilters(filters);
  const filterNames = new Map<string, string | undefined>([
    [FILTERED_REASON.line, describeLines(collection)],
    [FILTERED_REASON.tags, tagFilter],
    [FILTERED_REASON.excludedTag, filters.excludeTags === undefined ? undefined : `carry one of the excluded tags ${nameTags(filters.excludeTags, declaredTags)}`],
    [FILTERED_REASON.grep, grep === undefined ? undefined : `have titles matching none of ${grep.join(', ')}`],
    [FILTERED_REASON.grepInvert, grepInvert === undefined ? undefined : `have titles matching ${grepInvert.join(', ')}`],
    [
      FILTERED_REASON.lastFailed,
      filters.lastFailed === undefined ? undefined : `${FILTERED_REASON.lastFailed}${filters.lastFailed.size === 0 ? ', which had no failures' : ''}`,
    ],
    [FILTERED_REASON.shard, filters.shard === undefined ? undefined : describeShard(filters.shard, pairs)],
  ]);
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
        count(filterNames.get(pair.skip.reason) ?? pair.skip.reason, pair.test);
        break;
      default:
        count('unselected', pair.test);
    }
  }
  const summary = [...reasons].map(([reason, ids]) => `${ids.size} ${reason}`).join(', ');
  return `${tests.length} tests were collected but none is runnable: ${summary}`;
}

/**
 * The shard that left nothing runnable, with what it was cut from: `fall
 * outside shard 4/4 (3 tests split across 4 shards)`.
 */
function describeShard(shard: Shard, pairs: readonly TestTargetPair[]): string {
  // Told after the cut, so the items are the running pairs and the ones the shard itself left out.
  const items = shardItems(pairs, (pair) => pair.disposition === 'run' || pair.skip?.reason === FILTERED_REASON.shard).length;
  return `fall outside shard ${shard.index}/${shard.total} (${items} ${items === 1 ? 'test' : 'tests'} split across ${shard.total} shards)`;
}

/**
 * The `file:line` positionals that named no test, each with the lines its
 * file declares tests at, so the next edit is a line number away:
 * `tests/a.e2e.ts:9 names no test (declared at lines 3, 7)`. Undefined when
 * every named line found its test.
 */
function describeLines(collection: Collection): string | undefined {
  const missed = collection.files.flatMap((file) => {
    if (file.lines === undefined) return [];
    const declared = file.declaredLines ?? [];
    const misses = file.lines.filter((line) => !declared.includes(line));
    if (misses.length === 0) return [];
    const where =
      declared.length === 0 ? 'the file declares no test itself' : `declared at ${declared.length === 1 ? 'line' : 'lines'} ${declared.join(', ')}`;
    return [`${misses.map((line) => `${file.file}:${line}`).join(', ')} ${misses.length === 1 ? 'names' : 'name'} no test (${where})`];
  });
  return missed.length === 0 ? undefined : `${FILTERED_REASON.line}: ${missed.join('; ')}`;
}

/**
 * The tag filter that left nothing runnable, told against the tags the suite
 * declares: `carry none of the tags a, b`, or under `all` mode `do not carry
 * all of the tags a, b`. A filter tag no test declares is marked, with the
 * nearest declared tag when one is close: `smok (did you mean smoke?)`.
 */
function describeTagFilter(tags: readonly string[], tagMode: TagMode, declared: readonly string[]): string {
  const named = nameTags(tags, declared);
  return tagMode === 'all' ? `do not carry all of the tags ${named}` : `carry none of the tags ${named}`;
}

/** Filter tags as a list, each one no test declares marked, with the nearest declared tag when one is close. */
function nameTags(tags: readonly string[], declared: readonly string[]): string {
  return tags
    .map((tag) => (declared.includes(tag) ? tag : `${tag}${suggestionNote(tag, declared) || ' (no test declares it)'}`))
    .join(', ');
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

/**
 * `--last-failed` widened to the consumers of every setup it names. A setup
 * runs only for a selected test that needs its session, so a setup whose
 * `afterAll` failed while its consumers passed comes back through them.
 */
function withSetupConsumers(
  lastFailed: ReadonlySet<string>,
  tests: readonly CollectedTest[],
  targets: readonly ResolvedTarget[],
  optionsByTest: ReadonlyMap<string, ResolvedTestOptions>,
  sessionProducers: ReadonlyMap<string, CollectedTest>,
): ReadonlySet<string> {
  const widened = new Set(lastFailed);
  for (const target of targets) {
    for (const test of tests) {
      const options = optionsByTest.get(test.id)!;
      const producer = options.session === undefined ? undefined : sessionProducers.get(options.session);
      if (producer === undefined) continue;
      const rerun = optionsByTest.get(producer.id)!.agents.some((agent) => lastFailed.has(resultId(producer.id, target.name, agent)));
      if (rerun) for (const agent of options.agents) widened.add(resultId(test.id, target.name, agent));
    }
  }
  return widened;
}

function classifyPair(
  test: CollectedTest,
  target: ResolvedTarget,
  agent: string,
  options: ResolvedTestOptions,
  focused: readonly CollectedTest[],
  selectedFiles: ReadonlySet<string>,
  filters: SelectionFilters,
  tagMode: TagMode,
): TestTargetPair {
  const base = { test, target, agent, repeat: 0, options };

  if (test.kind === 'test') {
    // A file no positional named is collected for its setup tests only; its
    // ordinary tests are unselected, exactly as a tag filter leaves them. In
    // a file named as `file:line`, so are the tests at other lines.
    if (!test.selected) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: selectedFiles.has(test.file) ? FILTERED_REASON.line : FILTERED_REASON.file },
      };
    }
    if (focused.length > 0 && test.mode !== 'only') {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.focus },
      };
    }
    if (!matchesTags(test.tags, filters.tags, tagMode)) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.tags },
      };
    }
    if (filters.excludeTags?.some((tag) => test.tags.includes(tag)) === true) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.excludedTag },
      };
    }
    const { grep, grepInvert } = patternFilters(filters);
    if (grep !== undefined && !matchesAny(grep, grepText(test))) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.grep },
      };
    }
    if (grepInvert !== undefined && matchesAny(grepInvert, grepText(test))) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.grepInvert },
      };
    }
    if (filters.lastFailed !== undefined && !filters.lastFailed.has(resultId(test.id, target.name, agent))) {
      return {
        ...base,
        disposition: 'filtered',
        skip: { cause: 'filtered', reason: FILTERED_REASON.lastFailed },
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

  // Targets are graded from the engine's declared capability set (harness
  // tiers plus one name per contributed fixture) and the kind of app the
  // target declares. Selection runs at config load, before any engine boots,
  // which is why the manifest is synchronous.
  const capabilities = target.engine?.capabilities;
  const kinds = appKinds(target);
  const missing = options.requires.filter((capability) => capabilities?.has(capability) !== true && !kinds.includes(capability));
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

/**
 * What a shard is cut from: the ordinary pairs `included` (the runnable
 * ones, at the cut), a serial group counting once per target and agent so it
 * is never split, in report order. The key doubles as the pair's item id.
 */
function shardItems(
  pairs: readonly TestTargetPair[],
  included: (pair: TestTargetPair) => boolean = (pair) => pair.disposition === 'run',
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (pair.test.kind !== 'test' || !included(pair)) continue;
    const item = shardItem(pair);
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items;
}

function shardItem(pair: TestTargetPair): string {
  return `${pair.target.name}::${pair.agent}::${pair.test.serialId ?? pair.test.id}`;
}

/**
 * Keeps the shard's contiguous slice of the items and leaves the rest
 * unselected. Contiguous rather than dealt round-robin so a shard's tests
 * come from as few files as possible; the slices differ in size by at most
 * one item, the first shards taking the remainder. Applied after every other
 * filter and the serial closure, before the setup tests are chosen, so each
 * shard brings only the setups it needs.
 */
function applyShard(pairs: readonly TestTargetPair[], shard: Shard): TestTargetPair[] {
  const items = shardItems(pairs);
  const size = Math.floor(items.length / shard.total);
  const remainder = items.length % shard.total;
  const from = (shard.index - 1) * size + Math.min(shard.index - 1, remainder);
  const to = from + size + (shard.index - 1 < remainder ? 1 : 0);
  const kept = new Set(items.slice(from, to));
  return pairs.map((pair) => {
    if (pair.disposition !== 'run' || pair.test.kind !== 'test' || kept.has(shardItem(pair))) return pair;
    return { ...pair, disposition: 'filtered' as const, skip: { cause: 'filtered' as const, reason: FILTERED_REASON.shard } };
  });
}

function applySessionSelection(
  pairs: readonly TestTargetPair[],
  sessionProducers: ReadonlyMap<string, CollectedTest>,
  uncollected: readonly UncollectedFile[],
): TestTargetPair[] {
  /** Each needed setup, by target and producer, with the sessions a selected test consumes from it. */
  const neededSetups = new Map<string, Set<string>>();
  for (const pair of pairs) {
    if (pair.disposition !== 'run' || pair.options.session === undefined) continue;
    const producer = sessionProducers.get(pair.options.session);
    if (producer === undefined) {
      // The setup may be in a file a narrowed run could not collect; its error is then the cause.
      const cause =
        uncollected.length === 0
          ? ''
          : `; it may be declared in a file that failed to collect: ${nameFiles(uncollected.map((entry) => `${entry.file} (${entry.reason})`))}`;
      const declared = [...sessionProducers.keys()];
      const known =
        declared.length === 0
          ? '; no collected setup test declares a session'
          : `; setup tests declare ${declared.map((name) => `"${name}"`).join(', ')}${didYouMean(pair.options.session, declared)}`;
      throw new CollectionError(
        `test "${pair.test.titlePath.join(' > ')}" in ${pair.test.file} consumes session "${pair.options.session}" but no setup test produces it${known}${cause}`,
      );
    }
    const key = `${pair.target.name}::${producer.id}`;
    const sessions = neededSetups.get(key) ?? new Set<string>();
    sessions.add(pair.options.session);
    neededSetups.set(key, sessions);
  }
  return pairs.map((pair) => {
    if (pair.test.kind !== 'setup') return pair;
    const key = `${pair.target.name}::${pair.test.id}`;
    const sessions = neededSetups.get(key);
    if (sessions === undefined) return pair;
    // A producer the target cannot run - skipped for a missing capability or
    // filtered out by its own platform list - cannot be promoted; a consumer
    // that needs it is a configuration error, not a silent run elsewhere.
    if (pair.disposition === 'skip' || pair.skip?.cause === 'platform-unavailable') {
      throw new CollectionError(
        `setup test ${pair.test.id} is required by a session consumer but cannot run on target "${pair.target.name}": ${pair.skip?.reason ?? ''}`,
      );
    }
    // Saving and restoring a session ride the engine's state capability;
    // refused here, before the setup runs its login only to fail at save.
    const engine = pair.target.engine;
    if (engine !== undefined && !engine.capabilities.has('state')) {
      throw new CollectionError(
        `setup test ${pair.test.id} saves session ${[...sessions].map((name) => `"${name}"`).join(', ')} for a selected test, but target "${pair.target.name}" cannot save or restore a session: engine ${engine.name}, as configured, has no state capability`,
      );
    }
    return { ...pair, disposition: 'run' as const, skip: undefined };
  });
}

/**
 * The kinds of app a target declares, which `requires` filters on beside
 * the engine's capabilities: `browser` for an app at a URL, `native-app` for
 * an installed app or a build a device launches.
 */
function appKinds(target: ResolvedTarget): readonly string[] {
  const { base, bundleId, appPath } = target.app;
  return [...(base === undefined ? [] : ['browser']), ...(bundleId === undefined && appPath === undefined ? [] : ['native-app'])];
}
