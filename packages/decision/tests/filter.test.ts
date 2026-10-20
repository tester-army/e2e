import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APICallError, gateway } from 'ai';
import { describe, expect, it } from 'vitest';
import { decisionFilter } from '../src/index.ts';
import { candidate, changedRepo, commitAll, filterContext, PRIVATE_KEY, scriptedJudge, SECRET, withSetup, type DecideRequest } from './filter-helpers.ts';
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

  it('sends the redacted diff and the redacted test file under its redacted path', async () => {
    const file = `tests/${SECRET}.e2e.ts`;
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', [file]: "test('signs in', async () => {});\n" },
      { 'src/cart.ts': `export const key = '${SECRET}';\n`, [file]: `test('signs in with ${SECRET}', async () => {});\n` },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([candidate(file, `signs in with ${SECRET}`)], filterContext(repo).context);
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain("+export const key = '[redacted]';");
    expect(state.diff).toContain("+test('signs in with [redacted]', async () => {});");
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(sent(requests[0])).toEqual({ 'tests/[redacted].e2e.ts': readFileSync(path.join(repo.root, file), 'utf8').replaceAll(SECRET, '[redacted]') });
    expect(requests[0]?.instructions).toEqual({ t0: asked('tests/[redacted].e2e.ts', 'signs in with [redacted]') });
  });

  it('sends test files whose paths redact to the same key in separate calls', async () => {
    const [alpha, beta] = ['tests/alpha.e2e.ts', 'tests/beta.e2e.ts'];
    const repo = cartRepo({ [alpha]: "test('runs a', async () => {});\n", [beta]: "test('runs b', async () => {});\n" });
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

  it('redacts a secret spanning lines where the diff removes it, adds it, or rewrites it line by line', async () => {
    const hardCoded = `export const key = \`${PRIVATE_KEY}\`;\n`;
    const oldBody = ['MIIEowIBAAKCAQEAu1SU1LfVLPHCozMx', 'H2Mo4lgOEePzNm0tRgeLezV6ffAt0gun'];
    const oldKey = ['-----BEGIN PRIVATE KEY-----', ...oldBody, '-----END PRIVATE KEY-----'].join('\n');
    const repo = changedRepo(
      {
        [LOGIN]: "test('signs in', async () => {});\n",
        'src/client.ts': hardCoded,
        'src/server.ts': 'export const key = process.env.SERVER_KEY;\n',
        'src/rotated.ts': `export const key = \`${oldKey}\`;\n`,
      },
      { 'src/client.ts': 'export const key = process.env.CLIENT_KEY;\n', 'src/server.ts': hardCoded, 'src/rotated.ts': hardCoded },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([SIGNS_IN], filterContext(repo).context);
    const state = requests[0]?.state as { diff: string };
    for (const line of PRIVATE_KEY.split('\n').slice(1, -1)) expect(state.diff).not.toContain(line);
    expect(state.diff).toContain('-export const key = `[redacted]`;\n+export const key = process.env.CLIENT_KEY;\n');
    expect(state.diff).toContain('-export const key = process.env.SERVER_KEY;\n+export const key = `[redacted]`;\n');
    expect(state.diff).toContain(`-${oldBody.join('\n-')}\n------END PRIVATE KEY-----\`;\n+export const key = \`[redacted]\`;\n`);
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

  it('sends each untracked file git does not ignore as a new file, redacted', async () => {
    const repo = changedRepo(
      { '.gitignore': 'dist/\n', 'src/cart.ts': 'export const total = 1;\n', [CART]: "test('adds an item', async () => {});\n" },
      { 'src/coupon.ts': `export const code = '${SECRET}';\n`, 'dist/coupon.js': 'export const built = true;\n' },
    );
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], filterContext(repo).context);
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('+++ b/src/coupon.ts\n');
    expect(state.diff).toContain("+export const code = '[redacted]';\n");
    expect(state.diff).not.toContain('dist/coupon.js');
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

  it("diffs a pull request's commits up to its head, never what CI wrote in the checkout since", async () => {
    const repo = cartRepo();
    const head = commitAll(repo);
    writeFileSync(path.join(repo.root, 'src/cart.ts'), 'export const total = 3;\n');
    writeFileSync(path.join(repo.root, 'ci-output.json'), '{}\n');
    const { context } = filterContext(repo);
    const { model, requests } = scriptedJudge(() => 0.9);
    await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, head } });
    const state = requests[0]?.state as { diff: string };
    expect(state.diff).toContain('+export const total = 2;\n');
    expect(state.diff).not.toContain('total = 3');
    expect(state.diff).not.toContain('ci-output');
  });

  it('leaves nothing out, making no call, when git prints no diff of the files the change names', async () => {
    const { context } = filterContext(cartRepo());
    const { model, requests } = scriptedJudge(() => 0);
    const result = await decisionFilter({ model }).filter([ADDS], { ...context, changes: { ...context.changes, files: ['src/unchanged.ts'] } });
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

  it('sends a renamed file as a rename and a deleted file without its lines', async () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    const repo = changedRepo({ 'src/old.ts': `${body}\n`, 'src/gone.ts': 'export const gone = true;\n', [LOGIN]: "test('signs in', async () => {});\n" }, {});
    execFileSync('git', ['mv', 'src/old.ts', 'src/new.ts'], { cwd: repo.root });
    execFileSync('git', ['rm', '--quiet', 'src/gone.ts'], { cwd: repo.root });
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

  it.each([
    ['a tracked change', { 'src/cart.ts': `${'x'.repeat(60_000)}\n` }],
    ['an untracked file', { 'src/generated.ts': `${'x'.repeat(60_000)}\n` }],
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

  it('makes no more calls once 3 have failed, and stops the ones in flight', async () => {
    const files = Array.from({ length: 12 }, (_, i) => `tests/t${i}.e2e.ts`);
    const repo = changedRepo(
      { 'src/cart.ts': 'export const total = 1;\n', ...Object.fromEntries(files.map((file) => [file, sized('runs', 45_000)])) },
      { 'src/cart.ts': 'export const total = 2;\n' },
    );
    const { model, requests } = scriptedJudge(
      () => 0,
      async (_call, request) => {
        if (files.slice(0, 3).includes(Object.keys(sent(request))[0] ?? '')) throw new Error('Unauthorized: no AI Gateway key');
        await new Promise((_resolve, reject) => request.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    );
    const result = await decisionFilter({ model }).filter(
      files.map((file) => candidate(file, 'runs')),
      filterContext(repo).context,
    );
    expect(result).toEqual({ exclude: {}, note: 'scripted-judge did not judge 12 tests in 12 files: Unauthorized: no AI Gateway key' });
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
    const result = await decisionFilter({ model }).filter([ADDS, REMOVES, SIGNS_IN], filterContext(cartRepo()).context);
    expect(result).toEqual({
      exclude: {},
      note: 'scripted-judge did not judge 3 tests in 2 files: Failed after 4 attempts. Last error: AI_APICallError: Too many requests',
    });
    expect(requests).toHaveLength(4);
  });

  it('leaves nothing out when git cannot diff against the base', async () => {
    const { model, requests } = scriptedJudge(() => 0);
    const repo = { ...cartRepo(), base: '0'.repeat(40) };
    const result = await decisionFilter({ model }).filter([ADDS, SIGNS_IN], filterContext(repo).context);
    expect(result).toEqual({ exclude: {}, note: expect.stringMatching(/^scripted-judge did not judge 2 tests in 2 files: Command failed: git --literal-pathspecs diff /) });
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
