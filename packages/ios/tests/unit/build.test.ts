import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/build.ts';

/** A stub `xcodebuild` on PATH that logs its calls and writes a `.xctestrun` where a build would. */
function stubXcode(options: { fail?: boolean } = {}): { log: string; env: Record<string, string> } {
  const bin = mkdtempSync(path.join(tmpdir(), 'e2e-ios-xcode-'));
  const log = path.join(bin, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(
    path.join(bin, 'xcodebuild'),
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "-version" ]; then echo "Xcode 99.0"; exit 0; fi
${options.fail === true ? 'echo "error: no SDK" >&2; exit 65' : ''}
while [ $# -gt 0 ]; do
  if [ "$1" = "-derivedDataPath" ]; then mkdir -p "$2/Build/Products" && touch "$2/Build/Products/E2EServer.xctestrun"; fi
  shift
done
`,
  );
  chmodSync(path.join(bin, 'xcodebuild'), 0o755);
  process.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`;
  return { log, env: { E2E_IOS_BUILD_DIR: mkdtempSync(path.join(tmpdir(), 'e2e-ios-builds-')) } };
}

const builds = (log: string): number => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('build-for-testing')).length;

describe('buildServer', () => {
  const originalPath = process.env['PATH'];
  beforeEach(() => {
    process.env['PATH'] = originalPath;
  });

  it('builds once into the build directory, then reuses the build', async () => {
    const { log, env } = stubXcode();
    const first = await buildServer({ env });
    expect(first.startsWith(env['E2E_IOS_BUILD_DIR']!)).toBe(true);
    expect(first.endsWith('.xctestrun')).toBe(true);
    expect(await buildServer({ env })).toBe(first);
    expect(builds(log)).toBe(1);
    expect(readFileSync(log, 'utf8')).toContain('-destination generic/platform=iOS Simulator');
  });

  it('leaves no partial build behind when xcodebuild fails', async () => {
    const { env } = stubXcode({ fail: true });
    await expect(buildServer({ env })).rejects.toThrow(/error: no SDK/);
    expect(readdirSync(env['E2E_IOS_BUILD_DIR']!)).toEqual([]);
  });
});
