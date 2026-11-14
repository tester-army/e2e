/**
 * The report as the page reads it. Every shape is derived from `Report`, the
 * report-1 document `e2e` exports, so the page follows the wire format as it
 * changes instead of restating it.
 */

import type { Report } from 'e2e';
import type { ReportMedia, ReportPayload } from '../src/payload.ts';

type Run = Report['run'];
export type Result = Run['results'][number];
type Attempt = Result['attempts'][number];
export type Step = Attempt['steps'][number];
export type Artifact = Attempt['artifacts'][number];
export type ReportError = NonNullable<Attempt['error']>;
export type ResultStatus = Result['status'];
type SerialGroup = Run['serialGroups'][number];

/** One attempt as the page shows it, whether the result keeps it or its serial group does. */
export interface AttemptView {
  readonly index: number;
  readonly status: Attempt['status'] | 'skipped';
  readonly durationMs: number;
  readonly startedAt: string;
  readonly error: ReportError | undefined;
  readonly secondaryErrors: readonly ReportError[];
  readonly steps: readonly Step[];
  readonly appLog: NonNullable<Attempt['appLog']>;
  readonly failure: Attempt['failure'];
  readonly artifacts: readonly Artifact[];
  readonly environment: Attempt['environment'];
}

/** The page's whole model, built once from the payload. */
export interface ReportModel {
  readonly run: Run;
  readonly media: ReportMedia;
  /** Every selected result, in the order the run declared them. */
  readonly results: readonly Result[];
  readonly attempts: (result: Result) => readonly AttemptView[];
  /** The targets the results ran on; a run can configure more than it selects. */
  readonly targetIds: ReadonlySet<string>;
  /** Where the run's files are, from the project root, for the copied prompt. */
  readonly resultsDir: string;
  readonly traces: Readonly<Record<string, string>>;
  /** Test file lines around each step and error, by file then line number. */
  readonly sources: ReportPayload['sources'];
}

/** Reads the payload the reporter embedded; undefined when the page was opened unfilled. */
export function readPayload(): ReportPayload | undefined {
  const text = document.getElementById('e2e-report')?.textContent;
  if (text === undefined || text === null) return undefined;
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null ? (value as ReportPayload) : undefined;
}

export function buildModel(payload: ReportPayload): ReportModel {
  const { run } = payload.report;
  const groups = new Map(run.serialGroups.map((group) => [group.id, group]));
  const results = run.results.filter((result) => result.selected || result.skip?.filter !== undefined);
  return {
    run,
    media: payload.media,
    results,
    attempts: (result) => attemptViews(result, groups),
    targetIds: new Set(results.map((result) => result.targetId)),
    resultsDir: payload.resultsDir,
    traces: payload.traces,
    sources: payload.sources,
  };
}

/** A result's attempts; a serial member's live on its group's attempts, keyed by test id. */
function attemptViews(result: Result, groups: ReadonlyMap<string, SerialGroup>): AttemptView[] {
  if (result.serialGroupId === undefined) {
    return result.attempts.map((attempt) => ({
      index: attempt.index,
      status: attempt.status,
      durationMs: attempt.durationMs,
      startedAt: attempt.startedAt,
      error: attempt.error,
      secondaryErrors: attempt.secondaryErrors,
      steps: attempt.steps,
      appLog: attempt.appLog ?? [],
      failure: attempt.failure,
      artifacts: attempt.artifacts,
      environment: attempt.environment,
    }));
  }
  return (groups.get(result.serialGroupId)?.attempts ?? []).map((attempt) => {
    const member = attempt.members.find((candidate) => candidate.testId === result.testId);
    return {
      index: attempt.index,
      status: member?.status ?? attempt.status,
      durationMs: member?.durationMs ?? 0,
      startedAt: member?.startedAt ?? attempt.startedAt,
      // The group's error is often another member's, so a member that passed never shows it; any other falls back to it.
      error: member?.status === 'passed' ? member.error : (member?.error ?? attempt.error),
      secondaryErrors: [...(member?.secondaryErrors ?? []), ...attempt.secondaryErrors],
      steps: member?.steps ?? [],
      appLog: member?.appLog ?? [],
      failure: member?.failure,
      artifacts: attempt.artifacts,
      environment: attempt.environment,
    };
  });
}

/** The statuses the page filters by, in tab order, each with the results it covers. */
export const STATUS_FILTERS = {
  all: () => true,
  failed: (status: ResultStatus) => status === 'failed' || status === 'timed-out',
  flaky: (status: ResultStatus) => status === 'flaky',
  passed: (status: ResultStatus) => status === 'passed',
  skipped: (status: ResultStatus) => status === 'skipped',
  interrupted: (status: ResultStatus) => status === 'interrupted',
} as const satisfies Record<string, (status: ResultStatus) => boolean>;

export type StatusFilter = keyof typeof STATUS_FILTERS;

export function isStatusFilter(value: string | null): value is StatusFilter {
  return value !== null && Object.hasOwn(STATUS_FILTERS, value);
}

