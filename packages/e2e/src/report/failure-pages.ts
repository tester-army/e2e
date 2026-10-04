/**
 * The failure pages every run writes: one markdown file per test that failed,
 * timed out, or was flaky, under `<output>/failures/`, telling the whole
 * attempt (each step with what it did, the cache's decisions, what the app
 * logged, the agent's turns, and the screen at failure). The runner writes
 * them before the run's last event, so the terminal can point at them and a
 * coding agent reads one file instead of the report. The directory is the
 * runner's: an earlier run's pages are removed first, so no page ever tells a
 * failure this run did not have.
 */

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { labelSegment } from '../run/artifacts.ts';
import type { Report1Document, ReportExplore, ReportResult } from './build.ts';
import { renderFailurePage } from './failure-text.ts';
import { statusBucket } from './format.ts';
import { outcome, type Outcome } from './outcome.ts';
import { toPosixPath, writeTextReport } from './write.ts';

/** Characters of the test file's name a page's file name keeps; the title's slug and the id follow. */
const MAX_FILE_SLUG_CHARS = 40;

/** Where each paged result's page went, by result id, as a path from the project root. */
export type FailurePages = ReadonlyMap<string, string>;

/**
 * Whether a result's failure is the exploration's verdict, which its findings
 * already tell; such a result gets no page and no failure block.
 */
export function isExploreVerdict(final: Outcome, explore: ReportExplore): boolean {
  return final.final.error?.code === 'ASSERTION_FAILED' && explore.findings.some((finding) => finding.kind === 'issue');
}

/**
 * The results that get a page: every one that failed, timed out, or was
 * flaky, except an exploration's own verdict. An interrupted test reached no
 * verdict, so it has no failure to tell.
 */
function pagedResults(report: Report1Document): ReportResult[] {
  const explore = report.run.explore;
  const serialGroups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  return report.run.results.filter((result) => {
    const bucket = statusBucket(result.status);
    if (bucket !== 'failed' && bucket !== 'flaky') return false;
    return explore === undefined || !isExploreVerdict(outcome(result, serialGroups), explore);
  });
}

/**
 * A page's file name: the test file's name and the title as a short slug, and
 * the result id's head, which keeps two results with the same words (another
 * target, agent, or repeat) apart: `checkout-applies-the-coupon-1a2b3c4d.md`.
 */
function failurePageName(result: Pick<ReportResult, 'id' | 'file' | 'titlePath'>): string {
  const file = path.posix
    .basename(result.file)
    .replace(/(\.e2e)?\.[cm]?[jt]sx?$/u, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_FILE_SLUG_CHARS);
  return `${labelSegment(file, result.titlePath.join(' '), result.id.slice(0, 8))}.md`;
}

export interface WriteFailurePagesOptions {
  /** `<output>/failures`, emptied first. */
  readonly dir: string;
  readonly projectRoot: string;
  /** Absolute directory the report's artifact paths are relative to. */
  readonly artifactsRoot: string;
  /** Absolute replay cache directory, where a step's entry file is; absent when a custom store holds the cache. */
  readonly cacheDir?: string | undefined;
}

/** Writes every paged result's page and returns where each went. */
export async function writeFailurePages(report: Report1Document, options: WriteFailurePagesOptions): Promise<FailurePages> {
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
  for (const result of pagedResults(report)) {
    const file = path.join(options.dir, failurePageName(result));
    const page = renderFailurePage(report, result, outcome(result, serialGroups), {
      artifactsDir: relative(options.artifactsRoot),
      readArtifact,
      ...(options.cacheDir === undefined ? {} : { cacheDir: relative(options.cacheDir) }),
    });
    await writeTextReport(file, page);
    pages.set(result.id, relative(file));
  }
  return pages;
}
