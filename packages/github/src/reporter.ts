import { appendFile, readFile } from 'node:fs/promises';
import type { FinishedRun, Reporter, ReporterSummary } from '@e2edev/e2e';
import { detectActions, type ActionsContext, type ActionsDeps } from './actions.ts';
import { renderComment, type CommentOptions } from './comment.ts';
import { upsertComment } from './post.ts';

const SUMMARY_LABEL = 'GitHub';

export interface GitHubOptions {
  /**
   * Tells one job's comment apart from another's when the workflow, job, and
   * project are the same, as in a matrix: `key: process.env.MATRIX_BROWSER`.
   * Without it, matrix replicas of one job share a comment and the last one
   * to finish wins. Never the run id: a rerun must find the old comment.
   */
  key?: string;
}

/** What the reporter touches outside itself, so tests run it against fakes. */
export interface ReportDeps extends ActionsDeps {
  readonly fetch: typeof fetch;
  readonly appendFile: (file: string, text: string) => Promise<void>;
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
      }),
  };
}

/** Marker fields are clipped to this many code points before encoding, so the marker stays under its cap. */
const MAX_MARKER_FIELD_CHARS = 128;

/**
 * The marker one job's comment carries, so two workflows or jobs each keep
 * their own. Every field is clipped the same way on every run, so a rerun
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
    value === undefined || value === ''
      ? []
      : [`${name}=${encodeURIComponent([...value].slice(0, MAX_MARKER_FIELD_CHARS).join(''))}`],
  );
  return `<!-- e2e-github ${parts.join(' ')} -->`;
}

function sourceUrl(context: ActionsContext): CommentOptions['sourceUrl'] {
  const sha = context.sha;
  if (sha === undefined) return undefined;
  return (file, line) =>
    `${context.serverUrl}/${context.repository}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}#L${line}`;
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

  const links: CommentOptions = { artifactsUrl: context.runUrl, sourceUrl: sourceUrl(context) };
  const summary = await writeSummary(context, renderComment(run.report, links), deps);
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
          body: renderComment(run.report, { ...links, marker }),
        });

  return [
    { label: SUMMARY_LABEL, text: lead },
    ...(typeof summary === 'object' ? [{ label: SUMMARY_LABEL, text: `job summary not written: ${summary.failed}` }] : []),
  ];
}
