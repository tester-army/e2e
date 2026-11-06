import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import type { InstallName } from '../../src/cli.ts';

/** Runs `e2e-web` with recorded output and a fake installer that exits with `exitCode`. */
async function run(args: readonly string[], exitCode = 0) {
  const calls: { names: readonly InstallName[]; withDeps: boolean; headed: boolean }[] = [];
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    run: async (names, options) => {
      calls.push({ names, ...options });
      return exitCode;
    },
  });
  return { code, calls, stdout, stderr };
}

describe('e2e-web', () => {
  it('installs chromium when no browser is named', async () => {
    expect(await run(['install'])).toMatchObject({ code: 0, calls: [{ names: ['chromium'], withDeps: false, headed: false }] });
  });

  it('forwards the named browsers, --with-deps, and --headed', async () => {
    expect((await run(['install', 'firefox', '--with-deps', 'chromium', '--headed'])).calls).toEqual([
      { names: ['firefox', 'chromium'], withDeps: true, headed: true },
    ]);
  });

  it('forwards ffmpeg, which installs no browser', async () => {
    expect((await run(['install', 'ffmpeg'])).calls).toEqual([{ names: ['ffmpeg'], withDeps: false, headed: false }]);
  });

  it("exits with the installer's code", async () => {
    expect((await run(['install'], 1)).code).toBe(1);
  });

  it.each([[['--help']], [['help']], [['install', 'firefox', '-h']]])(
    'prints usage for %j without running anything',
    async (args) => {
      const result = await run(args);
      expect(result).toMatchObject({ code: 0, calls: [] });
      expect(result.stdout).toContain('Usage: npx @e2e-dev/web install [chromium|firefox|ffmpeg ...] [--with-deps] [--headed]');
      expect(result.stdout).toContain('pnpm exec e2e-web install');
    },
  );

  it.each([
    [[], 'missing command'],
    [['show-report'], 'unknown command "show-report"'],
    [['install', '--force'], 'unknown option "--force"'],
    [['install', 'webkit'], 'unknown browser "webkit"; expected one of chromium, firefox, ffmpeg'],
  ])('rejects %j with exit code 2', async (args, message) => {
    const result = await run(args);
    expect(result).toMatchObject({ code: 2, calls: [] });
    expect(result.stderr).toContain(message);
  });
});
