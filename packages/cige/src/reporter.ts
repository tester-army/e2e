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
  readonly result: 'pass' | 'fail' | 'skipped';
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
  };
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

/** Shell-quotes one argument when it needs it, so a command in a summary pastes as is. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._:/=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
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
): CigeRunSummary {
  const { id, variant } = key;
  const { build } = options;
  const fromRoot = (file: string): string => path.relative(run.projectRoot, file).split(path.sep).join('/');
  const classification: CigeClassification =
    testCase === undefined
      ? { result: result.status === 'passed' || result.status === 'flaky' ? 'pass' : result.status === 'skipped' ? 'skipped' : 'fail', signals: ['case-not-found'] }
      : classifyResult(testCase, result, run.report);
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
      ? { command: ['npx', 'e2e', 'run', '--tag', cigeTag(id, variant), '--no-cache', ...narrow].map(shellArg).join(' ') }
      : {
          ...(environment === undefined ? {} : { environment }),
          command: ['npx', 'e2e-cige', 'replay', id, ...variantArgs, ...(narrow.length === 0 ? [] : ['--', ...narrow])].map(shellArg).join(' '),
        };
  const hasResolvers = options.refs !== undefined && Object.values(options.refs).some((resolver) => resolver !== undefined);
  const attempts = attemptsOf(result, run.report);
  const attempt = attempts.at(-1);
  const artifacts = (attempt?.artifacts ?? []).flatMap((artifact) =>
    artifact.path === undefined ? (artifact.url === undefined ? [] : [artifact.url]) : [fromRoot(path.join(run.artifactsRoot, artifact.path))],
  );
  const trace = run.traces.get(result.id);
  return {
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
    },
    ...(refs.specRef === undefined ? {} : { specRef: refs.specRef }),
    ...(refs.buildRef === undefined ? {} : { buildRef: refs.buildRef }),
    ...(refs.expectedRef === undefined ? {} : { expectedRef: refs.expectedRef }),
    ...(hasResolvers ? { resolveRefs: ['npx', 'e2e-cige', 'refs', id, ...variantArgs].map(shellArg).join(' ') } : {}),
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
      // A summary from an earlier run must not pass for this one's, even when
      // this run has none to write, and neither may the refs resolved for it.
      // Only those go: the directory may be one the project keeps other files
      // in. A `--last-failed` rerun keeps them, since the cases it did not
      // select still stand as last reported.
      if (run.lastRun === undefined && existsSync(outputDir)) {
        for (const file of readdirSync(outputDir)) {
          if (file.endsWith(SUMMARY_SUFFIX) || file.endsWith(REFS_SUFFIX)) rmSync(path.join(outputDir, file), { recursive: true, force: true });
        }
      }
      const isCige = (result: ReportResult): boolean => caseOf(result) !== undefined;
      const selected = run.report.run.results.filter((result) => result.selected && isCige(result));
      const carried = (run.report.run.carried?.results ?? []).filter(isCige);
      const results = [...selected.map((result) => ({ result, carried: false })), ...carried.map((result) => ({ result, carried: true }))];
      if (results.length === 0) return;
      const cases = new Map(
        loadCigeCases(options.cases ?? DEFAULT_CASES, { root: options.root ?? run.projectRoot }).map((testCase) => [testCase.id, testCase]),
      );
      mkdirSync(outputDir, { recursive: true });
      const keyOf = (result: ReportResult): { readonly id: string; readonly variant?: string } => caseOf(result)!;
      const nameOf = (key: { readonly id: string; readonly variant?: string }): string => (key.variant === undefined ? key.id : `${key.id}.${key.variant}`);
      const perCase = new Map<string, number>();
      for (const { result } of results) perCase.set(nameOf(keyOf(result)), (perCase.get(nameOf(keyOf(result))) ?? 0) + 1);
      const counts = { pass: 0, fail: 0, skipped: 0 };
      for (const { result, carried: wasCarried } of results) {
        const key = keyOf(result);
        const base = nameOf(key);
        const loaded = cases.get(key.id);
        const testCase = loaded === undefined ? undefined : caseForVariant(loaded, key.variant);
        const shared = perCase.get(base) !== 1;
        const summary = summarize(run, result, key, testCase, options, wasCarried, shared);
        counts[summary.result] += 1;
        const name = shared ? [base, result.targetId, result.agent, ...(result.repeat === 0 ? [] : [String(result.repeat)])].join('.') : base;
        writeFileSync(path.join(outputDir, `${fileSafe(name)}${SUMMARY_SUFFIX}`), `${JSON.stringify(summary, null, 2)}\n`);
      }
      const shown = path.relative(run.projectRoot, outputDir) || '.';
      const rows = [{ label: 'CIGE', text: `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped: ${shown}` }];
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
