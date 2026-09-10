/** The Actions context: what is read from where, and what counts as not being on Actions. */

import { describe, expect, it } from 'vitest';
import { detectActions } from '../../src/actions.ts';
import { actionsEnv, readEvent } from './fake-github.ts';

const detect = (env: NodeJS.ProcessEnv) => detectActions({ env, readFile: readEvent });

describe('detectActions', () => {
  it('is nothing outside Actions, and a broken runner on Actions without its always-set variables', async () => {
    expect(await detect({})).toBeUndefined();
    expect(await detect({ CI: '1', GITLAB_CI: 'true' })).toBeUndefined();
    await expect(detect({ GITHUB_ACTIONS: 'true' })).rejects.toThrow('GITHUB_ACTIONS is set but GITHUB_REPOSITORY is not');
    await expect(detect({ ...actionsEnv, GITHUB_JOB: ' ' })).rejects.toThrow('GITHUB_ACTIONS is set but GITHUB_JOB is not');
  });

  it('reads the pull request and its head from the event payload', async () => {
    expect(await detect({ ...actionsEnv, GITHUB_TOKEN: 't' })).toEqual({
      repository: 'octo/app',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      runUrl: 'https://github.com/octo/app/actions/runs/99',
      eventName: 'pull_request',
      workflow: 'e2e',
      job: 'test',
      sha: 'head-sha',
      pullRequest: 41,
      token: 't',
      stepSummaryPath: '/summary.md',
    });
  });

  it('takes an issue_comment on a pull request without a commit to link, and not one on an issue', async () => {
    const comment = await detect({ ...actionsEnv, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: '/event/comment.json' });
    expect(comment?.pullRequest).toBe(7);
    // GITHUB_SHA is the default branch on this event, not the pull request's head.
    expect(comment?.sha).toBeUndefined();
    const issue = await detect({ ...actionsEnv, GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: '/event/issue.json' });
    expect(issue?.pullRequest).toBeUndefined();
    expect(issue?.sha).toBe('merge-sha');
  });

  it('falls back to the ref when the payload is missing, broken, or not about a pull request', async () => {
    const ref = { GITHUB_REF: 'refs/pull/12/merge', GITHUB_EVENT_PATH: '/event/push.json' };
    expect((await detect({ ...actionsEnv, ...ref }))?.pullRequest).toBe(12);
    expect((await detect({ ...actionsEnv, ...ref, GITHUB_EVENT_PATH: '/event/broken.json' }))?.pullRequest).toBe(12);
    expect((await detect({ ...actionsEnv, ...ref, GITHUB_EVENT_PATH: '/event/missing.json' }))?.pullRequest).toBe(12);
    expect((await detect({ ...actionsEnv, ...ref, GITHUB_REF: 'refs/pull/0/merge' }))?.pullRequest).toBeUndefined();
    const push = await detect({ ...actionsEnv, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: '/event/push.json' });
    expect(push?.pullRequest).toBeUndefined();
    expect(push?.sha).toBe('merge-sha');
  });

  it('reads GH_TOKEN when GITHUB_TOKEN is unset and honors Enterprise Server URLs', async () => {
    const context = await detect({
      ...actionsEnv,
      GH_TOKEN: 'gh',
      GITHUB_SERVER_URL: 'https://git.corp.example/',
      GITHUB_API_URL: 'https://git.corp.example/api/v3/',
    });
    expect(context?.token).toBe('gh');
    expect(context?.serverUrl).toBe('https://git.corp.example');
    expect(context?.apiUrl).toBe('https://git.corp.example/api/v3');
    expect(context?.runUrl).toBe('https://git.corp.example/octo/app/actions/runs/99');
  });
});
