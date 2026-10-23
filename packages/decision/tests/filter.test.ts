import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APICallError, gateway } from 'ai';
import { describe, expect, it } from 'vitest';
import { decisionFilter } from '../src/index.ts';
import { candidate, changedRepo, commitAll, filterContext, scriptedJudge, SECRET, withSetup, type DecideRequest } from './filter-helpers.ts';
import { scriptedDecision } from './helpers.ts';

const CART = 'tests/cart.e2e.ts';
const LOGIN = 'tests/login.e2e.ts';
const SEARCH = 'tests/search.e2e.ts';

/** A repository whose change edits the cart, with three test files committed at the base. */
function cartRepo(change: Readonly<Record<string, string>> = { 'src/cart.ts': 'export const total = 2;\n' }) {
  return changedRepo(
    {
      'src/cart.ts': 'export const total = 1;\n',
      [CART]: "test('adds an item', async () => {});\ntest('removes an item', async () => {});\n",
      [LOGIN]: "test('signs in', async () => {});\n",
      [SEARCH]: "test('finds a product', async () => {});\n",
    },
    change,
  );
}

const ADDS = candidate(CART, 'cart', 'adds an item');
const REMOVES = candidate(CART, 'cart', 'removes an item');
const SIGNS_IN = candidate(LOGIN, 'signs in');
const FINDS = candidate(SEARCH, 'finds a product');

/** The question the filter asks about the test at `titlePath` in `file`. */
function asked(file: string, ...titlePath: string[]): string {
  return `Can the diff change what the e2e test "${titlePath.join(' > ')}" in ${file} checks? testFiles["${file}"] is its file, hooks included.`;
}

/** The test files a call sent, by path. */
function sent(request: DecideRequest | undefined): Record<string, string> {
  return (request?.state as { testFiles: Record<string, string> } | undefined)?.testFiles ?? {};
}

/** A test file of about `size` characters with one test titled `title`. */
function sized(title: string, size: number): string {
  return `test('${title}', async () => {});\n// ${'x'.repeat(size)}\n`;
}

