/** The reporter end to end against fakes: where it posts, where it writes, and what each row says. */

import { describe, expect, it } from 'vitest';
import { reportRun, type ReportDeps } from '../../src/reporter.ts';
import { actionsEnv, fakeGitHub, json, readEvent } from './fake-github.ts';
import { attempt, finished, report, result } from './fixtures.ts';

const posted = json(201, { id: 5, html_url: 'https://github.com/octo/app/pull/41#issuecomment-5' });
const script = { 'GET *': () => json(200, []), 'POST *': () => posted.clone() };

/** Fakes for the reporter; `gitDirs` are the `.git` entries that exist, so the checkout root is where the test puts it. */
function deps(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, gitDirs: readonly string[] = ['/work/.git']) {
  const written: Record<string, string> = {};
  const gh = fakeGitHub(script);
  return {
    deps: {
      fetch: fetchImpl ?? gh.fetch,
      env,
      exists: (file: string) => gitDirs.includes(file),
      readFile: readEvent,
      appendFile: async (file: string, text: string) => {
        if (file === '/readonly.md') throw new Error('EACCES: permission denied');
        written[file] = (written[file] ?? '') + text;
      },
    } satisfies ReportDeps,
    written,
    calls: gh.calls,
  };
}

const signal = new AbortController().signal;
const failedRun = finished(
  report({
    status: 'failed',
    results: [
      result({
        title: 'checkout',
        file: 'tests/shop flows/cart.e2e.ts',
        line: 9,
        status: 'failed',
        attempts: [attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' }, artifacts: ['screenshot'] })],
      }),
    ],
  }),
);
const postedBody = (calls: { method: string; body: unknown }[]): string =>
  (calls.find((call) => call.method === 'POST')?.body as { body: string } | undefined)?.body ?? '';

describe('reportRun', () => {
  it('posts nothing off GitHub Actions', async () => {
    const d = deps({ CI: '1', GITLAB_CI: 'true' });
    await expect(reportRun(failedRun, signal, {}, d.deps)).resolves.toEqual([
      { label: 'GitHub', text: 'not posted: not running on GitHub Actions' },
    ]);
    expect(d.calls).toHaveLength(0);
    expect(d.written).toEqual({});
  });

  it('writes the job summary and posts one comment with the marker, encoded source links, and the run link', async () => {
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    await expect(reportRun(failedRun, signal, {}, d.deps)).resolves.toEqual([
      { label: 'GitHub', text: 'https://github.com/octo/app/pull/41#issuecomment-5' },
    ]);
    const summary = d.written['/summary.md'];
    expect(summary).toContain('### 🔴 e2e: 1 failed');
    expect(summary).not.toContain('<!-- e2e-github');
    expect(d.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    const body = postedBody(d.calls);
    expect(body.startsWith('<!-- e2e-github project=dev.example.shop workflow=e2e job=test -->\n')).toBe(true);
    expect(body).toContain('[tests/shop flows/cart.e2e.ts:9](https://github.com/octo/app/blob/head-sha/tests/shop%20flows/cart.e2e.ts#L9)');
    expect(body).toContain('Evidence: [screenshot](https://github.com/octo/app/actions/runs/99#artifacts)');
    expect(body).toContain('[run artifacts](https://github.com/octo/app/actions/runs/99#artifacts)');
  });

  it('links sources under the project path inside the checkout, and at the root when the project is the checkout', async () => {
    // The checkout is the workspace (.git at /work); the project is its packages-style child.
    const nested = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/work' });
    await reportRun(failedRun, signal, {}, nested.deps);
    expect(postedBody(nested.calls)).toContain('(https://github.com/octo/app/blob/head-sha/app/tests/shop%20flows/cart.e2e.ts#L9)');
    // actions/checkout with `path: app`: the repository root is below the workspace, and the project is that root.
    const checkedOutBelow = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/work' }, undefined, ['/work/app/.git']);
    await reportRun(failedRun, signal, {}, checkedOutBelow.deps);
    expect(postedBody(checkedOutBelow.calls)).toContain('(https://github.com/octo/app/blob/head-sha/tests/shop%20flows/cart.e2e.ts#L9)');
    // No .git anywhere: the workspace is taken for the checkout.
    const bare = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/work' }, undefined, []);
    await reportRun(failedRun, signal, {}, bare.deps);
    expect(postedBody(bare.calls)).toContain('(https://github.com/octo/app/blob/head-sha/app/tests/shop%20flows/cart.e2e.ts#L9)');
    const root = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/work/app' });
    await reportRun(failedRun, signal, {}, root.deps);
    expect(postedBody(root.calls)).toContain('(https://github.com/octo/app/blob/head-sha/tests/shop%20flows/cart.e2e.ts#L9)');
    const outside = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/elsewhere' });
    await reportRun(failedRun, signal, {}, outside.deps);
    expect(postedBody(outside.calls)).toContain('(https://github.com/octo/app/blob/head-sha/tests/shop%20flows/cart.e2e.ts#L9)');
    // A project directory may begin with two dots; only a real parent traversal drops the prefix.
    const dotted = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKSPACE: '/work' });
    await reportRun({ ...failedRun, projectRoot: '/work/..app' }, signal, {}, dotted.deps);
    expect(postedBody(dotted.calls)).toContain('(https://github.com/octo/app/blob/head-sha/..app/tests/shop%20flows/cart.e2e.ts#L9)');
  });

  it('folds a --last-failed rerun into the run it selected from, so the comment shows the whole suite with the recovered test flaky', async () => {
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    const failedAttempt = attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' } });
    const firstPass = report({
      status: 'failed',
      results: [
        result({ title: 'steady', status: 'passed', attempts: [attempt()] }),
        result({ title: 'recovers', status: 'failed', attempts: [failedAttempt] }),
      ],
    });
    const rerun = report({
      results: [
        result({ title: 'steady', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'did not fail in the last run' } }),
        result({ title: 'recovers', status: 'passed', attempts: [attempt()] }),
      ],
    });
    await reportRun(finished(rerun, firstPass), signal, {}, d.deps);
    const body = postedBody(d.calls);
    expect(body).toContain('### 🟢 e2e: 1 flaky, 1 passed');
  });

  it('adds the key to the marker, encoded, so matrix replicas keep their own comments', async () => {
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    await reportRun(failedRun, signal, { key: 'firefox --> 2' }, d.deps);
    expect(postedBody(d.calls).startsWith('<!-- e2e-github project=dev.example.shop workflow=e2e job=test key=firefox%20--%3E%202 -->\n')).toBe(true);
    const blank = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    await reportRun(failedRun, signal, { key: '' }, blank.deps);
    expect(postedBody(blank.calls).startsWith('<!-- e2e-github project=dev.example.shop workflow=e2e job=test -->\n')).toBe(true);
    // A key that fits is the encoded key itself, byte for byte, so comments already on open pull requests are found.
    const fits = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    await reportRun(failedRun, signal, { key: 'k'.repeat(200) }, fits.deps);
    expect(postedBody(fits.calls).startsWith(`<!-- e2e-github project=dev.example.shop workflow=e2e job=test key=${'k'.repeat(200)} -->\n`)).toBe(true);
    // A long key keeps a prefix and a digest of the whole key, the same every run, so the marker stays bounded and findable.
    const long = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
    await reportRun(failedRun, signal, { key: 'k'.repeat(5_000) }, long.deps);
    expect(postedBody(long.calls).startsWith(`<!-- e2e-github project=dev.example.shop workflow=e2e job=test key=${'k'.repeat(183)}#622b8b1d5094d382 -->\n`)).toBe(true);
    // The cut is on the encoded form and never inside a percent escape, so emoji cannot outgrow the marker.
    const emoji = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_WORKFLOW: '💥'.repeat(300), GITHUB_JOB: 'ü'.repeat(300) });
    await reportRun(failedRun, signal, { key: '💥'.repeat(300) }, emoji.deps);
    const marker = /^<!-- e2e-github [^\n]* -->/.exec(postedBody(emoji.calls))?.[0] ?? '';
    expect(marker.length).toBeGreaterThan(0);
    expect(marker.length).toBeLessThanOrEqual(1_024);
    expect(marker).toMatch(/ key=(?:%[0-9A-F]{2})+#[0-9a-f]{16} -->$/);
  });

  it('keeps two long keys that share their first 200 characters on their own comments', async () => {
    const markers: string[] = [];
    for (const key of [`android-${'x'.repeat(200)}-A`, `android-${'x'.repeat(200)}-B`]) {
      const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' });
      await reportRun(failedRun, signal, { key }, d.deps);
      markers.push(postedBody(d.calls).split('\n', 1)[0] ?? '');
    }
    expect(markers[0]).toMatch(/^<!-- e2e-github .* key=android-x+#[0-9a-f]{16} -->$/);
    expect(markers[0]).not.toBe(markers[1]);
    // B does not take over the comment A posted; it posts its own.
    const comments = [{ id: 1, body: `${markers[0]}\n### e2e android A` }];
    const gh = fakeGitHub({ 'GET *': () => json(200, comments), 'POST *': () => posted.clone() });
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' }, gh.fetch);
    await reportRun(failedRun, signal, { key: `android-${'x'.repeat(200)}-B` }, d.deps);
    expect(gh.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
  });

  it.each([
    ['a push', { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/event/push.json', GITHUB_REF: 'refs/heads/main' }, 'push is not a pull request'],
    ['an issue_comment on a plain issue', { GITHUB_EVENT_NAME: 'issue_comment', GITHUB_EVENT_PATH: '/event/issue.json' }, 'issue_comment is not a pull request'],
  ])('on %s it writes the summary only and says so', async (_name, env, reason) => {
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', ...env });
    await expect(reportRun(failedRun, signal, {}, d.deps)).resolves.toEqual([
      { label: 'GitHub', text: `not posted: ${reason}; written to the job summary` },
    ]);
    expect(d.calls).toHaveLength(0);
    expect(d.written['/summary.md']).toContain('### 🔴 e2e');
  });

  it('without a token it names the line to add to the step, and drops the summary clause when there is no summary file', async () => {
    const d = deps({ ...actionsEnv });
    await expect(reportRun(failedRun, signal, {}, d.deps)).resolves.toEqual([
      { label: 'GitHub', text: "not posted: set GITHUB_TOKEN in the step's env (GITHUB_TOKEN: ${{ github.token }}); written to the job summary" },
    ]);
    const { GITHUB_STEP_SUMMARY: _, ...noSummary } = actionsEnv;
    const bare = deps(noSummary);
    await expect(reportRun(failedRun, signal, {}, bare.deps)).resolves.toEqual([
      { label: 'GitHub', text: "not posted: set GITHUB_TOKEN in the step's env (GITHUB_TOKEN: ${{ github.token }})" },
    ]);
    expect(bare.written).toEqual({});
  });

  it('a summary that cannot be written is its own row and does not stop the comment', async () => {
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs', GITHUB_STEP_SUMMARY: '/readonly.md' });
    await expect(reportRun(failedRun, signal, {}, d.deps)).resolves.toEqual([
      { label: 'GitHub', text: 'https://github.com/octo/app/pull/41#issuecomment-5' },
      { label: 'GitHub', text: 'job summary not written: EACCES: permission denied' },
    ]);
  });

  it('lets a GitHub failure surface as the one error the runner prints, after the summary is written', async () => {
    const forbidden = fakeGitHub({ 'GET *': () => json(403, {}) });
    const d = deps({ ...actionsEnv, GITHUB_TOKEN: 'ghs' }, forbidden.fetch);
    await expect(reportRun(failedRun, signal, {}, d.deps)).rejects.toThrow('the token cannot comment on octo/app#41');
    expect(d.written['/summary.md']).toContain('### 🔴 e2e');
  });
});
