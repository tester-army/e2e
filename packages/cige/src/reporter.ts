/**
 * The `cige()` reporter: once the report is written, one run summary per
 * CIGE result, in the format the CIGE skills read, under `<output>/cige/`.
 * A summary carries pointers, not contents: the report, the trace, the
 * artifacts, and the case's `specRef` and `buildRef`, which the classifying
 * agent fetches only when it needs them. Tests run in worker processes and
 * a reporter in the main one, so it reads the case files again rather than
 * anything the run left in memory.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FinishedRun, Report, Reporter, ReporterSummary } from 'e2e';

import { classifyResult, type CigeClassification, type CigeFailureType } from './classify.ts';
import { loadCigeCases, type CigeRoot } from './load.ts';
import type { CigeCase } from './schema.ts';
import { CIGE_TAG } from './suite.ts';

type ReportResult = Report['run']['results'][number];

/** One CIGE run summary: what `cige-failure-classification` reads before any repair. */
export interface CigeRunSummary {
  readonly testId: string;
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

export interface CigeReporterOptions {
  /** Globs of the `.cige.json` files the suite registers; default every `*.cige.json` under `tests/`. */
  readonly cases?: string | readonly string[];
  /** Directory the globs resolve against; default the project root. */
  readonly root?: CigeRoot;
  /** The directory summaries go to; default `cige` beside `report.json`. */
  readonly outputDir?: string;
  /** The build under test, copied into every summary as `build`, such as a version or a commit. */
  readonly build?: string | undefined;
}

const DEFAULT_CASES = 'tests/**/*.cige.json';
const SUMMARY_SUFFIX = '.run-summary.json';

function caseId(result: ReportResult): string | undefined {
  const tag = result.tags.find((name) => name.startsWith(`${CIGE_TAG}:`));
  return tag?.slice(CIGE_TAG.length + 1);
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/** Builds the summary of one result; `testCase` is undefined when its file is no longer among the globs. */
function summarize(
  run: Pick<FinishedRun, 'report' | 'reportPath' | 'projectRoot' | 'artifactsRoot' | 'traces'>,
  result: ReportResult,
  id: string,
  testCase: CigeCase | undefined,
  build?: string,
): CigeRunSummary {
  const fromRoot = (file: string): string => path.relative(run.projectRoot, file).split(path.sep).join('/');
  const classification: CigeClassification =
    testCase === undefined
      ? { result: result.status === 'passed' || result.status === 'flaky' ? 'pass' : result.status === 'skipped' ? 'skipped' : 'fail', signals: ['case-not-found'] }
      : classifyResult(testCase, result);
  const attempt = result.attempts.at(-1);
  const artifacts = (attempt?.artifacts ?? []).flatMap((artifact) =>
    artifact.path === undefined ? (artifact.url === undefined ? [] : [artifact.url]) : [fromRoot(path.join(run.artifactsRoot, artifact.path))],
  );
  const trace = run.traces.get(result.id);
  return {
    testId: id,
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
      signals: classification.signals,
    },
    ...(testCase?.context.specRef === undefined ? {} : { specRef: testCase.context.specRef }),
    ...(testCase?.context.buildRef === undefined ? {} : { buildRef: testCase.context.buildRef }),
    ...(testCase?.file === undefined ? {} : { case: fromRoot(testCase.file) }),
    target: result.targetId,
    agent: result.agent,
    attempts: result.attempts.length,
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
 * CIGE result the run selected; a case that ran on several targets or as
 * several agents gets one file per result, named after both. Summaries an
 * earlier run left there are removed first; nothing else in the directory is.
 */
export function cige(options: CigeReporterOptions = {}): Reporter {
  return {
    name: 'cige',
    async onRunFinished(run): Promise<ReporterSummary | void> {
      if (run.reportPath === undefined) return;
      const selected = run.report.run.results.filter((result) => result.selected && caseId(result) !== undefined);
      if (selected.length === 0) return;
      const cases = new Map(
        loadCigeCases(options.cases ?? DEFAULT_CASES, { root: options.root ?? run.projectRoot }).map((testCase) => [testCase.id, testCase]),
      );
      const outputDir = path.resolve(run.projectRoot, options.outputDir ?? path.join(path.dirname(run.reportPath), 'cige'));
      mkdirSync(outputDir, { recursive: true });
      // A summary from an earlier run must not pass for this one's. Only
      // summaries go: the directory may be one the project keeps other files in.
      for (const file of readdirSync(outputDir)) {
        if (file.endsWith(SUMMARY_SUFFIX)) rmSync(path.join(outputDir, file), { force: true });
      }
      const perCase = new Map<string, number>();
      for (const result of selected) perCase.set(caseId(result)!, (perCase.get(caseId(result)!) ?? 0) + 1);
      const counts = { pass: 0, fail: 0, skipped: 0 };
      for (const result of selected) {
        const id = caseId(result)!;
        const summary = summarize(run, result, id, cases.get(id), options.build);
        counts[summary.result] += 1;
        const name = perCase.get(id) === 1 ? id : [id, result.targetId, result.agent, ...(result.repeat === 0 ? [] : [String(result.repeat)])].join('.');
        writeFileSync(path.join(outputDir, `${fileSafe(name)}${SUMMARY_SUFFIX}`), `${JSON.stringify(summary, null, 2)}\n`);
      }
      const shown = path.relative(run.projectRoot, outputDir) || '.';
      return [{ label: 'CIGE', text: `${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped: ${shown}` }];
    },
  };
}
