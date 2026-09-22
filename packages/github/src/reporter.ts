import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderMarkdownReport, type FinishedRun, type MarkdownReportOptions, type Reporter, type ReporterSummary } from 'e2e';
import { detectActions, type ActionsContext, type ActionsDeps } from './actions.ts';
import { upsertComment } from './post.ts';

const SUMMARY_LABEL = 'GitHub';

export interface GitHubOptions {
  /**
   * Tells one job's comment apart from another's when the workflow, job, and
   * project are the same, as in a matrix: `key: process.env.MATRIX_BROWSER`.
   * Without it, matrix replicas of one job share a comment and the last one
   * to finish wins. Never the run id: a rerun must find the old comment. The
   * key is also the comment's name in its headline: `e2e chromium: 77 passed`.
   */
  key?: string;
}

/** What the reporter touches outside itself, so tests run it against fakes. */
export interface ReportDeps extends ActionsDeps {
  readonly fetch: typeof fetch;
  readonly appendFile: (file: string, text: string) => Promise<void>;
  /** Whether a path exists; the checkout root is the directory that holds `.git`. */
  readonly exists: (file: string) => boolean;
}

/**
 * The GitHub reporter. Add it to `reporters` beside the built-in ids:
 *
 * ```ts
 * import { github } from '@e2edev/github';
 * export default { targets, reporters: ['list', github()] } satisfies E2EConfig;
 * ```
 *
 * On GitHub Actions it writes the run to the job summary and, for a pull
 * request, posts or updates one comment. Everything it reads (the token, the
 * event, the repository) is read when the run finishes, never when the config
 * loads, so constructing it has no side effects.
 */
export function github(options: GitHubOptions = {}): Reporter {
  return {
    name: 'github',
    onRunFinished: (run, signal) =>
      reportRun(run, signal, options, {
        fetch: globalThis.fetch,
        env: process.env,
        readFile: (file) => readFile(file, 'utf8'),
        appendFile: (file, text) => appendFile(file, text, 'utf8'),
        exists: existsSync,
      }),
  };
}

/**
 * Each encoded marker field is cut to this many characters, so four fields
 * and their names stay under a kilobyte whatever the input, well inside the
 * room the page leaves under GitHub's size limit. The cut
 * never lands inside a percent escape, and it is the same on every run.
 */
const MAX_MARKER_FIELD_CHARS = 200;

function markerField(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded.length <= MAX_MARKER_FIELD_CHARS) return encoded;
  return encoded.slice(0, MAX_MARKER_FIELD_CHARS).replace(/%[0-9A-F]?$/, '');
}

/**
 * The marker one job's comment carries, so two workflows or jobs each keep
 * their own. Every field is cut the same way on every run, so a rerun
 * derives the same marker and finds its comment.
 */
function commentMarker(run: FinishedRun, context: ActionsContext, key: string | undefined): string {
  const fields: Record<string, string | undefined> = {
    project: run.report.run.project.id,
    workflow: context.workflow,
    job: context.job,
    key,
  };
  const parts = Object.entries(fields).flatMap(([name, value]) =>
    value === undefined || value === '' ? [] : [`${name}=${markerField(value)}`],
  );
  return `<!-- e2e-github ${parts.join(' ')} -->`;
}

/**
 * The directory the repository is checked out in: the nearest ancestor of the
 * project root, itself included, that holds `.git`. `actions/checkout` puts
 * it at `GITHUB_WORKSPACE` unless its `path` input names a subdirectory, so
 * the workspace bounds the walk and stands in when no `.git` is found.
 */
function checkoutRoot(workspace: string, projectRoot: string, exists: (file: string) => boolean): string {
  let dir = projectRoot;
  while (dir.startsWith(workspace)) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return workspace;
}

/**
 * The project's path inside the checkout, as segments. The report's files are
 * relative to the project root, and a suite that lives in `packages/e2e-tests`
 * links to `blob/<sha>/packages/e2e-tests/tests/...`. A project at the
 * checkout root, or one outside it, adds nothing.
 */
function projectSegments(workspace: string | undefined, projectRoot: string, exists: (file: string) => boolean): string[] {
  if (workspace === undefined) return [];
  const relative = path.relative(checkoutRoot(workspace, projectRoot, exists), projectRoot);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
  return relative.split(path.sep);
}

function sourceUrl(context: ActionsContext, projectRoot: string, deps: ReportDeps): MarkdownReportOptions['sourceUrl'] {
  const sha = context.sha;
  if (sha === undefined) return undefined;
  const prefix = projectSegments(context.workspace, projectRoot, deps.exists);
  return (file, line) =>
    `${context.serverUrl}/${context.repository}/blob/${sha}/${[...prefix, ...file.split('/')].map(encodeURIComponent).join('/')}#L${line}`;
}

/** What posting needs, or the one reason this job cannot post. */
type Posting = { readonly token: string; readonly pullRequest: number } | { readonly skipped: string };

function posting(context: ActionsContext): Posting {
  if (context.pullRequest === undefined) return { skipped: `${context.eventName} is not a pull request` };
  if (context.token === undefined) {
    return { skipped: "set GITHUB_TOKEN in the step's env (GITHUB_TOKEN: ${{ github.token }})" };
  }
  return { token: context.token, pullRequest: context.pullRequest };
}

type SummaryOutcome = 'none' | 'written' | { readonly failed: string };

async function writeSummary(context: ActionsContext, text: string, deps: ReportDeps): Promise<SummaryOutcome> {
  if (context.stepSummaryPath === undefined) return 'none';
  try {
    await deps.appendFile(context.stepSummaryPath, `${text}\n`);
    return 'written';
  } catch (error) {
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/** Reports one finished run and resolves with the summary rows describing what happened. */
export async function reportRun(
  run: FinishedRun,
  signal: AbortSignal,
  options: GitHubOptions,
  deps: ReportDeps,
): Promise<ReporterSummary> {
  const context = await detectActions(deps);
  if (context === undefined) return [{ label: SUMMARY_LABEL, text: 'not posted: not running on GitHub Actions' }];

  // One page for both places; the comment carries the marker a rerun finds it by.
  // Evidence links land on the run page's Artifacts section, where the job's
  // upload-artifact step put the files; the page names each file's path inside it.
  const page = renderMarkdownReport(run.report, {
    artifactsUrl: `${context.runUrl}#artifacts`,
    sourceUrl: sourceUrl(context, run.projectRoot, deps),
    title: options.key,
  });
  const summary = await writeSummary(context, page, deps);
  const post = posting(context);
  const marker = commentMarker(run, context, options.key);
  const lead =
    'skipped' in post
      ? `not posted: ${post.skipped}${summary === 'written' ? '; written to the job summary' : ''}`
      : await upsertComment({
          fetch: deps.fetch,
          signal,
          apiUrl: context.apiUrl,
          repository: context.repository,
          ...post,
          marker,
          body: `${marker}\n${page}`,
        });

  return [
    { label: SUMMARY_LABEL, text: lead },
    ...(typeof summary === 'object' ? [{ label: SUMMARY_LABEL, text: `job summary not written: ${summary.failed}` }] : []),
  ];
}
