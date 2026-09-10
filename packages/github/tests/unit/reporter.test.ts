/** The reporter end to end against fakes: where it posts, where it writes, and what each row says. */

import { describe, expect, it } from 'vitest';
import { github } from '../../src/index.ts';
import { reportRun, type ReportDeps } from '../../src/reporter.ts';
import { attempt, finished, report, result } from './fixtures.ts';

const PR_EVENT = JSON.stringify({ pull_request: { number: 41, head: { sha: 'head-sha' } } });

function deps(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ReportDeps & { written: Record<string, string>; calls: { method: string; url: string; body: unknown }[] } {
  const written: Record<string, string> = {};
  const calls: { method: string; url: string; body: unknown }[] = [];
  const defaultFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    if (method === 'GET') return new Response('[]', { status: 200 });
    return new Response(JSON.stringify({ id: 5, html_url: 'https://github.com/octo/app/pull/41#issuecomment-5' }), { status: 201 });
  }) as typeof fetch;
  return {
    fetch: fetchImpl ?? defaultFetch,
    env,
    readFile: async (file) => {
      if (file === '/event.json') return PR_EVENT;
      throw new Error(`ENOENT ${file}`);
    },
    appendFile: async (file, text) => {
      if (file === '/readonly.md') throw new Error('EACCES: permission denied');
      written[file] = (written[file] ?? '') + text;
    },
    written,
    calls,
  };
}

const actions = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'octo/app',
  GITHUB_SHA: 'merge-sha',
  GITHUB_RUN_ID: '99',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_EVENT_PATH: '/event.json',
  GITHUB_WORKFLOW: 'e2e',
  GITHUB_JOB: 'test',
  GITHUB_STEP_SUMMARY: '/summary.md',
};
const signal = new AbortController().signal;
const failedRun = finished(
  report({
    status: 'failed',
    results: [result({ title: 'checkout', file: 'tests/shop.e2e.ts', line: 9, status: 'failed', attempts: [attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' }, artifacts: ['screenshot'] })] })],
  }),
);

describe('github()', () => {
  it('is a reporter named github with a finish handler and no event handler', () => {
    const reporter = github();
    expect(reporter.name).toBe('github');
    expect(typeof reporter.onRunFinished).toBe('function');
    expect(reporter.onEvent).toBeUndefined();
  });
});

describe('reportRun', () => {
  it('posts nothing off GitHub Actions and says where to post from instead', async () => {
    const d = deps({ CI: '1', GITLAB_CI: 'true' });
    await expect(reportRun(failedRun, signal, {}, d)).resolves.toEqual([
      { label: 'GitHub', text: 'not posted: not running on GitHub Actions; @e2edev/testerarmy posts results from any CI' },
    ]);
    expect(d.calls).toHaveLength(0);
    expect(d.written).toEqual({});
  });

  it('writes the job summary and posts one comment carrying the marker, source links, and the run link', async () => {
    const d = deps({ ...actions, GITHUB_TOKEN: 'ghs' });
    await expect(reportRun(failedRun, signal, {}, d)).resolves.toEqual([
      { label: 'GitHub', text: 'https://github.com/octo/app/pull/41#issuecomment-5' },
    ]);
    const summary = d.written['/summary.md'];
    expect(summary).toContain('### ❌ e2e: 1 failed');
    expect(summary).not.toContain('<!-- e2e-github');
    expect(d.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    const posted = d.calls[1]?.body as { body: string } | undefined;
    const body = posted?.body ?? '';
    expect(body.startsWith('<!-- e2e-github project=dev.example.shop workflow=e2e job=test -->\n')).toBe(true);
    expect(body).toContain('[tests/shop.e2e.ts:9](https://github.com/octo/app/blob/head-sha/tests/shop.e2e.ts#L9)');
    expect(body).toContain('[screenshot](https://github.com/octo/app/actions/runs/99)');
    expect(body).toContain('[run artifacts](https://github.com/octo/app/actions/runs/99)');
  });

  it('adds the key to the marker so matrix replicas keep their own comments', async () => {
    const d = deps({ ...actions, GITHUB_TOKEN: 'ghs' });
    await reportRun(failedRun, signal, { key: 'firefox' }, d);
    const body = (d.calls[1]?.body as { body: string } | undefined)?.body ?? '';
    expect(body.startsWith('<!-- e2e-github project=dev.example.shop workflow=e2e job=test key=firefox -->\n')).toBe(true);
  });

  it('on a push it writes the summary only and says so', async () => {
    const d = deps({ ...actions, GITHUB_TOKEN: 'ghs', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/push.json', GITHUB_REF: 'refs/heads/main' });
    await expect(reportRun(failedRun, signal, {}, d)).resolves.toEqual([
      { label: 'GitHub', text: 'not posted: push is not a pull request; written to the job summary' },
    ]);
    expect(d.calls).toHaveLength(0);
    expect(d.written['/summary.md']).toContain('### ❌ e2e');
  });

  it('without a token it names the line to add to the step', async () => {
    const d = deps({ ...actions });
    await expect(reportRun(failedRun, signal, {}, d)).resolves.toEqual([
      { label: 'GitHub', text: "not posted: set GITHUB_TOKEN in the step's env (GITHUB_TOKEN: ${{ github.token }}); written to the job summary" },
    ]);
    expect(d.calls).toHaveLength(0);
  });

  it('a summary that cannot be written is its own row and does not stop the comment', async () => {
    const d = deps({ ...actions, GITHUB_TOKEN: 'ghs', GITHUB_STEP_SUMMARY: '/readonly.md' });
    await expect(reportRun(failedRun, signal, {}, d)).resolves.toEqual([
      { label: 'GitHub', text: 'https://github.com/octo/app/pull/41#issuecomment-5' },
      { label: 'GitHub', text: 'job summary not written: EACCES: permission denied' },
    ]);
  });

  it('lets a GitHub failure surface as the one error the runner prints', async () => {
    const forbidden = (async () => new Response('{}', { status: 403 })) as typeof fetch;
    const d = deps({ ...actions, GITHUB_TOKEN: 'ghs' }, forbidden);
    await expect(reportRun(failedRun, signal, {}, d)).rejects.toThrow('the token cannot comment on octo/app#41');
    expect(d.written['/summary.md']).toContain('### ❌ e2e');
  });
});
