/**
 * The traces a run keeps: one markdown page per test whose `trace` mode kept
 * one (by default each that failed, timed out, or was flaky), under
 * `<output>/traces/`, telling the whole attempt (each step with what it did,
 * the cache's decisions, what the app logged, the agent's turns, and the
 * screen at failure). The runner writes them before the run's last event, so
 * the terminal can point at them and a coding agent reads one file instead of
 * the report. The directory is the runner's: an earlier run's pages are
 * removed first, so no page ever tells a test this run did not have.
 */

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { labelSegment } from '../run/artifacts.ts';
import type { Report1Document, ReportExplore, ReportResult } from './build.ts';
import { renderTracePage } from './failure-text.ts';
import { outcome, type Outcome } from './outcome.ts';
import { toPosixPath, writeTextReport } from './write.ts';

/** Characters of the test file's name a page's file name keeps; the title's slug and the id follow. */
const MAX_FILE_SLUG_CHARS = 40;

/** Where each traced result's page went, by result id, as a path from the project root. */
export type TracePages = ReadonlyMap<string, string>;

/**
 * Whether a result's failure is the exploration's verdict, which its findings
 * already tell; such a result gets no page and no failure block.
 */
export function isExploreVerdict(final: Outcome, explore: ReportExplore): boolean {
  return final.final.error?.code === 'ASSERTION_FAILED' && explore.findings.some((finding) => finding.kind === 'issue');
}

/**
 * The results that get a page: every one an attempt kept a trace for, except
 * an exploration's own verdict, which its findings already tell.
 */
function tracedResults(report: Report1Document, traced: ReadonlySet<string>): ReportResult[] {
  const explore = report.run.explore;
  const serialGroups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  return report.run.results.filter((result) => {
    if (!traced.has(result.id)) return false;
    return explore === undefined || !isExploreVerdict(outcome(result, serialGroups), explore);
  });
}

/**
 * A page's file name: the test file's name and the title as a short slug, and
 * the result id's head, which keeps two results with the same words (another
 * target, agent, or repeat) apart: `checkout-applies-the-coupon-1a2b3c4d.md`.
 */
function tracePageName(result: Pick<ReportResult, 'id' | 'file' | 'titlePath'>): string {
  const file = path.posix
    .basename(result.file)
    .replace(/(\.e2e)?\.[cm]?[jt]sx?$/u, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_FILE_SLUG_CHARS);
  return `${labelSegment(file, result.titlePath.join(' '), result.id.slice(0, 16))}.md`;
}

export interface WriteTracePagesOptions {
  /** `<output>/traces`, emptied first. */
  readonly dir: string;
  readonly projectRoot: string;
  /** Absolute directory the report's artifact paths are relative to. */
  readonly artifactsRoot: string;
  /** Absolute replay cache directory, where a step's entry file is; absent when a custom store holds the cache. */
  readonly cacheDir?: string | undefined;
}

/** Writes the page of every result in `traced` (result ids) and returns where each went. */
export async function writeTracePages(report: Report1Document, traced: ReadonlySet<string>, options: WriteTracePagesOptions): Promise<TracePages> {
  rmSync(options.dir, { recursive: true, force: true });
  const relative = (absolute: string): string => toPosixPath(path.relative(options.projectRoot, absolute)) || '.';
  const serialGroups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  const readArtifact = (reportPath: string): string | undefined => {
    try {
      return readFileSync(path.join(options.artifactsRoot, reportPath), 'utf8');
    } catch {
      return undefined;
    }
  };
  const pages = new Map<string, string>();
  for (const result of tracedResults(report, traced)) {
    const file = path.join(options.dir, tracePageName(result));
    const page = renderTracePage(report, result, outcome(result, serialGroups), {
      artifactsDir: relative(options.artifactsRoot),
      readArtifact,
      ...(options.cacheDir === undefined ? {} : { cacheDir: relative(options.cacheDir) }),
    });
    await writeTextReport(file, page);
    pages.set(result.id, relative(file));
  }
  return pages;
}
