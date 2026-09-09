/**
 * Where the run came from, read from the CI provider's environment: the
 * commit, the branch, the pull request, and a link back to the job. report-1
 * records that a run was in CI but not which commit; this is the rest of the
 * attribution, sent beside the report rather than inside it.
 */

export interface RunContext {
  readonly git?: {
    readonly sha: string;
    readonly branch?: string;
    readonly pullRequest?: number;
  };
  readonly ci?: {
    readonly provider: string;
    readonly url?: string;
  };
}

/** A variable's trimmed value; unset and blank both read as undefined. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

interface ProviderFacts {
  readonly provider: string;
  readonly sha: string | undefined;
  readonly branch: string | undefined;
  readonly pullRequest: number | undefined;
  readonly url: string | undefined;
}

/** Detects the CI provider from its marker variable and reads what it exposes. */
export function detectContext(env: NodeJS.ProcessEnv): RunContext {
  const value = (name: string): string | undefined => envValue(env, name);
  const number = (name: string): number | undefined => {
    const raw = value(name);
    return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
  };
  const facts = ((): ProviderFacts | undefined => {
    if (value('GITHUB_ACTIONS') !== undefined) {
      const server = value('GITHUB_SERVER_URL');
      const repository = value('GITHUB_REPOSITORY');
      const runId = value('GITHUB_RUN_ID');
      const pull = /^refs\/pull\/(\d+)\//.exec(value('GITHUB_REF') ?? '')?.[1];
      return {
        provider: 'github-actions',
        sha: value('GITHUB_SHA'),
        branch: value('GITHUB_HEAD_REF') ?? value('GITHUB_REF_NAME'),
        pullRequest: pull === undefined ? undefined : Number(pull),
        url:
          server !== undefined && repository !== undefined && runId !== undefined
            ? `${server}/${repository}/actions/runs/${runId}`
            : undefined,
      };
    }
    if (value('GITLAB_CI') !== undefined) {
      return {
        provider: 'gitlab-ci',
        sha: value('CI_COMMIT_SHA'),
        branch: value('CI_COMMIT_REF_NAME'),
        pullRequest: number('CI_MERGE_REQUEST_IID'),
        url: value('CI_JOB_URL'),
      };
    }
    if (value('CIRCLECI') !== undefined) {
      return {
        provider: 'circleci',
        sha: value('CIRCLE_SHA1'),
        branch: value('CIRCLE_BRANCH'),
        pullRequest: number('CIRCLE_PR_NUMBER'),
        url: value('CIRCLE_BUILD_URL'),
      };
    }
    if (value('BUILDKITE') !== undefined) {
      return {
        provider: 'buildkite',
        sha: value('BUILDKITE_COMMIT'),
        branch: value('BUILDKITE_BRANCH'),
        pullRequest: number('BUILDKITE_PULL_REQUEST'),
        url: value('BUILDKITE_BUILD_URL'),
      };
    }
    if (value('VERCEL') !== undefined) {
      return {
        provider: 'vercel',
        sha: value('VERCEL_GIT_COMMIT_SHA'),
        branch: value('VERCEL_GIT_COMMIT_REF'),
        pullRequest: number('VERCEL_GIT_PULL_REQUEST_ID'),
        url: undefined,
      };
    }
    return undefined;
  })();
  if (facts === undefined) return {};
  const { provider, sha, branch, pullRequest, url } = facts;
  return {
    ...(sha === undefined
      ? {}
      : {
          git: {
            sha,
            ...(branch === undefined ? {} : { branch }),
            ...(pullRequest === undefined ? {} : { pullRequest }),
          },
        }),
    ci: { provider, ...(url === undefined ? {} : { url }) },
  };
}