/** Failed first, then flaky, interrupted, passed, skipped: what needs reading comes first. */
const STATUS_RANK: Record<ResultStatus, number> = { failed: 0, 'timed-out': 0, flaky: 1, interrupted: 2, passed: 3, skipped: 4 };

export function byStatus(a: Result, b: Result): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status];
}

/** The test's name as the terminal prints it: describe titles, then the test, joined. */
export function testTitle(result: Result): string {
  return `${result.titlePath.join(' › ')}${repeatSuffix(result)}`;
}

/** Tells `--repeat-each` runs apart the way the terminal does: ` (repeat #2)` past the first. */
export function repeatSuffix(result: Result): string {
  return result.repeat === undefined || result.repeat === 0 ? '' : ` (repeat #${result.repeat})`;
}

/**
 * Whether a result matches the search text: every word starts a word of its
 * title, file, tags, target, or a named agent. Matching word starts only keeps
 * a short query from matching every test through a shared path or target
 * (`ge` inside `tests-agent/`).
 */
export function matchesSearch(result: Result, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/u).filter((word) => word !== '');
  if (words.length === 0) return true;
  const agent = result.agent === 'default' ? [] : [result.agent];
  const haystack = [testTitle(result), result.file, result.targetId, ...agent, ...result.tags].join(' ').toLowerCase();
  return words.every((word) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${word.replaceAll(/[\\^$.*+?()[\]{}|/]/gu, '\\$&')}`, 'u').test(haystack));
}

/** The results that ran on `target`, or every result when it names none; an unknown target answers none. */
export function onTarget(results: readonly Result[], target: string | undefined): readonly Result[] {
  return target === undefined ? results : results.filter((result) => result.targetId === target);
}

/**
 * The URL an artifact opens at, by the payload's media mode: its file under
 * the link base, each segment encoded, or its embedded bytes. A hosted
 * video's own `http(s)` URL serves in either. Undefined when the page has
 * no media, or the artifact has nothing it can open.
 */
export function artifactUrl(artifact: Artifact, media: ReportMedia): string | undefined {
  if (media.mode === 'none') return undefined;
  if (artifact.path !== undefined) {
    if (media.mode === 'embed') return embeddedUrl(artifact.path, media.files);
    const segments = [...media.base.split('/'), ...artifact.path.split('/')].filter((segment) => segment !== '');
    return segments.map((segment) => (segment === '..' ? segment : encodeURIComponent(segment))).join('/');
  }
  if (artifact.url !== undefined && /^https?:\/\//iu.test(artifact.url)) return artifact.url;
  return undefined;
}

/** Blob URLs of embedded files, made on first use: decoding every video up front would stall the page. */
const blobUrls = new Map<string, string>();

/** An embedded file as a blob URL, which a video can seek in; undefined when the reporter could not embed it. */
function embeddedUrl(artifactPath: string, files: Readonly<Record<string, string>>): string | undefined {
  const cached = blobUrls.get(artifactPath);
  if (cached !== undefined) return cached;
  const dataUrl = Object.hasOwn(files, artifactPath) ? files[artifactPath] : undefined;
  const match = dataUrl === undefined ? null : /^data:([^;,]+);base64,/u.exec(dataUrl);
  if (dataUrl === undefined || match === null) return undefined;
  const binary = atob(dataUrl.slice(match[0].length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: match[1] ?? '' }));
  blobUrls.set(artifactPath, url);
  return url;
}

/** A video segment of an attempt and the span of the run it covers. */
export interface TimedVideo {
  readonly artifact: Artifact;
  readonly url: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

/** The attempt's playable videos in recording order, each ending where the next begins. */
export function timedVideos(artifacts: readonly Artifact[], media: ReportMedia): TimedVideo[] {
  const videos = artifacts.flatMap((artifact) => {
    const url = artifact.kind === 'video' ? artifactUrl(artifact, media) : undefined;
    return url === undefined || artifact.startedAt === undefined ? [] : [{ artifact, url, startsAt: Date.parse(artifact.startedAt) }];
  });
  const sorted = videos.toSorted((a, b) => a.startsAt - b.startsAt);
  return sorted.map((video, index) => ({ ...video, endsAt: sorted[index + 1]?.startsAt ?? Infinity }));
}

/**
 * Where a step starts in the recording that was running then: the segment
 * and the second into it. A step before the first segment began is at its
 * start, the way the trace page reads it.
 */
export function videoPosition(step: Step, videos: readonly TimedVideo[]): { readonly video: number; readonly seconds: number } | undefined {
  const at = Date.parse(step.startedAt);
  const index = videos.findLastIndex((video) => video.startsAt <= at && at < video.endsAt);
  if (index !== -1) return { video: index, seconds: (at - (videos[index]?.startsAt ?? at)) / 1000 };
  return videos.length > 0 && at < (videos[0]?.startsAt ?? 0) ? { video: 0, seconds: 0 } : undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** A position in a video, to the tenth of a second: steps are often under one apart. `1:04.2`. */
export function formatClock(seconds: number): string {
  const tenths = Math.floor(seconds * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}

export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}
