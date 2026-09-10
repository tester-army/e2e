/**
 * What GitHub Actions tells a job about itself, read from the environment
 * the runner sets: the repository, the pull request the job runs for, the
 * commit to link sources at, the token, and where the job summary is written.
 *
 * The pull request number comes from the event payload first, since
 * `pull_request`, `pull_request_target`, and a PR's `issue_comment` all carry
 * it there, and from `GITHUB_REF` (`refs/pull/N/merge`) when the payload has
 * none. Nothing here is read until the run has finished.
 */

export interface ActionsContext {
  /** `owner/repo`. */
  readonly repository: string;
  /** `https://github.com`, or the GitHub Enterprise Server host. */
  readonly serverUrl: string;
  /** `https://api.github.com`, or the Enterprise Server API root. */
  readonly apiUrl: string;
  /** The workflow run page, where uploaded artifacts live. */
  readonly runUrl: string | undefined;
  /** The commit sources are linked at: the PR head when the payload names it, else the checked-out SHA. */
  readonly sha: string | undefined;
  readonly eventName: string | undefined;
  readonly pullRequest: number | undefined;
  /** `GITHUB_TOKEN`, or `GH_TOKEN` the way the `gh` CLI reads it. */
  readonly token: string | undefined;
  /** The file `GITHUB_STEP_SUMMARY` names, when the runner provides one. */
  readonly stepSummaryPath: string | undefined;
  readonly workflow: string | undefined;
  readonly job: string | undefined;
}

export interface ActionsDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (file: string) => Promise<string>;
}

/** A variable's trimmed value; unset and blank both read as undefined. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

/** Whatever the event payload says about the pull request: its number and head commit. */
interface EventFacts {
  readonly pullRequest: number | undefined;
  readonly headSha: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reads the pull request out of the webhook payload. A payload that is
 * missing, unreadable, or not about a pull request yields nothing; the
 * caller falls back to the ref.
 */
async function readEvent(path: string | undefined, deps: ActionsDeps): Promise<EventFacts> {
  const none: EventFacts = { pullRequest: undefined, headSha: undefined };
  if (path === undefined) return none;
  let payload: unknown;
  try {
    payload = JSON.parse(await deps.readFile(path)) as unknown;
  } catch {
    return none;
  }
  if (!isRecord(payload)) return none;
  const pull = payload['pull_request'];
  if (isRecord(pull)) {
    const head = pull['head'];
    const headSha = isRecord(head) && typeof head['sha'] === 'string' ? head['sha'] : undefined;
    return { pullRequest: positiveInteger(pull['number']), headSha };
  }
  // An `issue_comment` on a pull request: the issue carries a `pull_request` link.
  const issue = payload['issue'];
  if (isRecord(issue) && isRecord(issue['pull_request'])) {
    return { pullRequest: positiveInteger(issue['number']), headSha: undefined };
  }
  return none;
}

/** The number in `refs/pull/N/merge` or `refs/pull/N/head`. */
function pullFromRef(ref: string | undefined): number | undefined {
  const match = ref === undefined ? null : /^refs\/pull\/(\d+)\//.exec(ref);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The Actions context of the current job, or undefined outside GitHub
 * Actions (no `GITHUB_ACTIONS`, or no repository to post to).
 */
export async function detectActions(deps: ActionsDeps): Promise<ActionsContext | undefined> {
  const value = (name: string): string | undefined => envValue(deps.env, name);
  if (value('GITHUB_ACTIONS') === undefined) return undefined;
  const repository = value('GITHUB_REPOSITORY');
  if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return undefined;

  const serverUrl = (value('GITHUB_SERVER_URL') ?? 'https://github.com').replace(/\/+$/, '');
  const apiUrl = (value('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/+$/, '');
  const runId = value('GITHUB_RUN_ID');
  const event = await readEvent(value('GITHUB_EVENT_PATH'), deps);

  return {
    repository,
    serverUrl,
    apiUrl,
    runUrl: runId === undefined ? undefined : `${serverUrl}/${repository}/actions/runs/${runId}`,
    sha: event.headSha ?? value('GITHUB_SHA'),
    eventName: value('GITHUB_EVENT_NAME'),
    pullRequest: event.pullRequest ?? pullFromRef(value('GITHUB_REF')),
    token: value('GITHUB_TOKEN') ?? value('GH_TOKEN'),
    stepSummaryPath: value('GITHUB_STEP_SUMMARY'),
    workflow: value('GITHUB_WORKFLOW'),
    job: value('GITHUB_JOB'),
  };
}
