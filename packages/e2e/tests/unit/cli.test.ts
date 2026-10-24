import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListOptions, ListedPair } from '../../src/runner.ts';
import type { RunOptions } from '../../src/run/runner.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';

const runMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());
const watchMock = vi.hoisted(() => vi.fn());
const upgradeMock = vi.hoisted(() => vi.fn());

// The suite runs from the repository; these tests cover an installed CLI, where telemetry is on.
vi.mock('../../src/telemetry/checkout.ts', () => ({ runsFromCheckout: () => false }));
vi.mock('../../src/run/runner.ts', () => ({ run: runMock, listSelection: listMock }));
vi.mock('../../src/cli/watch.ts', () => ({ watchSession: watchMock }));
// `e2e list --reporter json` writes its document past the claimed output; here it lands on the stdout spy.
vi.mock('../../src/run/process-output.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/run/process-output.ts')>()),
  writeTerminal: (stream: 'stdout' | 'stderr', text: string) => process[stream].write(text),
}));
vi.mock('../../src/cli/init.ts', () => ({
  init: initMock,
}));
vi.mock('../../src/cli/upgrade.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/upgrade.ts')>()),
  upgrade: upgradeMock,
}));

const { main } = await import('../../src/cli/index.ts');
const { olderThan } = await import('../../src/internal/release.ts');

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** What a mocked `init` hands back: the exit code and the choices, none made. */
function initOutcome(exitCode: number, overrides: Record<string, unknown> = {}) {
  return {
    exitCode,
    result: exitCode === 0 ? 'scaffolded' : 'invalid-project',
    yes: false,
    example: null,
    existingConfig: false,
    engine: null,
    gateway: null,
    skill: false,
    mcp: false,
    install: false,
    ...overrides,
  };
}

/** What a mocked `upgrade` hands back: the exit code, and nothing learned. */
function upgradeOutcome(exitCode: number) {
  return { exitCode, result: exitCode === 0 ? 'upgraded' : 'install-failed', target: { kind: 'tag', tag: 'latest' }, fromVersion: null, toVersion: null, manager: null, siblings: [], moved: 0, linked: 0 };
}

function lastRunOptions(): RunOptions {
  expect(runMock).toHaveBeenCalledTimes(1);
  return runMock.mock.calls[0]?.[0] as RunOptions;
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args]);
}

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Everything written to a stream so far, with any color stripped. */
function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0, report: sampleReport() });
  listMock.mockReset();
  listMock.mockResolvedValue({ pairs: [] });
  initMock.mockReset();
  initMock.mockResolvedValue(initOutcome(0));
  watchMock.mockReset();
  watchMock.mockResolvedValue(0);
  upgradeMock.mockReset();
  upgradeMock.mockResolvedValue(upgradeOutcome(0));
  process.exitCode = undefined;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  process.exitCode = undefined;
});