describe('decisionFilter', () => {
  it('asks the model it is given about every test file that fits in one call, one question per test', async () => {
    const repo = cartRepo();
    const { model, requests } = scriptedJudge(() => 0.9);
    const { context, logs } = filterContext(repo);
    const filter = decisionFilter({ model });
    expect(filter.name).toBe('decision');
    const result = await filter.filter([ADDS, SIGNS_IN, REMOVES], context);
    expect(result).toEqual({ exclude: {}, note: '1 call, 10 tokens' });
    expect(logs).toEqual(['asking scripted-judge about 3 tests in 2 files']);
    expect(requests.map((request) => request.instructions)).toEqual([
      { t0: asked(CART, 'cart', 'adds an item'), t1: asked(CART, 'cart', 'removes an item'), t2: asked(LOGIN, 'signs in') },
    ]);
    expect(Object.keys(sent(requests[0]))).toEqual([CART, LOGIN]);
    expect(requests[0]?.abortSignal?.aborted).toBe(false);
  });

  it('splits the test files into calls that each stay within the size the model takes', async () => {
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [CART]: sized('adds an item', 45_000), [LOGIN]: sized('signs in', 45_000), [SEARCH]: sized('finds a product', 100) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS, SIGNS_IN, FINDS], filterContext(repo).context);
    expect(requests.map((request) => Object.keys(sent(request))).toSorted()).toEqual([[CART], [LOGIN, SEARCH]]);
    for (const request of requests) {
      const { diff, testFiles } = request.state as { diff: string; testFiles: Record<string, string> };
      expect(diff).toContain('+export const total = 2;');
      expect(diff.length + Object.values(testFiles).join('').length).toBeLessThanOrEqual(80_000);
    }
  });

  it('asks at most 200 questions in one call', async () => {
    const many = (file: string) => Array.from({ length: 100 }, (_, i) => candidate(file, `test ${i}`));
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([...many(CART), ...many(LOGIN), ...many(SEARCH)], filterContext(cartRepo()).context);
    expect(requests.map((request) => Object.keys(request.instructions).length).toSorted()).toEqual([100, 200]);
  });

  it('splits a file with more than 200 tests across calls, each sending the file', async () => {
    const tests = Array.from({ length: 450 }, (_, i) => candidate(CART, `test ${i}`));
    const { model, requests } = scriptedJudge((text) => (text.includes('"test 449"') ? 0 : 0.9));
    const result = await decisionFilter({ model }).filter(tests, filterContext(cartRepo()).context);
    expect(requests.map((request) => Object.keys(request.instructions).length).toSorted()).toEqual([200, 200, 50]);
    expect(requests.map((request) => Object.keys(sent(request)))).toEqual([[CART], [CART], [CART]]);
    expect(result).toEqual({ exclude: { [tests[449]!.id]: '0% likely affected' }, note: '3 calls, 30 tokens' });
  });

  it('makes at most 8 calls at once', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `tests/t${i}.e2e.ts`);
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', ...Object.fromEntries(files.map((file) => [file, sized('runs', 45_000)])) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    let inFlight = 0;
    let most = 0;
    const { model, requests } = scriptedJudge(
      () => 0.9,
      async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
      },
    );
    await decisionFilter({ model }).filter(
      files.map((file) => candidate(file, 'runs')),
      filterContext(repo).context,
    );
    expect(requests).toHaveLength(10);
    expect(most).toBe(8);
  });

  it('leaves the tests of a file too large to send with the diff in, and judges the rest', async () => {
    const huge = 'tests/huge.e2e.ts';
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [huge]: sized('scrolls', 90_000), [LOGIN]: "test('signs in', async () => {});\n" },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([candidate(huge, 'scrolls'), SIGNS_IN], filterContext(repo).context);
    expect(result).toEqual({
      exclude: { [SIGNS_IN.id]: '0% likely affected' },
      note: 'scripted-judge did not judge 1 test in 1 file: tests/huge.e2e.ts is too large to send with the diff; 1 call, 10 tokens',
    });
    expect(requests.map((request) => Object.keys(sent(request)))).toEqual([[LOGIN]]);
  });

  it('leaves every test in, making no call, when every file is too large to send with the diff', async () => {
    const huge = 'tests/huge.e2e.ts';
    const repo = changedRepo({ 'src/cart.ts': 'export const total = 1;\n', [huge]: sized('scrolls', 90_000) }, { 'src/cart.ts': 'export const total = 2;\n' });
    const { model, requests } = scriptedJudge(() => 0);
    expect(await decisionFilter({ model }).filter([candidate(huge, 'scrolls')], filterContext(repo).context)).toEqual({
      exclude: {},
      note: 'scripted-judge did not judge 1 test in 1 file: tests/huge.e2e.ts is too large to send with the diff',
    });
    expect(requests).toEqual([]);
  });

  it('sends the redacted diff and the redacted test file under its redacted path', async () => {
    const file = `tests/${SECRET}.e2e.ts`;
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [file]: `test('signs in with ${SECRET}', async () => {});\n` },
      { 'src/cart.ts': `export const key = '${SECRET}';\n` },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([candidate(file, `signs in with ${SECRET}`)], filterContext(repo).context);
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain("+export const key = '[redacted]';");
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(sent(requests[0])).toEqual({ 'tests/[redacted].e2e.ts': readFileSync(path.join(repo.root, file), 'utf8').replaceAll(SECRET, '[redacted]') });
    expect(requests[0]?.instructions).toEqual({ t0: asked('tests/[redacted].e2e.ts', 'signs in with [redacted]') });
  });

  it('sends test files whose paths redact to the same key in separate calls', async () => {
    const [alpha, beta] = ['tests/alpha.e2e.ts', 'tests/beta.e2e.ts'];
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [alpha]: "test('runs a', async () => {});\n", [beta]: "test('runs b', async () => {});\n" },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([candidate(alpha, 'runs a'), candidate(beta, 'runs b')], {
      ...context,
      redact: (text) => text.replaceAll(/alpha|beta/gu, '[redacted]'),
    });
    expect(requests.map((request) => sent(request)['tests/[redacted].e2e.ts']).toSorted()).toEqual([
      "test('runs a', async () => {});\n",
      "test('runs b', async () => {});\n",
    ]);
  });

  it('sends the diff as redact returns it, given the whole diff at once', async () => {
    const repo = cartRepo({ 'src/cart.ts': 'export const total = 2;\n', 'src/tax.ts': 'export const rate = 1;\n' });
    const { context } = filterContext(repo);
    const given: string[] = [];
    const redact = (text: string): string => {
      given.push(text);
      return text.replaceAll('export', '[redacted]');
    };
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([SIGNS_IN], { ...context, redact });
    const diffs = given.filter((text) => text.startsWith('diff --git '));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain('-export const total = 1;\n+export const total = 2;\n');
    expect(diffs[0]).toContain('+export const rate = 1;\n');
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toBe(diffs[0]?.replaceAll('export', '[redacted]'));
  });

  it("sends git's plain unified diff whatever the repository's diff config says", async () => {
    const repo = changedRepo(
      { '.gitattributes': '*.ts diff=shout\n', 'src/cart.ts': 'export const total = 1;\n', [LOGIN]: "test('signs in', async () => {});\n" },
      { 'src/cart.ts': 'export const total = 2;\n' },
      { config: { 'color.ui': 'always', 'diff.external': 'echo external', 'diff.shout.textconv': 'sed s/total/TOTAL/' } },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([SIGNS_IN], filterContext(repo).context);
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toMatch(
      /^diff --git a\/src\/cart\.ts b\/src\/cart\.ts\nindex \w+\.\.\w+ 100644\n--- a\/src\/cart\.ts\n\+\+\+ b\/src\/cart\.ts\n@@ -1 \+1 @@\n-export const total = 1;\n\+export const total = 2;\n$/,
    );
  });

  it('sends an untracked file by its name alone, never reading it', async () => {
    // A token redact does not know, as CI may write one into the checkout: only leaving the file unread keeps it out.
    const token = 'sk-ci-8e1f0a9c3b';
    const repo = changedRepo({ 'src/cart.ts': 'export const total = 1;\n', [CART]: "test('adds an item', async () => {});\n" }, {});
    writeFileSync(path.join(repo.root, 'src/coupon.ts'), `export const code = '${token}';\n`);
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: ['src/coupon.ts'] } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toBe('diff --git a/src/coupon.ts b/src/coupon.ts\nnot committed, contents not read\n');
    expect(JSON.stringify(requests)).not.toContain(token);
  });

  it('quotes an untracked name git would quote, so it adds no line of its own, and redacts a secret in one', async () => {
    const repo = changedRepo({ 'src/cart.ts': 'export const total = 1;\n', [CART]: "test('adds an item', async () => {});\n" }, {});
    const odd = 'src/odd\n+export const forged = true;.ts';
    const secretName = `src/${SECRET}.ts`;
    for (const file of [odd, secretName]) writeFileSync(path.join(repo.root, file), 'export {};\n');
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: [odd, secretName].toSorted() } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff.split('\n')).not.toContain('+export const forged = true;.ts');
    expect(state.diff).toContain(`diff --git ${JSON.stringify(`a/${odd}`)} ${JSON.stringify(`b/${odd}`)}\nnot committed, contents not read\n`);
    expect(state.diff).toContain('diff --git a/src/[redacted].ts b/src/[redacted].ts\nnot committed, contents not read\n');
    expect(JSON.stringify(requests)).not.toContain(SECRET);
  });

  it('diffs only the files the change names, so a filter that narrows them narrows what the model reads', async () => {
    const repo = cartRepo({ 'src/cart.ts': 'export const total = 2;\n', 'src/legacy.ts': 'export const old = 2;\n', 'credentials.json': '{}\n' });
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: ['src/cart.ts'] } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('+export const total = 2;\n');
    expect(state.diff).not.toContain('legacy');
    expect(state.diff).not.toContain('credentials');
  });

  it('diffs only what the commits since the base change, and names a file no commit changes, staged or not, without reading it', async () => {
    // A token redact does not know, as CI may write one into a tracked file: only leaving the change unread keeps it out.
    const token = 'sk-ci-3c7d9e2a10';
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', 'src/coupon.ts': 'export const code = 1;\n', 'src/fee.ts': 'export const fee = 1;\n', [CART]: "test('adds an item', async () => {});\n" },
      { 'src/cart.ts': 'export const total = 2;\n', 'src/tax.ts': 'export const rate = 1;\n' },
    );
    for (const file of ['src/cart.ts', 'src/coupon.ts', 'src/fee.ts', 'src/tax.ts']) writeFileSync(path.join(repo.root, file), `export const value = '${token}';\n`);
    execFileSync('git', ['add', 'src/fee.ts', 'src/tax.ts'], { cwd: repo.root });
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: ['src/cart.ts', 'src/coupon.ts', 'src/fee.ts', 'src/tax.ts'] } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff.split('\n').filter((line) => line.startsWith('diff --git '))).toEqual([
      'diff --git a/src/cart.ts b/src/cart.ts',
      'diff --git a/src/tax.ts b/src/tax.ts',
      'diff --git a/src/coupon.ts b/src/coupon.ts',
      'diff --git a/src/fee.ts b/src/fee.ts',
    ]);
    expect(state.diff).toContain('-export const total = 1;\n+export const total = 2;\n');
    expect(state.diff).toContain('+++ b/src/tax.ts\n@@ -0,0 +1 @@\n+export const rate = 1;\n');
    expect(state.diff).toContain('diff --git a/src/coupon.ts b/src/coupon.ts\nnot committed, contents not read\n');
    expect(state.diff).toContain('diff --git a/src/fee.ts b/src/fee.ts\nnot committed, contents not read\n');
    expect(JSON.stringify(requests)).not.toContain(token);
  });

  it('leaves nothing out, making no call, when git prints no diff, as for a change a wrapper narrowed to no files', async () => {
    const { context } = filterContext(cartRepo());
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: [] } });
    expect(result).toEqual({ exclude: {}, note: 'git printed no diff of the changed files, so the decision filter left nothing out' });
    expect(requests).toEqual([]);
  });

  it('asks nothing and logs nothing when a wrapper hands it no tests', async () => {
    const { context, logs } = filterContext(cartRepo());
    const { model, requests } = scriptedJudge(() => 0);
    expect(await decisionFilter({ model }).filter([], context)).toEqual({ exclude: {} });
    expect(requests).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('leaves nothing out, making no call, when the e2e config or a lockfile changed at any depth, never for a file only named like one', async () => {
    for (const file of ['e2e.config.ts', 'apps/web/e2e.config.mjs', 'pnpm-lock.yaml', 'ios/Podfile.lock', 'go.sum', 'gradle/libs.versions.toml']) {
      const { model, requests } = scriptedJudge(() => 0);
      const result = await decisionFilter({ model }).filter([ADDS, SIGNS_IN], filterContext(cartRepo({ [file]: 'changed\n' })).context);
      expect(result, file).toEqual({ exclude: {}, note: `${file} changed, so the decision filter left nothing out` });
      expect(requests, file).toEqual([]);
    }
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(cartRepo({ 'docs/pnpm-lock.yaml.md': 'about locks\n' })).context);
    expect(result.exclude).toEqual({ [SIGNS_IN.id]: '0% likely affected' });
    expect(requests).toHaveLength(1);
  });

  it('keeps the tests whose test file, setup file, or stored screenshots changed without asking, and asks about the rest', async () => {
    // macOS keeps the bytes a file was created with, while git names it in NFC: committed composed, handed over decomposed.
    const setup = 'tests/caf\u00E9.setup.e2e.ts';
    const repo = changedRepo(
      {
        'src/cart.ts': 'export const total = 1;\n',
        [CART]: "test('adds an item', async () => {});\n",
        [LOGIN]: "test('signs in', async () => {});\n",
        [SEARCH]: "test('finds a product', async () => {});\n",
        [setup]: "test.setup('sign in', async () => {});\n",
        'tests/other.e2e.ts': "test('other', async () => {});\n",
      },
      { [CART]: "test('adds an item', async () => { /* edited */ });\n", [setup]: "test.setup('sign in', async () => { /* edited */ });\n", [`${SEARCH}-snapshots/home.png`]: 'png\n', 'src/cart.ts': 'export const total = 2;\n' },
    );
    const other = candidate('tests/other.e2e.ts', 'other');
    const tests = [ADDS, withSetup(SIGNS_IN, 'tests/cafe\u0301.setup.e2e.ts'), FINDS, other];
    const { model, requests } = scriptedJudge(() => 0);
    const { context, logs } = filterContext(repo);
    const result = await decisionFilter({ model }).filter(tests, context);
    expect(result).toEqual({ exclude: { [other.id]: '0% likely affected' }, note: '3 tests ran without asking: the test file, setup file, or stored screenshots changed; 1 call, 10 tokens' });
    expect(logs).toEqual(['asking scripted-judge about 1 test in 1 file']);
    expect(requests.map((request) => Object.keys(sent(request)))).toEqual([['tests/other.e2e.ts']]);
  });

  it('makes no call when the change touched every test it was given', async () => {
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(cartRepo({ [LOGIN]: "test('signs in', async () => { /* edited */ });\n" })).context);
    expect(result).toEqual({ exclude: {}, note: '1 test ran without asking: the test file, setup file, or stored screenshots changed' });
    expect(requests).toEqual([]);
  });

  it('maps a project below the repository root: its own test, setup, and screenshot changes run without asking', async () => {
    const project = 'packages/app';
    const repo = changedRepo(
      {
        'src/shared.ts': 'export const x = 1;\n',
        [`${project}/${CART}`]: "test('adds an item', async () => {});\n",
        [`${project}/${LOGIN}`]: "test('signs in', async () => {});\n",
        [`${project}/${SEARCH}`]: "test('finds a product', async () => {});\n",
        [`${project}/tests/auth.setup.e2e.ts`]: "test.setup('sign in', async () => {});\n",
        // The same paths outside the project are another project's files.
        [CART]: "test('elsewhere', async () => {});\n",
      },
      {
        'src/shared.ts': 'export const x = 2;\n',
        [`${project}/${CART}`]: "test('adds an item', async () => { /* edited */ });\n",
        [`${project}/tests/auth.setup.e2e.ts`]: "test.setup('sign in', async () => { /* edited */ });\n",
        [`${project}/${SEARCH}-snapshots/home.png`]: 'png\n',
        [LOGIN]: "test('elsewhere', async () => {});\n",
      },
      { project },
    );
    const other = candidate('tests/other.e2e.ts', 'other');
    writeFileSync(path.join(repo.projectRoot, 'tests/other.e2e.ts'), "test('other', async () => {});\n");
    const { model, requests } = scriptedJudge(() => 0);
    const tests = [ADDS, withSetup(SIGNS_IN, 'tests/auth.setup.e2e.ts'), FINDS, other];
    const result = await decisionFilter({ model }).filter(tests, filterContext(repo).context);
    expect(result.exclude).toEqual({ [other.id]: '0% likely affected' });
    expect(result.note).toContain('3 tests ran without asking');
    expect(requests.map((request) => Object.keys(sent(request)))).toEqual([[`${project}/tests/other.e2e.ts`]]);
  });

  it("leaves nothing out for the project's own config or lockfile, or one above it, and asks about a sibling project's or a docs folder's", async () => {
    const project = 'apps/web';
    const base = { 'src/cart.ts': 'export const total = 1;\n', [`${project}/${LOGIN}`]: "test('signs in', async () => {});\n" };
    for (const file of [`${project}/e2e.config.ts`, `${project}/ios/Podfile.lock`, 'apps/pnpm-lock.yaml', 'pnpm-lock.yaml']) {
      const { model, requests } = scriptedJudge(() => 0);
      const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(changedRepo(base, { [file]: 'changed\n' }, { project })).context);
      expect(result, file).toEqual({ exclude: {}, note: `${file} changed, so the decision filter left nothing out` });
      expect(requests, file).toEqual([]);
    }
    for (const file of ['apps/admin/e2e.config.ts', 'apps/admin/pnpm-lock.yaml', 'docs/examples/e2e.config.ts', 'apps/web-old/yarn.lock']) {
      const { model, requests } = scriptedJudge(() => 0);
      const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(changedRepo(base, { [file]: 'changed\n' }, { project })).context);
      expect(result.exclude, file).toEqual({ [SIGNS_IN.id]: '0% likely affected' });
      expect(requests, file).toHaveLength(1);
    }
  });

  it('leaves nothing out, making no call, when the config the run loaded changed, whatever its name, and goes by name for any other', async () => {
    const project = 'apps/web';
    const base = { 'src/cart.ts': 'export const total = 1;\n', [`${project}/${LOGIN}`]: "test('signs in', async () => {});\n" };
    const loaded = `${project}/e2e.ci.config.ts`;
    for (const [file, configFile] of [[loaded, loaded], ['config/caf\u00E9.config.ts', 'config/cafe\u0301.config.ts']] as const) {
      const { model, requests } = scriptedJudge(() => 0);
      const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(changedRepo(base, { [file]: 'changed\n' }, { project }), configFile).context);
      expect(result, file).toEqual({ exclude: {}, note: `${file} changed, so the decision filter left nothing out` });
      expect(requests, file).toEqual([]);
    }
    // Another config of the project, one an e2e without `configFile` loaded, goes to the model unless it is named like an e2e config.
    for (const configFile of [`${project}/e2e.config.ts`, undefined]) {
      const { model, requests } = scriptedJudge(() => 0);
      const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(changedRepo(base, { [loaded]: 'changed\n' }, { project }), configFile).context);
      expect(result.exclude, String(configFile)).toEqual({ [SIGNS_IN.id]: '0% likely affected' });
      expect(requests, String(configFile)).toHaveLength(1);
    }
  });

  it('sends a renamed file as a rename and a deleted file without its lines', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    const repo = changedRepo({ 'src/old.ts': `${body}\n`, 'src/gone.ts': 'export const gone = true;\n', [LOGIN]: "test('signs in', async () => {});\n" }, {});
    execFileSync('git', ['mv', 'src/old.ts', 'src/new.ts'], { cwd: repo.root });
    execFileSync('git', ['rm', '--quiet', 'src/gone.ts'], { cwd: repo.root });
    commitAll(repo);
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([SIGNS_IN], { ...context, changes: { ...context.changes, files: ['src/gone.ts', 'src/new.ts', 'src/old.ts'] } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('rename from src/old.ts\nrename to src/new.ts\n');
    expect(state.diff).toContain('deleted file mode 100644');
    expect(state.diff).not.toContain('line0');
    expect(state.diff).not.toContain('gone = true');
  });

  it('diffs the whole repository from its root, and names each test file by its path from there, as the diff does', async () => {
    const repo = changedRepo(
      { 'libs/shared/cart.ts': 'export const total = 1;\n', [`packages/app/${CART}`]: "test('adds an item', async () => {});\n" },
      { 'libs/shared/cart.ts': 'export const total = 2;\n' },
      { project: 'packages/app', config: { 'diff.relative': 'true' } },
    );
    const { model, requests } = scriptedJudge(() => 0.1);
    const result = await decisionFilter({ model }).filter([ADDS], filterContext(repo).context);
    expect(result).toEqual({ exclude: { [ADDS.id]: '10% likely affected' }, note: '1 call, 10 tokens' });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('+++ b/libs/shared/cart.ts\n');
    expect(state.diff).toContain('+export const total = 2;\n');
    expect(sent(requests[0])).toEqual({ [`packages/app/${CART}`]: "test('adds an item', async () => {});\n" });
    expect(requests[0]?.instructions).toEqual({ t0: asked(`packages/app/${CART}`, 'cart', 'adds an item') });
  });

  it('asks once about the setup that saves the sessions of tests, and keeps each test it or its setup is likely to affect', async () => {
    const SETUP = 'tests/auth.setup.e2e.ts';
    const repo = changedRepo(
      { 'src/login.ts': 'export const ok = 1;\n', [CART]: "test('adds an item', async () => {});\ntest('removes an item', async () => {});\n", [SEARCH]: "test('finds a product', async () => {});\n", [SETUP]: "setup('signs in', async () => {});\n" },
      { 'src/login.ts': 'export const ok = 2;\n' },
    );
    const setupAsked = `Can the diff break the e2e setup in ${SETUP}, or the session it saves for the tests that use it? testFiles["${SETUP}"] is its file.`;
    const tests = [withSetup(ADDS, SETUP), withSetup(REMOVES, SETUP), FINDS];
    const { model, requests } = scriptedJudge((text) => (text === setupAsked ? 0.6 : 0.1));
    expect(await decisionFilter({ model }).filter(tests, filterContext(repo).context)).toEqual({ exclude: { [FINDS.id]: '10% likely affected' }, note: '1 call, 10 tokens' });
    expect(Object.values(requests[0]?.instructions ?? {}).filter((text) => text === setupAsked)).toHaveLength(1);
    expect(Object.keys(sent(requests[0]))).toEqual([CART, SEARCH, SETUP]);

    const unlikely = scriptedJudge((text) => (text === setupAsked ? 0.1 : 0.05));
    expect(await decisionFilter({ model: unlikely.model }).filter(tests, filterContext(repo).context)).toMatchObject({
      exclude: { [ADDS.id]: '10% likely affected', [REMOVES.id]: '10% likely affected', [FINDS.id]: '5% likely affected' },
    });
  });

  it.each([
    ['is too large to send with the diff', 90_000, () => undefined, 'tests/auth.setup.e2e.ts is too large to send with the diff; 1 call, 10 tokens'],
    [
      'went to a call that failed',
      45_000,
      (request: DecideRequest) => {
        if ('tests/auth.setup.e2e.ts' in sent(request)) throw new Error('Refused: content policy');
      },
      'Refused: content policy; 1 call, 10 tokens',
    ],
  ])('keeps a test whose setup the model did not judge, as when the setup %s', async (_name, size, before, why) => {
    const SETUP = 'tests/auth.setup.e2e.ts';
    // A test file this large goes to a call of its own, so only the setup goes unanswered.
    const repo = changedRepo({ 'src/login.ts': 'export const ok = 1;\n', [CART]: sized('adds an item', 45_000), [SETUP]: sized('signs in', size) }, { 'src/login.ts': 'export const ok = 2;\n' });
    const { model } = scriptedJudge(() => 0, (_call, request) => before(request));
    const result = await decisionFilter({ model }).filter([withSetup(ADDS, SETUP)], filterContext(repo).context);
    expect(result).toEqual({ exclude: {}, note: `scripted-judge did not judge 1 test in 1 file: ${why}` });
  });

  it('sends the provider options it is given with every call', async () => {
    const providerOptions = { gateway: { zeroDataRetention: true } };
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model, providerOptions }).filter([ADDS], filterContext(cartRepo()).context);
    expect(requests[0]?.providerOptions).toEqual(providerOptions);
  });

  it('leaves out a test under 20% likely affected and keeps one at 20%', async () => {
    const { model } = scriptedJudge((instructions) => (instructions.includes('adds') ? 0.19 : 0.2));
    const result = await decisionFilter({ model }).filter([ADDS, REMOVES], filterContext(cartRepo()).context);
    expect(result).toEqual({ exclude: { [ADDS.id]: '19% likely affected' }, note: '1 call, 10 tokens' });
  });

  it("adds up what the calls spent: their tokens, and the AI Gateway's cost", async () => {
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [CART]: sized('adds an item', 45_000), [LOGIN]: sized('signs in', 45_000), [SEARCH]: sized('finds a product', 45_000) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model } = scriptedJudge(() => 0.9, undefined, { inputTokens: 12_400, providerMetadata: { gateway: { cost: '0.0021', marketCost: '0.0042' } } });
    const result = await decisionFilter({ model }).filter([ADDS, SIGNS_IN, FINDS], filterContext(repo).context);
    expect(result).toEqual({ exclude: {}, note: '3 calls, 37.2k tokens, $0.0063' });
  });

  it('counts the list price when the AI Gateway bills a route on your own provider key', async () => {
    const { model } = scriptedJudge(() => 0.9, undefined, { providerMetadata: { gateway: { cost: '0', marketCost: '0.25' } } });
    const result = await decisionFilter({ model }).filter([SIGNS_IN], filterContext(cartRepo()).context);
    expect(result).toEqual({ exclude: {}, note: '1 call, 10 tokens, $0.25' });
  });

  it('shows no cost when a call that answered reported none, rather than a partial sum', async () => {
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [CART]: sized('adds an item', 45_000), [LOGIN]: sized('signs in', 45_000) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(() => 0.9, undefined, { providerMetadata: (call) => (call === 0 ? { gateway: { cost: '0.5' } } : undefined) });
    const result = await decisionFilter({ model }).filter([ADDS, SIGNS_IN], filterContext(repo).context);
    expect(requests).toHaveLength(2);
    expect(result).toEqual({ exclude: {}, note: '2 calls, 20 tokens' });
  });

  it.each([
    ['a tracked change', { 'src/cart.ts': `${'x'.repeat(60_000)}\n` }],
    ['tracked changes to two files, each under it', { 'src/cart.ts': `${'x'.repeat(30_000)}\n`, [SEARCH]: `${'x'.repeat(30_000)}\n` }],
    ['a change of fewer characters that take more bytes', { 'src/cart.ts': `${'\u65E5'.repeat(20_001)}\n` }],
  ])('makes no call and leaves nothing out when %s puts the diff over 60 kB', async (_name, change) => {
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([ADDS, SIGNS_IN], filterContext(cartRepo(change)).context);
    expect(result).toEqual({ exclude: {}, note: 'the diff is over 60 kB, so the decision filter left nothing out' });
    expect(requests).toEqual([]);
  });

  it("leaves a failed call's tests in, and judges the rest", async () => {
    const files = Array.from({ length: 4 }, (_, i) => `tests/t${i}.e2e.ts`);
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', ...Object.fromEntries(files.map((file) => [file, sized('runs', 45_000)])) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(
      () => 0,
      (_call, request) => {
        if (Object.keys(sent(request))[0] === files[1]) throw new Error('Refused: content policy\nsee the docs');
      },
    );
    const tests = files.map((file) => candidate(file, 'runs'));
    const result = await decisionFilter({ model }).filter(tests, filterContext(repo).context);
    expect(result).toEqual({
      exclude: { [tests[0]!.id]: '0% likely affected', [tests[2]!.id]: '0% likely affected', [tests[3]!.id]: '0% likely affected' },
      note: 'scripted-judge did not judge 1 test in 1 file: Refused: content policy; 3 calls, 30 tokens',
    });
    expect(requests).toHaveLength(4);
  });

  it("makes no more calls once 3 have failed, stops the ones in flight, and throws the first failure's first line when none answered", async () => {
    const files = Array.from({ length: 12 }, (_, i) => `tests/t${i}.e2e.ts`);
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', ...Object.fromEntries(files.map((file) => [file, sized('runs', 45_000)])) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(
      () => 0,
      async (_call, request) => {
        const file = Object.keys(sent(request))[0] ?? '';
        if (files.slice(0, 3).includes(file)) throw new Error(`Unauthorized: no AI Gateway key for ${file}\nsee the docs`);
        await new Promise((_resolve, reject) => request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    );
    await expect(
      decisionFilter({ model }).filter(
        files.map((file) => candidate(file, 'runs')),
        filterContext(repo).context,
      ),
    ).rejects.toThrow(new Error('Unauthorized: no AI Gateway key for tests/t0.e2e.ts'));
    expect(requests).toHaveLength(8);
  });

  it('retries a call that fails with a retryable error up to 3 times', async () => {
    const busy = new APICallError({
      message: 'Too many requests',
      url: 'https://example.test/decide',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after-ms': '0' },
    });
    const { model, requests } = scriptedJudge(
      () => 0,
      () => {
        throw busy;
      },
    );
    await expect(decisionFilter({ model }).filter([ADDS, REMOVES, SIGNS_IN], filterContext(cartRepo()).context)).rejects.toThrow(
      'Failed after 4 attempts. Last error: AI_APICallError: Too many requests',
    );
    expect(requests).toHaveLength(4);
  });

  it('throws, making no call, when git cannot diff against the base', async () => {
    const { model, requests } = scriptedJudge(() => 0);
    const repo = { ...cartRepo(), base: '0'.repeat(40) };
    await expect(decisionFilter({ model }).filter([ADDS, SIGNS_IN], filterContext(repo).context)).rejects.toThrow(/^Command failed: git diff --name-only /);
    expect(requests).toEqual([]);
  });

  it('ends with the abort when the run stops waiting for it', async () => {
    const run = new AbortController();
    const reason = new DOMException('filter "decision" did not finish within 5 minutes', 'TimeoutError');
    const { model } = scriptedJudge(
      () => 0,
      () => {
        run.abort(reason);
        throw new Error('This operation was aborted');
      },
    );
    const { context } = filterContext(cartRepo());
    await expect(decisionFilter({ model }).filter([ADDS, SIGNS_IN], { ...context, signal: run.signal })).rejects.toBe(reason);
  });

  it('ends with the abort, making no call, when the run stopped waiting before git answered', async () => {
    const reason = new DOMException('filter "decision" did not finish within 5 minutes', 'TimeoutError');
    const { model, requests } = scriptedJudge(() => 0);
    const { context } = filterContext(cartRepo());
    await expect(decisionFilter({ model }).filter([ADDS, SIGNS_IN], { ...context, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(requests).toEqual([]);
  });

  it("accepts the AI Gateway's typesafe-ai/jev", () => {
    expect(decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') }).name).toBe('decision');
  });

  const EXAMPLE = "pass an AI SDK decision model, e.g. decisionFilter({ model: gateway.decisionModel('typesafe-ai/jev') })";
  it.each([
    ['no options', undefined, `decisionFilter() takes an options object; ${EXAMPLE}`],
    ['a model id', { model: 'typesafe-ai/jev' }, `decisionFilter({ model }) got the string "typesafe-ai/jev"; ${EXAMPLE}`],
    [
      'a decision model without boolean questions',
      { model: scriptedDecision(() => ({ choice: 'done' })).model },
      'decisionFilter({ model }) got scripted/scripted-1, which does not answer boolean questions',
    ],
    [
      'provider options that are not objects by provider',
      { model: scriptedJudge(() => 0).model, providerOptions: { gateway: true } },
      'decisionFilter({ providerOptions }) maps provider names to option objects, e.g. { gateway: { zeroDataRetention: true } }',
    ],
  ])('refuses %s at config load as INVALID_CONFIG naming decisionFilter', (_name, options, message) => {
    expect(() => decisionFilter(options as never)).toThrow(expect.objectContaining({ name: 'ConfigurationError', code: 'INVALID_CONFIG', message }));
  });
});
