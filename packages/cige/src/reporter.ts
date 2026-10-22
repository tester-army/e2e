/**
 * The `cige()` reporter: once the report is written, one run summary per
 * CIGE result, in the format the `cige` skill reads, under `<output>/cige/`.
 * A summary carries pointers, not contents: the report, the trace, the
 * artifacts, the case's `specRef`, `buildRef`, and `expectedRef` with
 * `{build}` and `{environment}` filled in, and the commands that resolve
 * them and replay the case. The classifying agent fetches what it needs,
 * when it needs it. Tests run in worker processes and a reporter in the
 * main one, so it reads the case files again rather than anything the run
 * left in memory.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FinishedRun, Report, Reporter, ReporterSummary, TestFixtures } from 'e2e';

import { readinessGaps } from './check.ts';
import { attemptsOf, classifyResult, type CigeClassification, type CigeFailureType } from './classify.ts';
import { DEFAULT_CASES, fillRef, type CigeConfig } from './config.ts';
import { loadCigeCases } from './load.ts';
import type { CigeClassificationChange, CigePlugin } from './plugins.ts';
import { fileSafe } from './refs.ts';
import type { CigeCase } from './schema.ts';
import { CIGE_TAG, cigeTag } from './suite.ts';
import { caseForVariant } from './variants.ts';

type ReportResult = Report['run']['results'][number];

/** One CIGE run summary: what the `cige` skill reads before it classifies or repairs anything. */
export interface CigeRunSummary {
  readonly testId: string;
  /** The variant that ran, when the case has variants. */
  readonly variant?: string;
  readonly runDate: string;
  readonly build?: string;
  /** `interrupted`: the run stopped before the test reached a verdict (`--max-failures`, a signal); never triaged. */
  readonly result: 'pass' | 'fail' | 'skipped' | 'interrupted';
  readonly intent: string;
  readonly failedStep?: string;
  readonly failureType?: CigeFailureType;
  readonly classification: {
    readonly source: '@e2e-dev/cige';
    readonly confidence: 'heuristic';
    readonly phase?: CigeClassification['phase'];
    readonly errorCode?: string;
    readonly message?: string;
    readonly signals: readonly string[];
    /** The plugins whose `classify` changed this classification, in config order. */
    readonly adjustedBy?: readonly string[];
  };
  /** The case's top-level `x-` keys, then each plugin's `summarize` fields under its name. */
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly specRef?: string;
  readonly buildRef?: string;
  readonly expectedRef?: string;
  /** The command that resolves the refs into files beside the summary, when the config has resolvers. */
  readonly resolveRefs?: string;
  /** How to replay this result once a repair is in: the environment it needs, and the command. */
  readonly replay: { readonly environment?: string; readonly command: string };
  readonly case?: string;
  readonly target: string;
  readonly agent: string;
  readonly attempts: number;
  readonly evidence: {
    readonly report?: string;
    readonly resultId: string;
    readonly trace?: string;
    readonly artifacts: readonly string[];
  };
}

/**
 * The reporter's options: the CIGE config. It reads `cases`, `root` (default
 * the project root), `outputDir`, `build`, `environments`, and `refs`.
 */
export type CigeReporterOptions<Fixtures = TestFixtures> = CigeConfig<Fixtures>;

const SUMMARY_SUFFIX = '.run-summary.json';
const REFS_SUFFIX = '.refs';

/** The case id and variant a result's tags name: `cige:<id>`, and `cige:<id>/<variant>` for a variant. */
function caseOf(result: ReportResult): { readonly id: string; readonly variant?: string } | undefined {
  const prefix = `${CIGE_TAG}:`;
  const id = result.tags.find((name) => name.startsWith(prefix) && !name.includes('/'))?.slice(prefix.length);
  if (id === undefined) return undefined;
  const variant = result.tags.find((name) => name.startsWith(`${prefix}${id}/`))?.slice(prefix.length + id.length + 1);
  return variant === undefined ? { id } : { id, variant };
}

/** What a result's summary files are named after: the case id, and its variant when it has one. */
function summaryNameOf(result: ReportResult): string | undefined {
  const key = caseOf(result);
  return key === undefined ? undefined : key.variant === undefined ? key.id : `${key.id}.${key.variant}`;
}

