import { appendFile, readFile } from 'node:fs/promises';
import type { FinishedRun, Reporter, ReporterSummary } from '@e2edev/e2e';
import { detectActions, type ActionsContext } from './actions.ts';
import { renderComment } from './comment.ts';
import { upsertComment } from './post.ts';

const SUMMARY_LABEL = 'GitHub';

/** What the reporter touches outside itself, so tests run it against fakes. */
export interface ReportDeps {
  readonly fetch: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (file: string) => Promise<string>;
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
export function github(): Reporter {
  return {
    name: 'github',
    onRunFinished: (run, signal) =>
      reportRun(run, signal, {
        fetch: globalThis.fetch,
        env: process.env,
        readFile: (file) => readFile(file, 'utf8'),
        appendFile: (file, text) => appendFile(file, text, 'utf8'),
      }),
  };
}

/** The marker one job's comment carries, so two workflows or jobs each keep their own. */
function commentMarker(run: FinishedRun, context: ActionsContext): string {
  const parts = [
    `project=${encodeURIComponent(run.report.run.project.id)}`,
    ...(context.workflow === undefined ? [] : [`workflow=${encodeURIComponent(context.workflow)}`]),
    ...(context.job === undefined ? [] : [`job=${encodeURIComponent(context.job)}`]),
  ];
  return `<!-- e2e-github ${parts.join(' ')} -->`;
}

function row(text: string): { label: string; text: string } {
  return { label: SUMMARY_LABEL, text };
}

/** Reports one finished run and resolves with the summary rows describing what happened. */
export async function reportRun(run: FinishedRun, signal: AbortSignal, deps: ReportDeps): Promise<ReporterSummary> {
  const context = await detectActions(deps);
  if (context === undefined) {
    return [row('not posted: not running on GitHub Actions; @e2edev/testerarmy posts results from any CI')];
  }

  const marker = commentMarker(run, context);
  const sha = context.sha;
  const links = {
    ...(context.runUrl === undefined ? {} : { artifactsUrl: context.runUrl }),
    ...(sha === undefined
      ? {}
      : {
          sourceUrl: (file: string, line: number) =>
            `${context.serverUrl}/${context.repository}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}#L${line}`,
        }),
  };

  const rows: { label: string; text: string }[] = [];
  let summaryWritten = false;
  if (context.stepSummaryPath !== undefined) {
    try {
      await deps.appendFile(context.stepSummaryPath, `${renderComment(run.report, links)}\n`);
      summaryWritten = true;
    } catch (error) {
      rows.push(row(`job summary not written: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  const alsoSummary = summaryWritten ? '; written to the job summary' : '';

  if (context.pullRequest === undefined) {
    rows.unshift(row(`not posted: ${context.eventName ?? 'this event'} is not a pull request${alsoSummary}`));
    return rows;
  }
  if (context.token === undefined) {
    rows.unshift(
      row(`not posted: set GITHUB_TOKEN in the step's env (GITHUB_TOKEN: \${{ github.token }})${alsoSummary}`),
    );
    return rows;
  }

  const url = await upsertComment({
    fetch: deps.fetch,
    signal,
    apiUrl: context.apiUrl,
    token: context.token,
    repository: context.repository,
    pullRequest: context.pullRequest,
    marker,
    body: renderComment(run.report, { marker, ...links }),
  });
  rows.unshift(row(url));
  return rows;
}
