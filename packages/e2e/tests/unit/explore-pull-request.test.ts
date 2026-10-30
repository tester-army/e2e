/** The pull request text `e2e explore --changed-since` reads from the CI job: where from, and how it is cut. */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPullRequest } from '../../src/explore/pull-request.ts';
import { useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();

/** A GitHub Actions environment whose event payload is `event`. */
function github(eventName: string, event: unknown): NodeJS.ProcessEnv {
  const file = path.join(tempDir(), 'event.json');
  writeFileSync(file, typeof event === 'string' ? event : JSON.stringify(event));
  return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: file };
}

describe('readPullRequest', () => {
  it('reads a GitHub pull_request event, dropping template comments', () => {
    const env = github('pull_request', { pull_request: { number: 12, title: '  Add\n gift wrap ', body: '<!-- Describe the change -->\r\nAdds gift wrap.\r\n\r\n\r\n\r\n<!-- How to test -->Open checkout.' } });
    expect(readPullRequest(env)).toEqual({ ref: '#12', title: 'Add gift wrap', description: 'Adds gift wrap.\n\nOpen checkout.', cut: false });
  });

  it('has no description for an empty body or one of template comments only', () => {
    expect(readPullRequest(github('pull_request', { pull_request: { number: 1, title: 'T', body: null } }))?.description).toBeUndefined();
    expect(readPullRequest(github('pull_request', { pull_request: { number: 1, title: 'T', body: '<!-- only a template -->\n' } }))?.description).toBeUndefined();
  });

  it('reads nothing from other GitHub events, pull_request_target included, or an unreadable payload', () => {
    const pull = { pull_request: { number: 1, title: 'T', body: 'B' } };
    expect(readPullRequest(github('pull_request_target', pull))).toBeUndefined();
    expect(readPullRequest(github('push', pull))).toBeUndefined();
    expect(readPullRequest(github('pull_request', 'not json'))).toBeUndefined();
    expect(readPullRequest(github('pull_request', { pull_request: { title: 'no number' } }))).toBeUndefined();
    expect(readPullRequest({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' })).toBeUndefined();
  });

  it('reads a GitLab merge request pipeline, and nothing outside a CI that names one', () => {
    expect(readPullRequest({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '9', CI_MERGE_REQUEST_TITLE: 'Fix cart', CI_MERGE_REQUEST_DESCRIPTION: 'Totals round.' })).toEqual({
      ref: '!9',
      title: 'Fix cart',
      description: 'Totals round.',
      cut: false,
    });
    expect(readPullRequest({ GITLAB_CI: 'true' })).toBeUndefined();
    expect(readPullRequest({})).toBeUndefined();
  });

  it('caps the title and cuts the description to whole lines within its budget, long lines capped', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(60)}`);
    const read = readPullRequest({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '1', CI_MERGE_REQUEST_TITLE: 't'.repeat(300), CI_MERGE_REQUEST_DESCRIPTION: lines.join('\n') })!;
    expect(read.title).toBe(`${'t'.repeat(199)}…`);
    expect(read.cut).toBe(true);
    // Within the budget as the brief shows it, each line indented.
    expect(Buffer.byteLength(read.description!.replaceAll(/^/gmu, '  '))).toBeLessThanOrEqual(1_500);
    expect(lines.join('\n').startsWith(read.description!)).toBe(true);
    const long = readPullRequest({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '1', CI_MERGE_REQUEST_TITLE: 'T', CI_MERGE_REQUEST_DESCRIPTION: 'y'.repeat(800) })!;
    expect(long).toMatchObject({ description: `${'y'.repeat(597)}…`, cut: true });
    // A long first paragraph in three-byte characters is cut, never dropped.
    const wide = readPullRequest({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '1', CI_MERGE_REQUEST_TITLE: 'T', CI_MERGE_REQUEST_DESCRIPTION: `${'中'.repeat(600)}\n${'中'.repeat(600)}` })!;
    expect(wide).toMatchObject({ description: `${'中'.repeat(199)}…\n${'中'.repeat(199)}…`, cut: true });
  });
});
