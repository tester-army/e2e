import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListOptions, ListedPair, RunOptions } from '../../src/run/runner.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import { SAMPLE_REPORT_SECRETS, sampleReport } from '../helpers/sample-report.ts';

const runMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/run/runner.ts', () => ({
  run: runMock,
  list: listMock,
}));
vi.mock('../../src/cli/init.ts', () => ({
  init: initMock,
}));

const { main } = await import('../../src/cli/index.ts');

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

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
  runMock.mockResolvedValue({ exitCode: 0 });
  listMock.mockReset();
  listMock.mockResolvedValue({ pairs: [] });
  initMock.mockReset();
  initMock.mockResolvedValue(0);
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
    expect(process.exitCode).toBe(0);
  });

  it('collects positional files', async () => {
    await invoke('run', 'tests/a.e2e.ts', 'tests/b.e2e.ts');
    expect(lastRunOptions().files).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
  });

  it('splits comma-separated targets and trims whitespace', async () => {
    await invoke('run', '--target', 'chromium, firefox , ,webkit');
    expect(lastRunOptions().targetIds).toEqual(['chromium', 'firefox', 'webkit']);
  });

  it('accumulates repeated --tag flags', async () => {
    await invoke('run', '--tag', 'smoke', '--tag', 'auth');
    expect(lastRunOptions().tags).toEqual(['smoke', 'auth']);
  });

  it('accepts --tag-mode all', async () => {
    await invoke('run', '--tag-mode', 'all');
    expect(lastRunOptions().tagMode).toBe('all');
  });

  it('rejects an invalid --tag-mode with exit code 2 and never runs', async () => {
    await invoke('run', '--tag-mode', 'sometimes');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe(
      "error: option '--tag-mode <mode>' argument 'sometimes' is invalid. Allowed choices are any, all.\n(add --help for usage)\n",
    );
  });

  it('parses reporters and rejects unknown reporters with exit code 2', async () => {
    await invoke('run', '--reporter', 'list,json');
    expect(lastRunOptions().reporters).toEqual(['list', 'json']);

    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--reporter', 'list,teamcity');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe(
      "error: option '--reporter <ids>' argument 'list,teamcity' is invalid. unknown reporter \"teamcity\"; expected list, json, junit\n(add --help for usage)\n",
    );
  });

  it('accepts the junit reporter alone and beside list or json', async () => {
    await invoke('run', '--reporter', 'junit');
    expect(lastRunOptions().reporters).toEqual(['junit']);

    runMock.mockClear();
    await invoke('run', '--reporter', 'list,junit');
    expect(lastRunOptions().reporters).toEqual(['list', 'junit']);

    // Reporter combination rules are config truth (INVALID_CONFIG), not CLI
    // parsing: the CLI only rejects ids it does not know.
    runMock.mockClear();
    await invoke('run', '--reporter', 'junit,json');
    expect(lastRunOptions().reporters).toEqual(['junit', 'json']);
    expect(process.exitCode).toBe(0);
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
      '--artifacts',
      'out/artifacts',
    );
    const options = lastRunOptions();
    expect(options.headed).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.aiTrace).toBe(true);
    expect(options.passWithNoTests).toBe(true);
    expect(options.configPath).toBe('custom.config.ts');
    expect(options.artifactsDir).toBe('out/artifacts');
  });

  it('propagates the run outcome exit code', async () => {
    runMock.mockResolvedValue({ exitCode: 3 });
    await invoke('run');
    expect(process.exitCode).toBe(3);
  });

  it('maps unexpected parse failures to exit code 2', async () => {
    await invoke('definitely-not-a-command');
    expect(process.exitCode).toBe(2);
  });

});

