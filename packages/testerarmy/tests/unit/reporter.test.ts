import { describe, expect, it } from 'vitest';
import { testerarmy } from '../../src/index.ts';
import { detectContext } from '../../src/context.ts';

describe('testerarmy()', () => {
  it('is a reporter named testerarmy with a finish handler', () => {
    const reporter = testerarmy();
    expect(reporter.name).toBe('testerarmy');
    expect(typeof reporter.onRunFinished).toBe('function');
    expect(reporter.onEvent).toBeUndefined();
  });

  it('rejects an apiKey option that is not a variable name', () => {
    expect(() => testerarmy({ apiKey: 'ta_live_123' })).not.toThrow();
    expect(() => testerarmy({ apiKey: 'not a name' })).toThrow('names the environment variable');
  });
});

describe('detectContext', () => {
  it('reads each provider from its marker and reports nothing elsewhere', () => {
    expect(detectContext({})).toEqual({});
    expect(
      detectContext({ GITLAB_CI: 'true', CI_COMMIT_SHA: 's', CI_COMMIT_REF_NAME: 'main', CI_MERGE_REQUEST_IID: '7', CI_JOB_URL: 'https://gl/job' }),
    ).toEqual({ git: { sha: 's', branch: 'main', pullRequest: 7 }, ci: { provider: 'gitlab-ci', url: 'https://gl/job' } });
    expect(detectContext({ BUILDKITE: 'true', BUILDKITE_COMMIT: 's', BUILDKITE_BRANCH: 'b', BUILDKITE_PULL_REQUEST: 'false' })).toEqual({
      git: { sha: 's', branch: 'b' },
      ci: { provider: 'buildkite' },
    });
    expect(detectContext({ VERCEL: '1', VERCEL_GIT_COMMIT_SHA: 's', VERCEL_GIT_COMMIT_REF: 'b', VERCEL_GIT_PULL_REQUEST_ID: '12' })).toEqual({
      git: { sha: 's', branch: 'b', pullRequest: 12 },
      ci: { provider: 'vercel' },
    });
    expect(detectContext({ CIRCLECI: 'true', CIRCLE_SHA1: 's' })).toEqual({ git: { sha: 's' }, ci: { provider: 'circleci' } });
    // A provider without a commit still names itself.
    expect(detectContext({ GITHUB_ACTIONS: 'true' })).toEqual({ ci: { provider: 'github-actions' } });
    // A push, not a pull request: the branch is the ref name and there is no number.
    expect(detectContext({ GITHUB_ACTIONS: 'true', GITHUB_SHA: 's', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main' })).toEqual({
      git: { sha: 's', branch: 'main' },
      ci: { provider: 'github-actions' },
    });
  });
});
