/** The per-session `trace.md` a hosted attempt writes at close, through the run report's renderer. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { buildReport } from '../report/build.ts';
import { renderTracePage } from '../report/failure-text.ts';
import { outcome } from '../report/outcome.ts';
import { toPosixPath, writeTextReport } from '../report/write.ts';
import type { AttemptRecord, ResultRecord } from './records.ts';

export interface HostTraceOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly testId: string;
  /** The session name, already redacted. */
  readonly title: string;
  readonly agent: string;
  readonly attempt: AttemptRecord;
  /** The results directory the page's artifact links resolve against. */
  readonly resultsDir: string;
  /** Path segments of the attempt's directory under `resultsDir`. */
  readonly segments: readonly string[];
  readonly tracePath: string;
  readonly redact: (text: string) => string;
}

/** Writes one session's trace page as a single-result run, so it reads like `e2e run`'s. */
export async function writeHostTrace(options: HostTraceOptions): Promise<void> {
  const { config, attempt, title } = options;
  const status = attempt.status;
  const result: ResultRecord = {
    test: { id: options.testId, kind: 'test', title, titlePath: [title], file: 'host', declarationIndex: 0, sessions: [], tags: [], source: undefined, serialId: undefined },
    target: options.target, agent: options.agent, repeat: 0, selected: true, status, attempts: [attempt],
  };
  const report = buildReport({
    config, runId: options.runId, startedAt: attempt.startedAt,
    status: status === 'interrupted' ? 'interrupted' : status === 'passed' ? 'passed' : 'failed',
    exitCode: status === 'interrupted' ? 130 : status === 'passed' ? 0 : 1,
    results: [result], serialGroups: [], runErrors: [], targetProvenance: new Map(),
  });
  const reported = report.run.results[0]!;
  const page = renderTracePage(report, reported, outcome(reported, new Map()), {
    standalone: true,
    artifactsDir: toPosixPath(path.relative(config.projectRoot, options.resultsDir)),
    pageDir: toPosixPath(path.join(...options.segments)),
    readArtifact: (reportPath) => {
      try { return readFileSync(path.join(options.resultsDir, reportPath), 'utf8'); } catch { return undefined; }
    },
  });
  await writeTextReport(options.tracePath, options.redact(page));
}
