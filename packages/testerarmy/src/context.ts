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

/** Detects the CI provider from its marker variable and reads what it exposes. */
export function detectContext(env: NodeJS.ProcessEnv): RunContext {
  const value = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
  };
  const number = (name: string): number | undefined => {
    const raw = value(name);
    if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
    return Number(raw);
  };
  const context = (
    provider: string,
    sha: string | undefined,
    branch: string | undefined,
    pullRequest: number | undefined,
    url: string | undefined,
  ): RunContext => ({
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
  });

  if (value('GITHUB_ACTIONS') === 'true') {
    const ref = value('GITHUB_REF');
    const pull = ref === undefined ? undefined : /^refs\/pull\/(\d+)\//.exec(ref)?.[1];
    const server = value('GITHUB_SERVER_URL');
    const repository = value('GITHUB_REPOSITORY');
    const runId = value('GITHUB_RUN_ID');
    return context(
      'github-actions',
      value('GITHUB_SHA'),
      value('GITHUB_HEAD_REF') ?? value('GITHUB_REF_NAME'),
      pull === undefined ? undefined : Number(pull),
      server !== undefined && repository !== undefined && runId !== undefined
        ? `${server}/${repository}/actions/runs/${runId}`
        : undefined,
    );
  }
  if (value('GITLAB_CI') !== undefined) {
    return context(
      'gitlab-ci',
      value('CI_COMMIT_SHA'),
      value('CI_COMMIT_REF_NAME'),
      number('CI_MERGE_REQUEST_IID'),
      value('CI_JOB_URL'),
    );
  }
  if (value('CIRCLECI') !== undefined) {
    return context('circleci', value('CIRCLE_SHA1'), value('CIRCLE_BRANCH'), number('CIRCLE_PR_NUMBER'), value('CIRCLE_BUILD_URL'));
  }
  if (value('BUILDKITE') !== undefined) {
    return context(
      'buildkite',
      value('BUILDKITE_COMMIT'),
      value('BUILDKITE_BRANCH'),
      number('BUILDKITE_PULL_REQUEST'),
      value('BUILDKITE_BUILD_URL'),
    );
  }
  if (value('VERCEL') !== undefined) {
    return context(
      'vercel',
      value('VERCEL_GIT_COMMIT_SHA'),
      value('VERCEL_GIT_COMMIT_REF'),
      number('VERCEL_GIT_PULL_REQUEST_ID'),
      undefined,
    );
  }
  return {};
}