describe('e2e list', () => {
  const pairs: ListedPair[] = [
    { file: 'tests/a.e2e.ts', title: 'signs in', titlePath: ['signs in'], kind: 'test', target: 'web', disposition: 'run' },
    {
      file: 'tests/a.e2e.ts',
      title: 'pays',
      titlePath: ['billing', 'pays'],
      kind: 'test',
      target: 'web',
      disposition: 'skip',
      skipReason: 'not today',
    },
    { file: 'tests/b.e2e.ts', title: 'browses', titlePath: ['browses'], kind: 'test', target: 'webkit', disposition: 'run' },
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
        'tests/a.e2e.ts › signs in [web]',
        'tests/a.e2e.ts › billing › pays [web] (skipped: not today)',
        'tests/b.e2e.ts › browses [webkit]',
        '',
      ].join('\n'),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('prints { pairs } with --reporter json', async () => {
    listMock.mockResolvedValue({ pairs });
    await invoke('list', '--reporter', 'json');
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(written(stdoutSpy))).toEqual({ pairs });
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
      '--pass-with-no-tests',
    );
    expect(lastListOptions()).toEqual({
      files: ['tests/a.e2e.ts'],
      configPath: 'custom.config.ts',
      targetIds: ['web', 'webkit'],
      tags: ['smoke', 'auth'],
      tagMode: 'all',
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

  it('prints a collection failure as code and message with its exit code', async () => {
    listMock.mockRejectedValue(new ConfigurationError('NO_TESTS', 'no tests matched'));
    await invoke('list');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('NO_TESTS: no tests matched\n');
    expect(process.exitCode).toBe(2);
  });

  it('is listed in the help with an example, and its own help groups the flags', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}list \[options\] \[files\.\.\.\] {2,}print the tests a run would select/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e list --tag smoke\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('list', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e list [options] [files...]');
    const headings = [...help.matchAll(/^(\S[^\n]*):$/gmu)].map((match) => match[1]);
    expect(headings).toEqual(['Arguments', 'Selection', 'Output', 'Options', 'Examples']);
    const flags = [...help.matchAll(/^ {2}(-{1,2}[a-z-]+)/gmu)].map((match) => match[1]);
    expect(flags).toEqual(['--config', '--target', '--tag', '--tag-mode', '--pass-with-no-tests', '--reporter', '-h']);
    expect(help).toContain('  $ e2e list --reporter json\n');
    expect(help).toContain('Docs: https://e2e-docs.vercel.app/reference/cli#e2e-list\n');
    expect(process.exitCode).toBe(0);
    expect(listMock).not.toHaveBeenCalled();
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
    initMock.mockResolvedValue(2);
    await invoke('init', 'apps/web');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(
      path.resolve(process.cwd(), 'apps/web'),
      expect.objectContaining({ directory: 'apps/web' }),
    );
    expect(process.exitCode).toBe(2);
  });

  it('rejects a second positional', async () => {
    await invoke('init', 'one', 'two');
    expect(initMock).not.toHaveBeenCalled();
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
    expect(help).toMatch(/^ {2}cache {2,}inspect, measure, and clear the trace cache$/mu);
    expect(help).toMatch(/^ {2}help \[command\] {2,}show help for a command$/mu);
    expect(help).toMatch(/^ {2}-v, --version {2,}print the version$/mu);
    expect(help).toMatch(/^ {2}-h, --help {2,}show help$/mu);
    expect(help).toContain('Examples:\n  $ e2e init\n  $ e2e run\n');
    expect(help).toContain('Run e2e <command> --help for the flags of one command.');
    expect(help).toContain('Docs: https://e2e-docs.vercel.app\n');
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
      '--pass-with-no-tests',
      '--headed',
      '--workers',
      '--retries',
      '--no-cache',
      '--reporter',
      '--artifacts',
      '--debug',
      '--ai-trace',
      '-h',
    ]);
    // Commander wraps at the help width, so the choices may span two lines.
    expect(help).toMatch(/\(choices: "any", "all",\s+default: "any"\)/u);
    expect(help).toContain("  $ e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke\n");
    expect(help).toMatch(/^Exit codes:\n {2}0 {4}every selected test passed/mu);
    expect(help).toMatch(/^ {2}130 {2}interrupted/mu);
    expect(help).toContain('Docs: https://e2e-docs.vercel.app/reference/cli#exit-codes\n');
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

  it('describes init, its directory argument, and its one flag', async () => {
    await invoke('init', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e init [options] [directory]');
    expect(help).toContain('without touching existing files');
    expect(help).toMatch(/^ {2}directory {2,}project directory, created when missing/mu);
    expect(help).toMatch(/^ {2}-y, --yes {2,}skip the prompts: Playwright, AI on, no installation$/mu);
    expect(help).toContain('  $ e2e init my-app\n  $ e2e init --yes\n');
    expect(process.exitCode).toBe(0);
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

describe('e2e guide', () => {
  it('prints the overview without frontmatter, exits 0, and never runs', async () => {
    await invoke('guide');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy).startsWith('# e2e')).toBe(true);
    expect(written(stdoutSpy)).toContain('npx --no-install e2e guide <topic>');
  });

  it('prints one topic', async () => {
    await invoke('guide', 'writing-tests');
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy).startsWith('# Writing tests')).toBe(true);
  });

  it('rejects an unknown topic with exit code 2 and the topic list', async () => {
    await invoke('guide', 'nope');
    expect(process.exitCode).toBe(2);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('unknown topic "nope"; topics: agent, debugging, running, setup, writing-tests\n');
  });

  it('is listed in the help with an example, and its own help names the topics', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}guide \[topic\] {2,}print the e2e skill for coding agents$/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e guide\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('guide', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e guide [options] [topic]');
    expect(help).toMatch(/one of agent, debugging, running, setup,\s+writing-tests/u);
    expect(help).toContain('  $ e2e guide writing-tests\n');
    expect(help).toContain('Docs: https://e2e-docs.vercel.app/reference/cli#e2e-guide\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('e2e telemetry', () => {
  const TELEMETRY_KEYS = ['E2E_TELEMETRY_DISABLED', 'E2E_TELEMETRY_DEBUG', 'DO_NOT_TRACK', 'CI', 'XDG_CONFIG_HOME', 'APPDATA'] as const;
  let configHome: string;
  let saved: Partial<Record<(typeof TELEMETRY_KEYS)[number], string | undefined>>;

  /** Every `[telemetry] {...}` line the debug mode printed to stderr. */
  function printedEvents(): { event: string; properties: Record<string, unknown> }[] {
    return written(stderrSpy)
      .split('\n')
      .filter((line) => line.startsWith('[telemetry] '))
      .map((line) => JSON.parse(line.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> });
  }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-telemetry-'));
    saved = Object.fromEntries(TELEMETRY_KEYS.map((key) => [key, process.env[key]]));
    // The suite-wide opt-out is lifted; debug mode prints instead of sending.
    delete process.env['E2E_TELEMETRY_DISABLED'];
    delete process.env['DO_NOT_TRACK'];
    delete process.env['CI'];
    process.env['E2E_TELEMETRY_DEBUG'] = '1';
    process.env['XDG_CONFIG_HOME'] = configHome;
    process.env['APPDATA'] = configHome;
  });

  afterEach(() => {
    for (const key of TELEMETRY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(configHome, { recursive: true, force: true });
  });

  it('reports enabled by default and points at the docs', async () => {
    await invoke('telemetry');
    const out = written(stdoutSpy);
    expect(out).toContain('Status: enabled\n');
    expect(out).toContain('Details: https://e2e-docs.vercel.app/telemetry\n');
    expect(process.exitCode).toBe(0);
  });

  it('disable saves the choice, status names it, and enable restores it', async () => {
    const file = path.join(configHome, 'e2e', 'telemetry.json');
    await invoke('telemetry', 'disable');
    expect(written(stdoutSpy)).toContain(`telemetry disabled; saved to ${file}\n`);
    expect(written(stdoutSpy)).toContain('Status: disabled (switched off with e2e telemetry disable)\n');
    expect(written(stdoutSpy)).toContain('Nothing is sent from this machine.\n');
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
    process.env['E2E_TELEMETRY_DISABLED'] = '1';
    await invoke('telemetry', 'enable');
    expect(written(stdoutSpy)).toContain('Status: disabled (E2E_TELEMETRY_DISABLED is set)\n');
    expect(printedEvents()).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  it('rejects an unknown action with exit code 2', async () => {
    await invoke('telemetry', 'nope');
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('Allowed choices are status, enable, disable');
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

  it('records the run event from the report the run returned, with the flag names only', async () => {
    runMock.mockResolvedValue({ exitCode: 1, report: sampleReport() });
    await invoke('run', '--workers', '3', '--headed', 'tests/secret.e2e.ts');
    const events = printedEvents();
    expect(events.map((event) => event.event)).toEqual(['e2e_cli_session', 'e2e_run_completed']);
    const run = events[1]!;
    expect(run.properties['flags']).toEqual(['--headed', '--workers']);
    expect(run.properties['status']).toBe('failed');
    expect(run.properties['tests_executed']).toBe(2);
    expect(run.properties['engines']).toEqual(['other', 'playwright@0.6.1']);
    const payload = JSON.stringify(run);
    for (const secret of SAMPLE_REPORT_SECRETS) expect(payload).not.toContain(secret);
    expect(payload).not.toContain('"3"');
    expect(process.exitCode).toBe(1);
  });

  it('records nothing for a run that produced no report', async () => {
    await invoke('run');
    expect(printedEvents().map((event) => event.event)).toEqual(['e2e_cli_session']);
  });

  it('is listed in the help with its actions', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}telemetry \[action\] {2,}show, enable, or disable anonymous usage telemetry$/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e telemetry disable\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('telemetry', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e telemetry [options] [action]');
    expect(help).toContain('E2E_TELEMETRY_DEBUG=1');
    expect(help).toContain('  $ E2E_TELEMETRY_DEBUG=1 e2e run\n');
    expect(help).toContain('Docs: https://e2e-docs.vercel.app/telemetry\n');
    expect(process.exitCode).toBe(0);
  });
});
