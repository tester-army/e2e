import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions } from '../../src/run/runner.ts';

const runMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/run/runner.ts', () => ({
  run: runMock,
}));

const { main } = await import('../../src/cli/index.ts');

function lastRunOptions(): RunOptions {
  expect(runMock).toHaveBeenCalledTimes(1);
  return runMock.mock.calls[0]?.[0] as RunOptions;
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args]);
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0 });
  process.exitCode = undefined;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
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
    expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('invalid --tag-mode');
  });

  it('parses reporters and rejects unknown reporters with exit code 2', async () => {
    await invoke('run', '--reporter', 'list,json');
    expect(lastRunOptions().reporters).toEqual(['list', 'json']);

    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--reporter', 'teamcity');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('unknown reporter "teamcity"');
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
      '--pass-with-no-tests',
      '--config',
      'custom.config.ts',
      '--artifacts',
      'out/artifacts',
    );
    const options = lastRunOptions();
    expect(options.headed).toBe(true);
    expect(options.debug).toBe(true);
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