/** Shell-quotes one argument when it needs it, so a command in a summary pastes as is. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._:/=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}


/** Builds the summary of one result; `testCase` is undefined when its file is no longer among the globs. */
function summarize<Fixtures>(
  run: Pick<FinishedRun, 'report' | 'reportPath' | 'projectRoot' | 'artifactsRoot' | 'traces'>,
  result: ReportResult,
  key: { readonly id: string; readonly variant?: string },
  testCase: CigeCase | undefined,
  options: CigeReporterOptions<Fixtures>,
  carried: boolean,
  shared: boolean,
  outputDir: string,
): CigeRunSummary {
  const { id, variant } = key;
  const { build } = options;
  const fromRoot = (file: string): string => path.relative(run.projectRoot, file).split(path.sep).join('/');
  const first: CigeClassification =
    testCase === undefined
      ? { result: result.status === 'passed' || result.status === 'flaky' ? 'pass' : result.status === 'skipped' || result.status === 'interrupted' ? result.status : 'fail', signals: ['case-not-found'] }
      : classifyResult(testCase, result, run.report);
  const plugins = options.plugins ?? [];
  const { classification, adjustedBy } = testCase === undefined ? { classification: first, adjustedBy: [] } : adjust(first, testCase, result, plugins);
  const context = testCase?.context;
  const environment = context?.environment;
  const refs = {
    specRef: fillRef(context?.specRef, { build, environment }),
    buildRef: fillRef(context?.buildRef, { build, environment }),
    expectedRef: fillRef(context?.expectedRef, { build, environment }),
  };
  const signals = [...classification.signals];
  // A resolver stands in for a pointer, the way `e2e-cige check` counts it.
  if (classification.result === 'fail' && testCase !== undefined) {
    if (refs.specRef === undefined && options.refs?.spec === undefined) signals.push('missing-spec-ref');
    if (refs.buildRef === undefined && options.refs?.build === undefined) signals.push('missing-build-ref');
  }
  if (carried) signals.push('carried-from-earlier-run');
  // When the case ran more than once (targets, agents), the replay names the result's own.
  const narrow = shared ? ['--target', result.targetId, '--agent', result.agent] : [];
  const variantArgs = variant === undefined ? [] : ['--variant', variant];
  const environments = options.environments;
  const replay =
    environments === undefined
      ? {
          command: ['npx', 'e2e', 'run', ...(options.e2eConfig === undefined ? [] : ['--config', options.e2eConfig]), '--tag', cigeTag(id, variant), '--no-cache', ...narrow]
            .map(shellArg)
            .join(' '),
        }
      : {
          ...(environment === undefined ? {} : { environment }),
          command: ['npx', 'e2e-cige', 'replay', id, ...variantArgs, ...(narrow.length === 0 ? [] : ['--', ...narrow])].map(shellArg).join(' '),
        };
  // The refs go beside the summary; name the directory when it isn't the command's default.
  const summaries = fromRoot(outputDir);
  const outputArgs = summaries === '.e2e/cige' ? [] : ['--output', summaries];
  const hasResolvers = options.refs !== undefined && Object.values(options.refs).some((resolver) => resolver !== undefined);
  const attempts = attemptsOf(result, run.report);
  const attempt = attempts.at(-1);
  const artifacts = (attempt?.artifacts ?? []).flatMap((artifact) =>
    artifact.path === undefined ? (artifact.url === undefined ? [] : [artifact.url]) : [fromRoot(path.join(run.artifactsRoot, artifact.path))],
  );
  const trace = run.traces.get(result.id);
  const summary: CigeRunSummary = {
    testId: id,
    ...(variant === undefined ? {} : { variant }),
    runDate: run.report.run.startedAt.slice(0, 10),
    ...(build === undefined ? {} : { build }),
    result: classification.result,
    intent: testCase?.intent.statement ?? result.titlePath.at(-1) ?? id,
    ...(classification.failedStep === undefined ? {} : { failedStep: classification.failedStep }),
    ...(classification.failureType === undefined ? {} : { failureType: classification.failureType }),
    classification: {
      source: '@e2e-dev/cige',
      confidence: 'heuristic',
      ...(classification.phase === undefined ? {} : { phase: classification.phase }),
      ...(classification.errorCode === undefined ? {} : { errorCode: classification.errorCode }),
      ...(classification.message === undefined ? {} : { message: classification.message }),
      signals,
      ...(adjustedBy.length === 0 ? {} : { adjustedBy }),
    },
    ...(refs.specRef === undefined ? {} : { specRef: refs.specRef }),
    ...(refs.buildRef === undefined ? {} : { buildRef: refs.buildRef }),
    ...(refs.expectedRef === undefined ? {} : { expectedRef: refs.expectedRef }),
    ...(hasResolvers ? { resolveRefs: ['npx', 'e2e-cige', 'refs', id, ...variantArgs, ...outputArgs].map(shellArg).join(' ') } : {}),
    replay,
    ...(testCase?.file === undefined ? {} : { case: fromRoot(testCase.file) }),
    target: result.targetId,
    agent: result.agent,
    attempts: attempts.length,
    evidence: {
      ...(run.reportPath === undefined ? {} : { report: fromRoot(run.reportPath) }),
      resultId: result.id,
      ...(trace === undefined ? {} : { trace }),
      artifacts,
    },
  };
  if (testCase === undefined) return summary;
  const extensions: Record<string, unknown> = { ...testCase.extensions };
  for (const plugin of plugins) {
    if (plugin.summarize === undefined) continue;
    try {
      const fields = plugin.summarize({ testCase, summary });
      if (fields !== undefined) extensions[plugin.name] = fields;
    } catch (cause) {
      extensions[plugin.name] = { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return Object.keys(extensions).length === 0 ? summary : { ...summary, extensions };
}

const FAILURE_TYPES: ReadonlySet<CigeFailureType> = new Set(['infrastructure', 'outdated-test-logic', 'product-defect']);

/** The classification without its failure type, for a plugin that clears it. */
function untyped({ failureType: _cleared, ...rest }: CigeClassification): CigeClassification {
  return rest;
}

/**
 * The reporter's first classification after each plugin's `classify`, in
 * config order, and the plugins that changed it. A plugin may set a failure
 * type on a failure only, clear one, and add signals; one that throws adds
 * `plugin-error:<name>` and changes nothing else.
 */
function adjust<Fixtures>(
  first: CigeClassification,
  testCase: CigeCase,
  result: ReportResult,
  plugins: readonly CigePlugin<Fixtures>[],
): { readonly classification: CigeClassification; readonly adjustedBy: readonly string[] } {
  const signals = [...first.signals];
  let failureType = first.failureType;
  const current = (): CigeClassification => ({ ...untyped(first), ...(failureType === undefined ? {} : { failureType }), signals: [...signals] });
  const adjustedBy: string[] = [];
  for (const plugin of plugins) {
    if (plugin.classify === undefined) continue;
    let change: CigeClassificationChange | undefined;
    try {
      change = plugin.classify({ testCase, result, classification: current() });
    } catch {
      signals.push(`plugin-error:${plugin.name}`);
      continue;
    }
    if (change === undefined) continue;
    let changed = false;
    if (change.failureType === null && failureType !== undefined) {
      failureType = undefined;
      changed = true;
    } else if (
      change.failureType !== undefined &&
      change.failureType !== null &&
      change.failureType !== failureType &&
      first.result === 'fail' &&
      FAILURE_TYPES.has(change.failureType)
    ) {
      failureType = change.failureType;
      changed = true;
    }
    // A plugin that only repeats what is there changed nothing, and must not read as a verdict.
    for (const signal of change.signals ?? []) {
      if (signals.includes(signal)) continue;
      signals.push(signal);
      changed = true;
    }
    if (changed) adjustedBy.push(plugin.name);
  }
  return { classification: current(), adjustedBy };
}

/**
 * Removes what an earlier run left in the summary directory before this run
 * writes its own, and nothing else: the directory may hold other files.
 * After a full run every summary and every resolved refs directory goes, so
 * an old verdict never passes for this run's. A run that left CIGE cases out
 * (a tag or file filter, `e2e-cige replay`, `--last-failed`) removes only
 * the summaries of the cases it ran, under either naming, and keeps the
 * rest, refs included: the cases it skipped still stand as last reported.
 */
function clearEarlier(outputDir: string, run: Pick<FinishedRun, 'report' | 'lastRun'>, ran: readonly string[]): void {
  if (!existsSync(outputDir)) return;
  const ranNames = new Set(ran);
  // By summary name, not case id: a run of one variant leaves its siblings out.
  const known = new Set([...ranNames, ...run.report.run.results.flatMap((result) => summaryNameOf(result) ?? [])]);
  const partial = run.lastRun !== undefined || [...known].some((name) => !ranNames.has(name));
  // Longest name first, so a file of `a.b` is never taken for `a`.
  const stems = [...known].map((name) => ({ name, stem: fileSafe(name) })).toSorted((a, b) => b.stem.length - a.stem.length);
  for (const file of readdirSync(outputDir)) {
    const target = path.join(outputDir, file);
    if (file.endsWith(REFS_SUFFIX)) {
      if (!partial) rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (!file.endsWith(SUMMARY_SUFFIX)) continue;
    const stem = file.slice(0, -SUMMARY_SUFFIX.length);
    const owner = stems.find((entry) => stem === entry.stem || stem.startsWith(`${entry.stem}.`));
    if (!partial || (owner !== undefined && ranNames.has(owner.name))) rmSync(target, { force: true });
  }
}

/**
 * The CIGE reporter. Writes `<output>/cige/<id>.run-summary.json` for each
 * CIGE result the run selected (`<id>.<variant>.run-summary.json` for a
 * variant), and for each failure a `--last-failed` rerun carried without
 * running it again; a case that ran on several targets or as several agents
 * gets one file per result, named after both.
 * Summaries an earlier run left there are removed first, unless this run is
 * a `--last-failed` rerun, whose untouched cases keep theirs. Nothing else in
 * the directory is removed.
 */
export function cige<Fixtures extends TestFixtures = TestFixtures>(options: CigeReporterOptions<Fixtures> = {}): Reporter {
  return {
    name: 'cige',
    async onRunFinished(run): Promise<ReporterSummary | void> {
      if (run.reportPath === undefined) return;
      const outputDir = path.resolve(run.projectRoot, options.outputDir ?? path.join(path.dirname(run.reportPath), 'cige'));
      const isCige = (result: ReportResult): boolean => caseOf(result) !== undefined;
      const selected = run.report.run.results.filter((result) => result.selected && isCige(result));
      const carried = (run.report.run.carried?.results ?? []).filter(isCige);
      const results = [...selected.map((result) => ({ result, carried: false })), ...carried.map((result) => ({ result, carried: true }))];
      clearEarlier(outputDir, run, results.map(({ result }) => summaryNameOf(result)!));
      if (results.length === 0) return;
      const cases = new Map(
        loadCigeCases(options.cases ?? DEFAULT_CASES, { root: options.root ?? run.projectRoot }).map((testCase) => [testCase.id, testCase]),
      );
      mkdirSync(outputDir, { recursive: true });
      const keyOf = (result: ReportResult): { readonly id: string; readonly variant?: string } => caseOf(result)!;
      const perCase = new Map<string, number>();
      for (const { result } of results) perCase.set(summaryNameOf(result)!, (perCase.get(summaryNameOf(result)!) ?? 0) + 1);
      const counts = { pass: 0, fail: 0, skipped: 0, interrupted: 0 };
      for (const { result, carried: wasCarried } of results) {
        const key = keyOf(result);
        const base = summaryNameOf(result)!;
        const loaded = cases.get(key.id);
        const testCase = loaded === undefined ? undefined : caseForVariant(loaded, key.variant);
        const shared = perCase.get(base) !== 1;
        const summary = summarize(run, result, key, testCase, options, wasCarried, shared, outputDir);
        counts[summary.result] += 1;
        const name = shared ? [base, result.targetId, result.agent, ...(result.repeat === 0 ? [] : [String(result.repeat)])].join('.') : base;
        writeFileSync(path.join(outputDir, `${fileSafe(name)}${SUMMARY_SUFFIX}`), `${JSON.stringify(summary, null, 2)}\n`);
      }
      const shown = path.relative(run.projectRoot, outputDir) || '.';
      const interrupted = counts.interrupted === 0 ? '' : `, ${counts.interrupted} interrupted`;
      const rows = [{ label: 'CIGE', text: `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped${interrupted}: ${shown}` }];
      // Said on every run, not only at the first failure: a case without refs can't be triaged when it matters.
      const ran = [...new Set(results.map(({ result }) => keyOf(result).id))].flatMap((id) => {
        const testCase = cases.get(id);
        return testCase === undefined ? [] : [testCase];
      });
      const unready = ran.filter((testCase) => readinessGaps(testCase, options).length > 0).length;
      if (unready > 0) {
        rows.push({
          label: 'CIGE gaps',
          text: `${unready} case${unready === 1 ? '' : 's'} can't be fully classified or replayed: npx e2e-cige check`,
        });
      }
      return rows;
    },
  };
}
