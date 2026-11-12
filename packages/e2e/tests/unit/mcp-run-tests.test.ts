import { describe, expect, it } from 'vitest';
import { runArguments } from '../../src/mcp/run-tests.ts';

const defaults = { headed: false };

describe('runArguments', () => {
  it('runs every test with no arguments', () => {
    expect(runArguments({}, defaults)).toEqual(['run']);
  });

  it('puts each value in its option word and the files after --', () => {
    expect(
      runArguments(
        {
          files: ['tests/a.e2e.ts:12', 'tests/b'],
          config: 'e2e.other.config.ts',
          target: ['web', 'ios'],
          grep: 'check out',
          grepInvert: '-new',
          tag: ['smoke', 'billing'],
          excludeTag: ['slow'],
          lastFailed: true,
          changedSince: 'origin/main',
          headed: true,
          workers: 2,
          retries: 0,
          repeatEach: 5,
          maxFailures: 1,
          actionTimeout: 5000,
          noCache: true,
          updateSnapshots: true,
        },
        defaults,
      ),
    ).toEqual([
      'run',
      '--config=e2e.other.config.ts',
      '--target=web',
      '--target=ios',
      '--grep=check out',
      '--grep-invert=-new',
      '--tag=smoke',
      '--tag=billing',
      '--exclude-tag=slow',
      '--last-failed',
      '--changed-since=origin/main',
      '--headed',
      '--workers=2',
      '--retries=0',
      '--repeat-each=5',
      '--max-failures=1',
      '--action-timeout=5000',
      '--no-cache',
      '--update-snapshots',
      '--',
      'tests/a.e2e.ts:12',
      'tests/b',
    ]);
  });

  it("takes the server's config, target, and headed unless the call names its own", () => {
    const server = { configPath: 'e2e.mcp.config.ts', target: 'web', headed: true };
    expect(runArguments({}, server)).toEqual(['run', '--config=e2e.mcp.config.ts', '--target=web', '--headed']);
    expect(runArguments({ config: 'mine.config.ts', target: ['android'], headed: false }, server)).toEqual(['run', '--config=mine.config.ts', '--target=android']);
  });
});
