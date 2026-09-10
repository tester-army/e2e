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

import { isRecord } from './json.ts';

export interface ActionsContext {
  /** `owner/repo`. */
  readonly repository: string;
  /** `https://github.com`, or the GitHub Enterprise Server host. */
  readonly serverUrl: string;
  /** `https://api.github.com`, or the Enterprise Server API root. */
  readonly apiUrl: string;
  /** The workflow run page, where uploaded artifacts live. */
  readonly runUrl: string;
  readonly eventName: string;
  readonly workflow: string;
  readonly job: string;
  /**
   * The commit sources are linked at: the pull request's head when the event
   * payload names it, the checked-out SHA when the event is not about a pull
   * request, and nothing on an `issue_comment`, whose SHA is the default
   * branch and would link every source line to the wrong revision.
   */
  readonly sha: string | undefined;
  readonly pullRequest: number | undefined;
  /** `GITHUB_TOKEN`, or `GH_TOKEN` the way the `gh` CLI reads it. */
  readonly token: string | undefined;
  /** The file `GITHUB_STEP_SUMMARY` names, when the runner provides one. */
  readonly stepSummaryPath: string | undefined;
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

/** What a payload about a pull request says: its number, and its head when the event carries one. */
interface PullRequestEvent {
  readonly number: number | undefined;
  readonly headSha: string | undefined;
}

function pullRequestNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reads the pull request out of the webhook payload, or nothing when the
 * payload is missing, unreadable, or not about a pull request.
 */
async function readEvent(path: string | undefined, deps: ActionsDeps): Promise<PullRequestEvent | undefined> {
  if (path === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(await deps.readFile(path));
  } catch {
    return undefined;
  }
  if (!isRecord(payload)) return undefined;
  const pull = payload['pull_request'];
  if (isRecord(pull)) {
    const head = pull['head'];
    return {
      number: pullRequestNumber(pull['number']),
      headSha: isRecord(head) && typeof head['sha'] === 'string' ? head['sha'] : undefined,
    };
  }
  // An `issue_comment` on a pull request: the issue carries a `pull_request`
  // link but not the head commit, and GITHUB_SHA is the default branch here.
  const issue = payload['issue'];
  if (isRecord(issue) && isRecord(issue['pull_request'])) {
    return { number: pullRequestNumber(issue['number']), headSha: undefined };
  }
  return undefined;
}

/** The number in `refs/pull/N/merge` or `refs/pull/N/head`. */
function pullFromRef(ref: string | undefined): number | undefined {
  const match = ref === undefined ? null : /^refs\/pull\/(\d+)\//.exec(ref);
  return match === null ? undefined : pullRequestNumber(Number(match[1]));
}

/**
 * The Actions context of the current job, or undefined outside GitHub
 * Actions. On Actions the runner always sets the repository, run id, event
 * name, workflow, and job; a job missing one is broken, not "not Actions",
 * and says so.
 */
export async function detectActions(deps: ActionsDeps): Promise<ActionsContext | undefined> {
  const value = (name: string): string | undefined => envValue(deps.env, name);
  if (value('GITHUB_ACTIONS') === undefined) return undefined;
  const required = (name: string): string => {
    const found = value(name);
    if (found === undefined) throw new Error(`GITHUB_ACTIONS is set but ${name} is not`);
    return found;
  };

  const repository = required('GITHUB_REPOSITORY');
  const serverUrl = (value('GITHUB_SERVER_URL') ?? 'https://github.com').replace(/\/+$/, '');
  const event = await readEvent(value('GITHUB_EVENT_PATH'), deps);

  return {
    repository,
    serverUrl,
    apiUrl: (value('GITHUB_API_URL') ?? 'https://api.github.com').replace(/\/+$/, ''),
    runUrl: `${serverUrl}/${repository}/actions/runs/${required('GITHUB_RUN_ID')}`,
    eventName: required('GITHUB_EVENT_NAME'),
    workflow: required('GITHUB_WORKFLOW'),
    job: required('GITHUB_JOB'),
    sha: event === undefined ? value('GITHUB_SHA') : event.headSha,
    pullRequest: event?.number ?? pullFromRef(value('GITHUB_REF')),
    token: value('GITHUB_TOKEN') ?? value('GH_TOKEN'),
    stepSummaryPath: value('GITHUB_STEP_SUMMARY'),
  };
}
