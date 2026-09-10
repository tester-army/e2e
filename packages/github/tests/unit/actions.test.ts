/** The Actions context: what is read from where, and what counts as not being on Actions. */

import { describe, expect, it } from 'vitest';
import { detectActions } from '../../src/actions.ts';

const files: Record<string, string> = {
  '/event/pr.json': JSON.stringify({ pull_request: { number: 41, head: { sha: 'head-sha' } } }),
  '/event/comment.json': JSON.stringify({ issue: { number: 7, pull_request: { url: 'x' } } }),
  '/event/issue.json': JSON.stringify({ issue: { number: 8 } }),
  '/event/push.json': JSON.stringify({ ref: 'refs/heads/main' }),
  '/event/broken.json': '{not json',
};
const readFile = async (file: string): Promise<string> => {
  const text = files[file];
  if (text === undefined) throw new Error(`ENOENT ${file}`);
  return text;
};

const base = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'octo/app',
  GITHUB_SHA: 'merge-sha',
  GITHUB_RUN_ID: '99',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_WORKFLOW: 'e2e',
  GITHUB_JOB: 'test',
  GITHUB_STEP_SUMMARY: '/summary.md',
};

describe('detectActions', () => {
  it('is nothing outside Actions or without a repository', async () => {
    expect(await detectActions({ env: {}, readFile })).toBeUndefined();
    expect(await detectActions({ env: { GITHUB_ACTIONS: 'true' }, readFile })).toBeUndefined();
    expect(await detectActions({ env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'nonsense' }, readFile })).toBeUndefined();
  });

  it('reads the pull request and its head from the event payload', async () => {
    const context = await detectActions({ env: { ...base, GITHUB_EVENT_PATH: '/event/pr.json', GITHUB_TOKEN: 't' }, readFile });
    expect(context).toEqual({
      repository: 'octo/app',
      serverUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
      runUrl: 'https://github.com/octo/app/actions/runs/99',
      sha: 'head-sha',
      eventName: 'pull_request',
      pullRequest: 41,
      token: 't',
      stepSummaryPath: '/summary.md',
      workflow: 'e2e',
      job: 'test',
    });
  });

  it('takes an issue_comment on a pull request without a commit to link, and not one on an issue', async () => {
    const comment = await detectActions({ env: { ...base, GITHUB_EVENT_PATH: '/event/comment.json' }, readFile });
    expect(comment?.pullRequest).toBe(7);
    // GITHUB_SHA is the default branch on this event, not the pull request's head.
    expect(comment?.sha).toBeUndefined();
    expect((await detectActions({ env: { ...base, GITHUB_EVENT_PATH: '/event/issue.json' }, readFile }))?.pullRequest).toBeUndefined();
  });

  it('falls back to the ref when the payload is missing, broken, or not about a pull request', async () => {
    const ref = { GITHUB_REF: 'refs/pull/12/merge' };
    expect((await detectActions({ env: { ...base, ...ref }, readFile }))?.pullRequest).toBe(12);
    expect((await detectActions({ env: { ...base, ...ref, GITHUB_EVENT_PATH: '/event/broken.json' }, readFile }))?.pullRequest).toBe(12);
    expect((await detectActions({ env: { ...base, ...ref, GITHUB_EVENT_PATH: '/event/missing.json' }, readFile }))?.pullRequest).toBe(12);
    const push = await detectActions({ env: { ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: '/event/push.json' }, readFile });
    expect(push?.pullRequest).toBeUndefined();
    expect(push?.sha).toBe('merge-sha');
  });

  it('reads GH_TOKEN when GITHUB_TOKEN is unset and honors Enterprise Server URLs', async () => {
    const context = await detectActions({
      env: { ...base, GH_TOKEN: 'gh', GITHUB_SERVER_URL: 'https://git.corp.example/', GITHUB_API_URL: 'https://git.corp.example/api/v3/' },
      readFile,
    });
    expect(context?.token).toBe('gh');
    expect(context?.serverUrl).toBe('https://git.corp.example');
    expect(context?.apiUrl).toBe('https://git.corp.example/api/v3');
    expect(context?.runUrl).toBe('https://git.corp.example/octo/app/actions/runs/99');
  });
});