describe('e2e run argument parsing', () => {
  it('passes defaults through with no flags', async () => {
    await invoke('run');
    const options = lastRunOptions();
    expect(options.files).toEqual([]);
    expect(options.tagMode).toBe('any');
    expect(options.configPath).toBeUndefined();
    expect(options.reporters).toBeUndefined();
    expect(options.agent).toBeUndefined();
    expect(options.changedSince).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('collects positional files', async () => {
    await invoke('run', 'tests/a.e2e.ts', 'tests/b.e2e.ts');
    expect(lastRunOptions().files).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
  });

  it('rejects a flag that arrived as a file argument with exit code 2 and never runs', async () => {
    await invoke('run', '--', '--headed');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toMatch(
      /^error: "--headed" is a flag, not a test file\. It arrived as a file because a "--" came before it; "(?:pnpm|npm run|yarn|bun run) test:e2e -- --headed" reaches e2e as "run -- --headed" when the package manager forwards the separator\. Run the CLI directly instead: (?:pnpm exec|npm exec --|yarn|bun run) e2e run --headed\n\(add --help for usage\)\n$/u,
    );
  });

  it('keeps the whole forwarded tail in the hint, option values and files included', async () => {
    await invoke('run', '--', 'tests/a.e2e.ts', '--tag', 'smoke', 'tests/b.e2e.ts');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toMatch(
      /Run the CLI directly instead: (?:pnpm exec|npm exec --|yarn|bun run) e2e run --tag smoke tests\/b\.e2e\.ts\n/u,
    );
  });

  it('passes a dash-prefixed name through when it names an existing file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-dash-'));
    writeFileSync(path.join(dir, '-smoke.e2e.ts'), '');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await invoke('run', '--', '-smoke.e2e.ts');
      expect(lastRunOptions().files).toEqual(['-smoke.e2e.ts']);
      expect(process.exitCode).toBe(0);
    } finally {
      cwdSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collects repeated and comma-separated --agent names in order', async () => {
    await invoke('run', '--agent', 'buyer, admin', '--agent', 'guest');
    expect(lastRunOptions().agent).toEqual(['buyer', 'admin', 'guest']);
  });

  it('splits comma-separated targets, trims whitespace, and accumulates repeats once each', async () => {
    await invoke('run', '--target', 'chromium, firefox , ,webkit', '--target', 'chromium,edge');
    expect(lastRunOptions().targetIds).toEqual(['chromium', 'firefox', 'webkit', 'edge']);
  });

  it('accumulates repeated --tag flags and splits comma-separated tags', async () => {
    await invoke('run', '--tag', 'smoke', '--tag', 'auth, billing');
    expect(lastRunOptions().tags).toEqual(['smoke', 'auth', 'billing']);
  });

  it('rejects an empty --tag, --target, or --agent value with exit code 2 and never runs', async () => {
    const cases = [
      ['--tag <tags>', ''],
      ['--tag <tags>', ' , '],
      ['--target <ids>', ''],
      ['--agent <names>', ' '],
    ] as const;
    for (const [option, value] of cases) {
      const flag = option.split(' ')[0]!;
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', flag, value);
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain(`must name at least one ${flag.slice(2)}`);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('accumulates --exclude-tag like --tag', async () => {
    await invoke('run', '--tag', 'smoke', '--exclude-tag', 'slow, flaky', '--exclude-tag', 'slow');
    const options = lastRunOptions();
    expect(options.tags).toEqual(['smoke']);
    expect(options.excludeTags).toEqual(['slow', 'flaky']);
  });

  it('compiles --grep and --grep-invert to regular expressions, bare or /pattern/flags, one per repeat', async () => {
    await invoke('run', '--grep', 'checkout', '--grep', '/sign.?in/i', '--grep-invert', 'refund');
    const options = lastRunOptions();
    expect(options.grep).toEqual([/checkout/, /sign.?in/i]);
    expect(options.grepInvert).toEqual([/refund/]);
  });

  it('rejects a --grep that does not compile with exit code 2 and never runs', async () => {
    await invoke('run', '--grep', '(checkout');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('must be a regular expression: Invalid regular expression');
    stderrSpy.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--grep-invert', '//');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('must be a regular expression');
  });

  it('parses --max-failures as a positive integer and rejects anything else with exit code 2', async () => {
    await invoke('run', '--max-failures', '3');
    expect(lastRunOptions().maxFailures).toBe(3);
    runMock.mockClear();
    for (const value of ['0', '-1', '2.5', 'many']) {
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--max-failures', value);
      expect(process.exitCode, value).toBe(2);
      expect(written(stderrSpy)).toContain('must be a positive integer');
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('parses --max-duration as milliseconds a timer can wait and rejects anything else as a flag error', async () => {
    await invoke('run', '--max-duration', '900000');
    expect(lastRunOptions().maxDuration).toBe(900_000);
    runMock.mockClear();
    await invoke('run', '--max-duration', '2147483647');
    expect(lastRunOptions().maxDuration).toBe(2_147_483_647);
    runMock.mockClear();
    for (const value of ['0', '-1', '2.5', '15m', '2147483648']) {
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--max-duration', value);
      expect(process.exitCode, value).toBe(2);
      expect(written(stderrSpy)).toContain(`option '--max-duration <ms>' argument '${value}' is invalid. must be an integer from 1 through 2147483647`);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('parses --action-timeout and --assertion-timeout as milliseconds a timer can wait and rejects anything else with exit code 2', async () => {
    await invoke('run', '--action-timeout', '5000', '--assertion-timeout', '2147483647');
    expect(lastRunOptions()).toMatchObject({ actionTimeout: 5_000, assertionTimeout: 2_147_483_647 });
    runMock.mockClear();
    await invoke('run');
    expect(lastRunOptions()).toMatchObject({ actionTimeout: undefined, assertionTimeout: undefined });
    runMock.mockClear();
    for (const flag of ['--action-timeout', '--assertion-timeout']) {
      for (const value of ['0', '-1', '2.5', '5s', '2147483648']) {
        stderrSpy.mockClear();
        process.exitCode = undefined;
        await invoke('run', flag, value);
        expect(process.exitCode, `${flag} ${value}`).toBe(2);
        expect(written(stderrSpy)).toContain(`option '${flag} <ms>' argument '${value}' is invalid. must be an integer from 1 through 2147483647`);
      }
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('parses --repeat-each as a positive integer', async () => {
    await invoke('run', '--repeat-each', '3');
    expect(lastRunOptions().repeatEach).toBe(3);
    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--repeat-each', '0');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('parses --shard as index/total and --last-failed as a flag', async () => {
    await invoke('run', '--shard', '2/3', '--last-failed');
    const options = lastRunOptions();
    expect(options.shard).toEqual({ index: 2, total: 3 });
    expect(options.lastFailed).toBe(true);
  });

  it('maps --changed-since to changedSince, which needs a ref', async () => {
    await invoke('run', 'tests/a.e2e.ts', '--changed-since', 'origin/main');
    expect(lastRunOptions()).toMatchObject({ files: ['tests/a.e2e.ts'], changedSince: 'origin/main' });
    runMock.mockClear();
    await invoke('run', '--changed-since');
    expect(process.exitCode).toBe(2);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('rejects a --shard that is not index/total within range with exit code 2 and never runs', async () => {
    for (const value of ['0/3', '4/3', '2', 'a/b', '1/0', '-1/2', '1.5/2']) {
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--shard', value);
      expect(process.exitCode, value).toBe(2);
      expect(written(stderrSpy)).toContain('must be index/total');
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('--watch hands the parsed options to the session and takes its exit code', async () => {
    const ci = process.env.CI;
    delete process.env.CI;
    try {
      watchMock.mockResolvedValue(1);
      await invoke('run', '-w', 'tests/a.e2e.ts', '--tag', 'smoke', '--action-timeout', '3000');
      expect(runMock).not.toHaveBeenCalled();
      expect(watchMock).toHaveBeenCalledTimes(1);
      const options = watchMock.mock.calls[0]?.[0] as { base: RunOptions; stdin: unknown; clear: boolean };
      expect(options.base).toMatchObject({ files: ['tests/a.e2e.ts'], tags: ['smoke'], actionTimeout: 3_000 });
      expect(options.stdin).toBe(process.stdin.isTTY === true ? process.stdin : undefined);
      expect(options.clear).toBe(process.stdout.isTTY === true);
      expect(process.exitCode).toBe(1);
    } finally {
      if (ci !== undefined) process.env.CI = ci;
    }
  });

  it('refuses --watch in CI and with the json reporter, exit code 2, without running', async () => {
    const ci = process.env.CI;
    process.env.CI = '1';
    try {
      await invoke('run', '--watch');
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain('--watch is for a terminal');
    } finally {
      if (ci === undefined) delete process.env.CI;
      else process.env.CI = ci;
    }
    delete process.env.CI;
    process.exitCode = undefined;
    try {
      await invoke('run', '--watch', '--reporter', 'list,json');
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain('cannot be combined with --reporter json');
    } finally {
      if (ci !== undefined) process.env.CI = ci;
    }
    expect(runMock).not.toHaveBeenCalled();
    expect(watchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid --tag-mode with exit code 2 and never runs', async () => {
    await invoke('run', '--tag-mode', 'sometimes');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('Allowed choices are any, all');
  });

  it('parses reporters and rejects unknown reporters with exit code 2', async () => {
    await invoke('run', '--reporter', 'list,json,junit');
    expect(lastRunOptions().reporters).toEqual(['list', 'json', 'junit']);

    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--reporter', 'list,teamcity');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('unknown reporter "teamcity"');
  });

  it('exits 2 on an unknown option or command without running, pointing at --help', async () => {
    await invoke('run', '--nope');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe("error: unknown option '--nope'\n(add --help for usage)\n");

    process.exitCode = undefined;
    stderrSpy.mockClear();
    await invoke('frobnicate');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe("error: unknown command 'frobnicate'\n(add --help for usage)\n");
  });

  it('parses numeric --retries and --workers', async () => {
    await invoke('run', '--retries', '2', '--workers', '4');
    const options = lastRunOptions();
    expect(options.retries).toBe(2);
    expect(options.workers).toBe(4);
  });

  it('rejects negative and non-integer numeric flags with exit code 2', async () => {
    for (const value of ['-1', '1.5', 'abc']) {
      runMock.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--retries', value);
      expect(runMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
  });

  it('passes boolean and path flags through', async () => {
    await invoke(
      'run',
      '--headed',
      '--debug',
      '--ai-trace',
      '--pass-with-no-tests',
      '--config',
      'custom.config.ts',
      '--output',
      'out',
      '--cache-dir',
      'shared/cache',
      '--tag-mode',
      'all',
    );
    const options = lastRunOptions();
    expect(options.tagMode).toBe('all');
    expect(options.headed).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.aiTrace).toBe(true);
    expect(options.passWithNoTests).toBe(true);
    expect(options.configPath).toBe('custom.config.ts');
    expect(options.output).toBe('out');
    expect(options.cacheDir).toBe('shared/cache');
  });

  it('parses --trace and --video modes, a bare flag as on', async () => {
    await invoke('run', '--trace=on-all-retries', '--video');
    expect(lastRunOptions()).toMatchObject({ trace: 'on-all-retries', video: 'on' });
    runMock.mockClear();
    await invoke('run', '--trace', '--video=retain-on-failure');
    expect(lastRunOptions()).toMatchObject({ trace: 'on', video: 'retain-on-failure' });
    runMock.mockClear();
    await invoke('run', 'tests/a.e2e.ts');
    expect(lastRunOptions()).toMatchObject({ trace: undefined, video: undefined });
  });

  it('refuses a --trace value that is not a mode, with the way to write one', async () => {
    await invoke('run', '--trace', 'tests/a.e2e.ts');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('write --trace=<mode>, or put test files before --trace');
  });

  it('refuses the removed --artifacts, mapping it to --output of its parent', async () => {
    for (const command of ['run', 'explore']) {
      runMock.mockClear();
      process.exitCode = undefined;
      stderrSpy.mockClear();
      await invoke(command, '--artifacts', 'out/artifacts');
      expect(runMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain('--artifacts was removed: write --output out instead');
      expect(written(stderrSpy)).toContain('must be a directory inside the project, not its root');
    }
  });

  it('propagates the run outcome exit code', async () => {
    runMock.mockResolvedValue({ exitCode: 3, report: sampleReport() });
    await invoke('run');
    expect(process.exitCode).toBe(3);
  });

});

describe('e2e list', () => {
  const listed = (
    pair: Pick<ListedPair, 'file' | 'title' | 'titlePath' | 'tags' | 'target' | 'disposition'> & Partial<ListedPair>,
  ): ListedPair => ({
    id: pair.title,
    kind: 'test',
    source: undefined,
    session: undefined,
    sessions: [],
    serialId: undefined,
    agent: 'default',
    ...pair,
  });
  const pairs: ListedPair[] = [
    listed({ file: 'tests/a.e2e.ts', title: 'signs in', titlePath: ['signs in'], tags: ['smoke', 'auth'], target: 'web', disposition: 'run' }),
    listed({ file: 'tests/a.e2e.ts', title: 'pays', titlePath: ['billing', 'pays'], tags: ['billing'], target: 'web', disposition: 'skip', reason: 'not today' }),
    listed({ file: 'tests/b.e2e.ts', title: 'browses', titlePath: ['browses'], tags: [], target: 'webkit', disposition: 'run' }),
    listed({
      file: 'tests/b.e2e.ts',
      title: 'filtered out',
      titlePath: ['filtered out'],
      tags: [],
      target: 'webkit',
      disposition: 'filtered',
      reason: 'title does not match --grep',
    }),
  ];

  function lastListOptions(): ListOptions {
    expect(listMock).toHaveBeenCalledTimes(1);
    return listMock.mock.calls[0]?.[0] as ListOptions;
  }

  it('prints one line per pair and exits 0 without running', async () => {
    listMock.mockResolvedValue({ pairs });
    await invoke('list');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toBe(
      [
        'tests/a.e2e.ts › signs in [web] #smoke #auth',
        'tests/a.e2e.ts › billing › pays [web] #billing (skipped: not today)',
        'tests/b.e2e.ts › browses [webkit]',
        '',
      ].join('\n'),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('rejects a flag that arrived as a file argument with exit code 2 and never lists', async () => {
    await invoke('list', '--', '--tag', 'smoke');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const stderr = written(stderrSpy);
    expect(stderr.startsWith('error: "--tag" is a flag, not a test file.')).toBe(true);
    expect(stderr).toMatch(/Run the CLI directly instead: (?:pnpm exec|npm exec --|yarn|bun run) e2e list --tag smoke\n/u);
    expect(stderr.endsWith('(add --help for usage)\n')).toBe(true);
  });

  it('prints { pairs } with --reporter json', async () => {
    listMock.mockResolvedValue({ pairs });
    await invoke('list', '--reporter', 'json');
    expect(process.exitCode).toBe(0);
    const printed = { pairs: pairs.filter((pair) => pair.disposition !== 'filtered') };
    expect(JSON.parse(written(stdoutSpy))).toEqual(JSON.parse(JSON.stringify(printed)));
    expect(written(stdoutSpy)).not.toContain('skipReason');
  });

  it('passes the selection flags through and rejects the junit reporter', async () => {
    await invoke(
      'list',
      'tests/a.e2e.ts',
      '--config',
      'custom.config.ts',
      '--target',
      'web, webkit',
      '--tag',
      'smoke',
      '--tag',
      'auth',
      '--tag-mode',
      'all',
      '--changed-since',
      'origin/main',
      '--pass-with-no-tests',
    );
    expect(lastListOptions()).toEqual({
      files: ['tests/a.e2e.ts'],
      config: 'custom.config.ts',
      targets: ['web', 'webkit'],
      tags: ['smoke', 'auth'],
      tagMode: 'all',
      changedSince: 'origin/main',
      passWithNoTests: true,
    });
    expect(written(stdoutSpy)).toBe('');

    listMock.mockClear();
    process.exitCode = undefined;
    await invoke('list', '--reporter', 'junit');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain("option '--reporter <id>' argument 'junit' is invalid");
  });

  it('splits comma-separated --tag and --target values and rejects an empty one, like run', async () => {
    await invoke('list', '--tag', 'smoke,auth', '--tag', 'smoke', '--target', 'web,webkit');
    expect(lastListOptions()).toMatchObject({ tags: ['smoke', 'auth'], targets: ['web', 'webkit'] });
    listMock.mockClear();
    process.exitCode = undefined;
    await invoke('list', '--tag', '');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain("option '--tag <tags>' argument '' is invalid. must name at least one tag");
  });

  it('prints a pair a test filter left out with the filter and its reason, as json { pairs } and as a line, and the filter lines on stderr, bounded', async () => {
    const left = listed({ file: 'tests/a.e2e.ts', title: 'refunds', titlePath: ['refunds'], tags: [], target: 'web', disposition: 'filtered', reason: 'the diff misses billing', filter: 'areas' });
    listMock.mockImplementation(async (_options: ListOptions, notice: (message: string) => void) => {
      notice('areas: reading the diff\u001b[2J');
      notice('areas kept 1 of 2 tests, left out 1 (src/auth changed)');
      return { pairs: [pairs[0]!, left, pairs[3]!] };
    });
    await invoke('list', '--reporter', 'json');
    expect(process.exitCode).toBe(0);
    const json = JSON.parse(written(stdoutSpy)) as { pairs: ListedPair[] };
    // A pair a selection flag removed stays out, as it always has; the one a filter left out is listed.
    expect(json.pairs).toEqual(JSON.parse(JSON.stringify([pairs[0], left])));
    const raw = stderrSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join('');
    expect(raw).not.toContain('\u001b');
    expect(written(stderrSpy)).toBe(['areas: reading the diff', 'areas kept 1 of 2 tests, left out 1 (src/auth changed)', ''].join('\n'));

    stdoutSpy.mockClear();
    await invoke('list');
    expect(written(stdoutSpy)).toBe('tests/a.e2e.ts › signs in [web] #smoke #auth\ntests/a.e2e.ts › refunds [web] (left out by areas: the diff misses billing)\n');
  });

  it('prints a collection failure as code and message with its exit code', async () => {
    listMock.mockRejectedValue(new ConfigurationError('NO_TESTS', 'no tests matched'));
    await invoke('list');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('NO_TESTS: no tests matched\n');
    expect(process.exitCode).toBe(2);
  });
});

describe('e2e init argument parsing', () => {
  it('scaffolds the working directory by default and reports the terminal state', async () => {
    await invoke('init', '--yes');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(process.cwd(), {
      yes: true,
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    });
    expect(process.exitCode).toBe(0);
  });

  it('resolves a directory argument against the working directory and passes it along as typed', async () => {
    initMock.mockResolvedValue(initOutcome(2));
    await invoke('init', 'apps/web');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(
      path.resolve(process.cwd(), 'apps/web'),
      expect.objectContaining({ directory: 'apps/web' }),
    );
    expect(process.exitCode).toBe(2);
  });

  it('passes every wizard answer given as a flag', async () => {
    await invoke(
      'init', '--yes', '--engine', 'mobile', '--gateway', 'openai-compatible', '--endpoint', ' http://127.0.0.1:11434/v1 ',
      '--skills', '.agents/skills/,.claude/skills,.agents/skills', '--mcp', '.mcp.json', '--install',
    );
    expect(initMock).toHaveBeenCalledExactlyOnceWith(process.cwd(), {
      yes: true,
      engine: 'mobile',
      gateway: 'openai-compatible',
      endpoint: ' http://127.0.0.1:11434/v1 ',
      skills: ['.agents/skills', '.claude/skills'],
      mcp: ['.mcp.json'],
      install: true,
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    });
  });

  it('merges repeated --skills and --mcp flags like comma-separated ones', async () => {
    await invoke('init', '--yes', '--skills', '.agents/skills', '--skills', '.claude/skills', '--mcp', '.cursor/mcp.json', '--mcp', '.mcp.json');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(
      process.cwd(),
      expect.objectContaining({ skills: ['.agents/skills', '.claude/skills'], mcp: ['.cursor/mcp.json', '.mcp.json'] }),
    );
  });

  it('reads --endpoint alone as --gateway openai-compatible', async () => {
    await invoke('init', '--endpoint', 'https://llm.example/v1');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(
      process.cwd(),
      expect.objectContaining({ gateway: 'openai-compatible', endpoint: 'https://llm.example/v1' }),
    );
  });

  it('reads none as no location, and --no-install as declining the install', async () => {
    await invoke('init', '--gateway', 'none', '--skills', 'none', '--mcp', 'none', '--no-install');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(process.cwd(), expect.objectContaining({ gateway: 'none', skills: [], mcp: [], install: false }));
  });

  it.each([
    [['--engine', 'playwright'], "option '--engine <id>' argument 'playwright' is invalid. Allowed choices are web, mobile, none."],
    [['--gateway', 'anthropic'], 'Allowed choices are vercel, openrouter, openai-compatible, chatgpt, copilot, opencode-console, grok, none.'],
    [['--skills', '.cursor/skills'], 'error: --skills: unknown skill directory ".cursor/skills"; expected .agents/skills, .claude/skills, none'],
    [['--skills', ''], 'must name at least one skill directory'],
    [['--mcp', 'claude'], 'error: --mcp: unknown MCP config file "claude"; expected .mcp.json, .cursor/mcp.json, none'],
    [['--mcp', 'none,.mcp.json'], 'error: --mcp: none cannot be combined with other values'],
    [['--mcp', 'none', '--mcp', '.mcp.json'], 'error: --mcp: none cannot be combined with other values'],
    [['--skills', '.claude/skills', '--skills', 'none'], 'error: --skills: none cannot be combined with other values'],
    [['--gateway', 'openai-compatible', '--endpoint', 'http://llm.example/v1'], 'Must use HTTPS unless the host is loopback'],
    [['--gateway', 'openrouter', '--endpoint', 'https://llm.example/v1'], 'error: --endpoint is the base URL for --gateway openai-compatible, not --gateway openrouter'],
  ])('rejects %j before init runs, naming the valid values', async (flags, message) => {
    await invoke('init', '--yes', ...flags);
    expect(initMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toContain(message);
    expect(process.exitCode).toBe(2);
  });
});

describe('e2e --version and --help', () => {
  it('prints the package version alone and exits 0', async () => {
    for (const flag of ['--version', '-v']) {
      process.exitCode = undefined;
      stdoutSpy.mockClear();
      await invoke(flag);
      expect(written(stdoutSpy)).toBe(`${packageVersion}\n`);
      expect(process.exitCode).toBe(0);
    }
    expect(runMock).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('opens the help with the version, lists every command with examples, and exits 0', async () => {
    await invoke('--help');
    const help = written(stdoutSpy);
    expect(help.startsWith(`e2e v${packageVersion} · an open framework for agentic end-to-end testing\n`)).toBe(true);
    expect(help).toContain('Usage: e2e <command> [options]');
    expect(help).toMatch(/^ {2}init \[options\] \[directory\] {2,}scaffold/mu);
    expect(help).toMatch(/^ {2}run \[options\] \[files\.\.\.\] {2,}run the tests$/mu);
    expect(help).toMatch(/^ {2}cache {2,}inspect, measure, and clear the replay cache$/mu);
    expect(help).toMatch(/^ {2}mcp \[options\] {2,}serve the project to a coding agent over MCP$/mu);
    expect(help).toMatch(/^ {2}help \[command\] {2,}show help for a command$/mu);
    expect(help).toMatch(/^ {2}-v, --version {2,}print the version$/mu);
    expect(help).toMatch(/^ {2}-h, --help {2,}show help$/mu);
    expect(help).toContain('Examples:\n  $ e2e init\n  $ e2e run\n');
    expect(help).toContain('Run e2e <command> --help for the flags of one command.');
    expect(help).toContain('Docs: https://e2e.tester.army/docs\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('groups the run flags, then lists examples and the exit codes', async () => {
    await invoke('run', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e run [options] [files...]');
    // Every flag the action reads is documented, under its group, in this order.
    const headings = [...help.matchAll(/^(\S[^\n]*):$/gmu)].map((match) => match[1]);
    expect(headings).toEqual(['Arguments', 'Selection', 'Execution', 'Output', 'Options', 'Examples', 'Exit codes']);
    const flags = [...help.matchAll(/^ {2}(-{1,2}[a-z-]+)/gmu)].map((match) => match[1]);
    expect(flags).toEqual([
      '--config',
      '--target',
      '--tag',
      '--tag-mode',
      '--exclude-tag',
      '--grep',
      '--grep-invert',
      '--changed-since',
      '--last-failed',
      '--shard',
      '--pass-with-no-tests',
      '--headed',
      '--agent',
      '--workers',
      '--retries',
      '--action-timeout',
      '--assertion-timeout',
      '--max-failures',
      '--max-duration',
      '--repeat-each',
      '--no-cache',
      '--strict-cache',
      '-u',
      '-w',
      '--reporter',
      '--output',
      '--cache-dir',
      '--debug',
      '--ai-trace',
      '--trace',
      '--video',
      '-h',
    ]);
    // Commander wraps at the help width, so the choices may span two lines.
    expect(help).toMatch(/\(choices: "any", "all",\s+default: "any"\)/u);
    expect(help).toContain("  $ e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke\n");
    expect(help).toMatch(/^Exit codes:\n {2}0 {4}every selected test passed/mu);
    expect(help).toMatch(/^ {2}130 {2}interrupted/mu);
    expect(help).toContain('Docs: https://e2e.tester.army/docs/reference/cli#exit-codes\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('answers -h and help <command> with the same text as --help', async () => {
    await invoke('run', '--help');
    const expected = written(stdoutSpy);
    for (const args of [['run', '-h'], ['help', 'run']]) {
      process.exitCode = undefined;
      stdoutSpy.mockClear();
      await invoke(...args);
      expect(written(stdoutSpy)).toBe(expected);
      expect(process.exitCode).toBe(0);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('prints the help on stderr and exits 2 when no command is given', async () => {
    await invoke();
    expect(stdoutSpy).not.toHaveBeenCalled();
    const help = written(stderrSpy);
    expect(help).toContain('Usage: e2e <command> [options]');
    expect(help).toContain('Examples:');
    expect(process.exitCode).toBe(2);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('e2e feedback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let configHome: string;

  interface SentEvent {
    event: string;
    uuid: string;
    properties: Record<string, unknown>;
  }

  /** Every feedback event a request carried; the telemetry flush posts its own batch beside them. */
  function sentFeedback(): SentEvent[] {
    return fetchMock.mock.calls
      .filter((call: readonly unknown[]) => String(call[0]).startsWith('https://eu.i.posthog.com/'))
      .flatMap((call: readonly unknown[]) => (JSON.parse((call[1] as { body: string }).body) as { batch: SentEvent[] }).batch)
      .filter((event) => event.event === 'e2e_feedback');
  }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-feedback-'));
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('E2E_TELEMETRY_DISABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('E2E_TELEMETRY_DEBUG', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('APPDATA', configHome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(configHome, { recursive: true, force: true });
  });

  /** Answers the npm registry's `latest` request with `version`, and every other request with 200. */
  function latestIs(version: string): void {
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === 'https://registry.npmjs.org/e2e/latest' ? Response.json({ version }) : new Response('{}', { status: 200 }),
    );
  }

  it('sends one event with the report, the machine facts, and the telemetry id', async () => {
    latestIs(packageVersion);
    await invoke(
      'feedback',
      '--type', 'bug',
      '-m', ' list ignores --grep ',
      '--command', 'e2e list --grep x',
      '--repro', 'e2e list --grep x lists every test',
      '--error-code', 'LOCATOR_AMBIGUOUS',
    );
    expect(process.exitCode).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://registry.npmjs.org/e2e/latest');
    const [event] = sentFeedback();
    expect(event?.properties).toMatchObject({
      type: 'bug',
      message: 'list ignores --grep',
      command: 'e2e list --grep x',
      repro: 'e2e list --grep x lists every test',
      error_code: 'LOCATOR_AMBIGUOUS',
      task: null,
      e2e_version: packageVersion,
      $process_person_profile: false,
      $geoip_disable: true,
    });
    const { anonymousId } = JSON.parse(readFileSync(path.join(configHome, 'e2e', 'telemetry.json'), 'utf8')) as { anonymousId: string };
    expect(event?.properties['distinct_id']).toBe(anonymousId);
    expect(written(stdoutSpy)).toBe(`Feedback sent to the e2e team, thank you. Reference: ${event?.uuid}\n`);
  });

  it('still sends after e2e telemetry disable, under an id of its own', async () => {
    await invoke('telemetry', 'disable');
    stdoutSpy.mockClear();
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(0);
    const [event] = sentFeedback();
    expect(event?.properties['distinct_id']).toBe(`feedback:${event?.uuid}`);
  });

  it.each(['E2E_TELEMETRY_DISABLED', 'DO_NOT_TRACK'])('sends nothing and exits 2 when %s is set', async (variable) => {
    vi.stubEnv(variable, '1');
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toContain(`feedback not sent: ${variable} is set`);
  });

  it('redacts secret-named variables and token shapes, and leaves prose alone', async () => {
    vi.stubEnv('MY_SERVICE_TOKEN', 'hunter2-hunter2');
    vi.stubEnv('TEST_USER_PASS', 'hunter22');
    await invoke(
      'feedback',
      '-m', 'login with hunter22 failed with hunter2-hunter2',
      '--actual', 'Authorization: Bearer abc123defghijklmnop sk-ant-api03-abcdefghijklmnopqrst https://user:pw@example.com/x',
      '--task', 'following the Basic authentication example',
    );
    const [event] = sentFeedback();
    expect(event?.properties['message']).toBe('login with <secret:TEST_USER_PASS> failed with <secret:MY_SERVICE_TOKEN>');
    expect(event?.properties['actual']).toBe('Authorization: Bearer <redacted> <redacted> https://<redacted>@example.com/x');
    expect(event?.properties['task']).toBe('following the Basic authentication example');
  });

  it('prints the event and sends nothing with --dry-run, even where sending is off', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    await invoke('feedback', '--type', 'docs', '-m', 'unclear', '--dry-run');
    expect(process.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = JSON.parse(written(stdoutSpy)) as SentEvent;
    expect(printed.event).toBe('e2e_feedback');
    expect(printed.properties).toMatchObject({ type: 'docs', message: 'unclear' });
  });

  it('exits 3 and names the unconfirmed report when PostHog does not accept it', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(3);
    const [event] = sentFeedback();
    expect(written(stderrSpy)).toContain(`feedback not confirmed: PostHog did not acknowledge report ${event?.uuid}, so it may not have arrived.`);
  });

  it('sends a bug without --repro to GitHub as a prefilled, redacted issue and posts nothing', async () => {
    vi.stubEnv('MY_SERVICE_TOKEN', 'hunter2-hunter2');
    await invoke('feedback', '--type', 'bug', '-m', 'tap lands on the wrong tab', '--actual', 'token hunter2-hunter2 leaked', '--error-code', 'TARGET_NOT_FOUND');
    expect(process.exitCode).toBe(0);
    expect(sentFeedback()).toEqual([]);
    const output = written(stdoutSpy);
    expect(output).toContain('Not sent: a bug without --repro goes to GitHub');
    const url = new URL(output.trim().split('\n').at(-1) ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/tester-army/e2e/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('title')).toBe('tap lands on the wrong tab');
    expect(url.searchParams.get('what')).toBe('tap lands on the wrong tab\n\nActual: token <secret:MY_SERVICE_TOKEN> leaked\nError code: TARGET_NOT_FOUND');
    expect(url.searchParams.get('versions')).toContain(`e2e ${packageVersion}, node `);
  });

  it('keeps the GitHub link under the length GitHub accepts', async () => {
    const long = 'x'.repeat(1500);
    await invoke('feedback', '--type', 'bug', '-m', 'y'.repeat(2000), '--task', long, '--expected', long, '--actual', long, '--approach', long);
    const link = written(stdoutSpy).trim().split('\n').at(-1) ?? '';
    expect(link.length).toBeLessThanOrEqual(8000);
    expect(new URL(link).searchParams.get('what')).toMatch(/…$/u);
  });

  it('refuses a report from an outdated e2e with exit 2 unless --allow-outdated', async () => {
    latestIs('999.0.0');
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(2);
    expect(sentFeedback()).toEqual([]);
    expect(written(stderrSpy)).toContain(`feedback not sent: e2e ${packageVersion} is older than the latest release 999.0.0`);
    process.exitCode = undefined;
    await invoke('feedback', '-m', 'broken', '--allow-outdated');
    expect(process.exitCode).toBe(0);
    expect(sentFeedback()).toHaveLength(1);
  });

  it('sends when the registry fails or does not answer with a version', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).startsWith('https://registry.npmjs.org/')) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    });
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(0);
    expect(sentFeedback()).toHaveLength(1);
  });

  it('counts the length limit in characters, not UTF-16 units', async () => {
    await invoke('feedback', '-m', '🐛'.repeat(2000), '--dry-run');
    expect(process.exitCode).toBe(0);
  });

  it('rejects a missing message, a blank one, one over the limit, and an unknown type with exit 2', async () => {
    for (const args of [[], ['-m', '  '], ['-m', 'x'.repeat(2001)], ['--type', 'rant', '-m', 'x'], ['-m', 'x', '--error-code', 'not a code'], ['-m', 'x', '--actual', 'x'.repeat(1501)]]) {
      process.exitCode = undefined;
      await invoke('feedback', ...args);
      expect(process.exitCode).toBe(2);
    }
    expect(sentFeedback()).toEqual([]);
  });
});

describe('e2e upgrade argument parsing', () => {
  it('upgrades to latest by default, under either name', async () => {
    for (const name of ['upgrade', 'update']) {
      upgradeMock.mockClear();
      await invoke(name);
      expect(upgradeMock).toHaveBeenCalledExactlyOnceWith({ target: { kind: 'tag', tag: 'latest' } });
      expect(process.exitCode).toBe(0);
    }
  });

  it('passes a version, a dist-tag, and --dry-run through, and exits with the upgrade\'s code', async () => {
    upgradeMock.mockResolvedValue(upgradeOutcome(3));
    await invoke('update', 'v0.22.0', '--dry-run');
    expect(upgradeMock).toHaveBeenCalledExactlyOnceWith({ target: { kind: 'version', version: '0.22.0' }, dryRun: true });
    expect(process.exitCode).toBe(3);
    upgradeMock.mockClear();
    await invoke('upgrade', 'nightly');
    expect(upgradeMock).toHaveBeenCalledExactlyOnceWith({ target: { kind: 'tag', tag: 'nightly' } });
  });

  it('refuses a range with exit 2 and never upgrades', async () => {
    await invoke('upgrade', '^0.22.0');
    expect(upgradeMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain("error: command-argument value '^0.22.0' is invalid for argument 'version'. must be a version such as 0.22.0 or a dist-tag");
  });
});

describe('olderThan', () => {
  it.each([
    ['0.19.0', '0.20.0', true],
    ['0.20.0', '0.20.0', false],
    ['0.21.0-nightly-20261014080557', '0.20.0', false],
    ['0.20.1-nightly-20261013094930', '0.20.1', true],
    ['1.0.0', '0.99.99', false],
    ['0.0.0', 'garbage', false],
  ] as const)('%s before %s is %s', (version, latest, older) => {
    expect(olderThan(version, latest)).toBe(older);
  });
});

describe('e2e telemetry', () => {
  let configHome: string;

  /** Every `[telemetry] {...}` line the debug mode printed to stderr. */
  function printedEvents(): { event: string; properties: Record<string, unknown> }[] {
    return written(stderrSpy)
      .split('\n')
      .filter((line) => line.startsWith('[telemetry] '))
      .map((line) => JSON.parse(line.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> });
  }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-telemetry-'));
    // The suite-wide opt-out is lifted; debug mode prints instead of sending.
    vi.stubEnv('E2E_TELEMETRY_DISABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('E2E_TELEMETRY_DEBUG', '1');
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('APPDATA', configHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configHome, { recursive: true, force: true });
  });

  it('disable saves the choice, status names it, and enable restores it', async () => {
    const file = path.join(configHome, 'e2e', 'telemetry.json');
    await invoke('telemetry', 'disable');
    expect(written(stdoutSpy)).toContain(`telemetry disabled; saved to ${file}\n`);
    expect(written(stdoutSpy)).toContain('Status: disabled (switched off with e2e telemetry disable)\n');
    expect(written(stdoutSpy)).toContain('No usage data is sent from this machine.\n');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ enabled: false });
    expect(process.exitCode).toBe(0);

    stdoutSpy.mockClear();
    await invoke('telemetry');
    expect(written(stdoutSpy)).toContain('Status: disabled (switched off with e2e telemetry disable)\n');

    stdoutSpy.mockClear();
    await invoke('telemetry', 'enable');
    expect(written(stdoutSpy)).toContain(`telemetry enabled; saved to ${file}\n`);
    expect(written(stdoutSpy)).toContain('Status: enabled\n');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ enabled: true });
  });

  it('an environment opt-out wins over the saved choice', async () => {
    vi.stubEnv('E2E_TELEMETRY_DISABLED', '1');
    await invoke('telemetry', 'enable');
    expect(written(stdoutSpy)).toContain('Status: disabled (E2E_TELEMETRY_DISABLED is set)\n');
    expect(printedEvents()).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('prints the notice once before the first command and a session event per command', async () => {
    await invoke('list');
    await invoke('list', '--tag', 'smoke');
    const notices = written(stderrSpy).split('e2e collects anonymous usage telemetry').length - 1;
    expect(notices).toBe(1);
    expect(written(stderrSpy)).toContain('e2e telemetry disable');
    const events = printedEvents();
    expect(events.map((event) => event.event)).toEqual(['e2e_cli_session', 'e2e_cli_session']);
    expect(events[0]!.properties['command']).toBe('list');
    expect(events[0]!.properties['flags']).toEqual([]);
    expect(events[1]!.properties['flags']).toEqual(['--tag']);
    expect(JSON.stringify(events)).not.toContain('smoke');
    expect(events[0]!.properties['$lib']).toBe('e2e');
    expect(events[0]!.properties['distinct_id']).toMatch(/^[a-f0-9]{32}$/u);
  });

  it('does not print the notice before e2e telemetry itself', async () => {
    await invoke('telemetry');
    expect(written(stderrSpy)).not.toContain('e2e collects anonymous usage telemetry');
    expect(printedEvents().map((event) => event.properties['command'])).toEqual(['telemetry']);
  });

  it('does not print the notice before e2e init, and still prints it before the next command', async () => {
    await invoke('init', '--yes');
    expect(written(stderrSpy)).not.toContain('e2e collects anonymous usage telemetry');
    expect(printedEvents().filter((event) => event.event === 'e2e_cli_session').map((event) => event.properties['command'])).toEqual(['init']);
    await invoke('list');
    expect(written(stderrSpy)).toContain('e2e collects anonymous usage telemetry');
  });

  it('records the run event from the report the run returned, with the flag names only', async () => {
    runMock.mockResolvedValue({ exitCode: 1, report: sampleReport() });
    await invoke('run', '--workers', '3', '--headed', 'tests/secret.e2e.ts');
    const events = printedEvents();
    expect(events.map((event) => event.event)).toEqual(['e2e_cli_session', 'e2e_run_completed']);
    const run = events[1]!;
    expect(run.properties['flags']).toEqual(['--headed', '--workers']);
    expect(run.properties['status']).toBe('failed');
    expect(run.properties['tests_executed']).toBe(2);
    expect(run.properties['engines']).toEqual(['homegrown@9.9.9', 'playwright@0.6.1']);
    const payload = JSON.stringify(run);
    for (const secret of SAMPLE_REPORT_SECRETS) expect(payload).not.toContain(secret);
    expect(payload).not.toContain('"3"');
    expect(process.exitCode).toBe(1);
  });

  it('ends the session event with the exit code, and the failure code when the command threw', async () => {
    await invoke('list');
    const [listed] = printedEvents();
    expect(listed!.properties['exit_code']).toBe(0);
    expect(listed!.properties['error_code']).toBeNull();
    expect(typeof listed!.properties['duration_ms']).toBe('number');

    stderrSpy.mockClear();
    runMock.mockRejectedValue(new ConfigurationError('CONFIG_NOT_FOUND', 'no e2e.config.ts in /secret/place'));
    await invoke('run');
    const [failed] = printedEvents();
    expect(failed!.event).toBe('e2e_cli_session');
    expect(failed!.properties['exit_code']).toBe(2);
    expect(failed!.properties['error_code']).toBe('CONFIG_NOT_FOUND');
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(process.exitCode).toBe(2);

    stderrSpy.mockClear();
    runMock.mockResolvedValue({ exitCode: 1, report: sampleReport() });
    await invoke('run');
    const [session, run] = printedEvents();
    expect(session!.properties['exit_code']).toBe(1);
    expect(session!.properties['error_code']).toBeNull();
    expect(run!.properties).not.toHaveProperty('error_code');
  });

  it('names a usage error commander rejected, as a session of the command it was aimed at', async () => {
    await invoke('run', '--workers', 'many');
    const events = printedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.properties['command']).toBe('run');
    expect(events[0]!.properties['flags']).toEqual([]);
    expect(events[0]!.properties['exit_code']).toBe(2);
    expect(events[0]!.properties['error_code']).toBe('CLI_USAGE');
    expect(JSON.stringify(events)).not.toContain('many');
    expect(process.exitCode).toBe(2);
    expect(runMock).not.toHaveBeenCalled();

    stderrSpy.mockClear();
    await invoke('cache', 'ls', '--nope');
    const [nested] = printedEvents();
    expect(nested!.properties['command']).toBe('cache ls');
    expect(nested!.properties['error_code']).toBe('CLI_USAGE');
  });

  it('records no session for --help, help <command>, or --version', async () => {
    for (const args of [
      ['--help'],
      ['run', '--help'],
      ['login', '--help'],
      ['cache', 'ls', '-h'],
      ['help', 'run'],
      ['--version'],
    ]) {
      process.exitCode = undefined;
      await invoke(...args);
      expect(process.exitCode).toBe(0);
    }
    expect(printedEvents()).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('records the init flag names, never their values, and only the half of --install/--no-install given', async () => {
    await invoke('init', '--yes', '--gateway', 'openai-compatible', '--endpoint', 'https://llm.secret.example/v1', '--skills', '.claude/skills', '--no-install');
    const [session] = printedEvents();
    expect(session!.properties['flags']).toEqual(['--endpoint', '--gateway', '--no-install', '--skills', '--yes']);
    expect(JSON.stringify(printedEvents())).not.toContain('secret');
    expect(JSON.stringify(printedEvents())).not.toContain('.claude');
  });

  it('records the upgrade event from the outcome upgrade returns, under either name', async () => {
    upgradeMock.mockResolvedValue({
      exitCode: 2,
      result: 'unknown-target',
      target: { kind: 'tag', tag: 'beta' },
      fromVersion: '0.20.0',
      toVersion: null,
      manager: 'npm',
      siblings: [],
      moved: 0,
      linked: 0,
    });
    await invoke('update', 'beta', '--dry-run');
    const events = printedEvents();
    expect(events.map((event) => event.event)).toEqual(['e2e_cli_session', 'e2e_upgrade_completed']);
    expect(events[0]!.properties).toMatchObject({ command: 'upgrade', flags: ['--dry-run'], exit_code: 2 });
    expect(events[1]!.properties).toMatchObject({ result: 'unknown-target', target: 'beta', from_version: '0.20.0', to_version: null });
    expect(process.exitCode).toBe(2);
  });

  it('records the init event from the outcome init returns', async () => {
    initMock.mockResolvedValue(initOutcome(0, { result: 'cancelled', engine: 'agent-device' }));
    await invoke('init', 'apps/secret-app');
    const events = printedEvents();
    expect(events.map((event) => event.event)).toEqual(['e2e_cli_session', 'e2e_init_completed']);
    expect(events[1]!.properties).toMatchObject({ result: 'cancelled', engine: 'agent-device', gateway: null, skill: false });
    expect(JSON.stringify(events)).not.toContain('secret-app');
  });
});

describe('update notice', () => {
  let configHome: string;
  let stderrTty: boolean;
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ version: '99.0.0' }));

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-update-'));
    // The suite-wide opt-outs are lifted; debug mode keeps telemetry off the network.
    vi.stubEnv('E2E_UPDATE_CHECK_DISABLED', undefined);
    vi.stubEnv('E2E_TELEMETRY_DISABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('E2E_TELEMETRY_DEBUG', '1');
    vi.stubEnv('CI', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('APPDATA', configHome);
    vi.stubGlobal('fetch', fetchMock);
    stderrTty = process.stderr.isTTY;
    process.stderr.isTTY = true;
    fetchMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.stderr.isTTY = stderrTty;
    rmSync(configHome, { recursive: true, force: true });
  });

  it('follows the output of a command on a terminal', async () => {
    await invoke('list');
    expect(fetchMock).toHaveBeenCalledWith('https://registry.npmjs.org/e2e/latest', expect.anything());
    expect(written(stderrSpy)).toContain(`Update available ${packageVersion} → 99.0.0\n`);
  });

  it('neither asks nor prints for --version', async () => {
    await invoke('--version');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).not.toContain('Update available');
  });
});
