/**
 * A reader that closes the pipe early (`e2e --help | head -1`) leaves the
 * built CLI writing to nobody. It finishes quietly with its own exit code
 * instead of dying on an unhandled EPIPE.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

/** Runs the built CLI with its stdout read end closed at once; resolves its exit code and stderr. */
function runWithClosedStdout(args: readonly string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('the CLI writing to a closed pipe', () => {
  it.each([[['--help']], [['run', '--help']], [['--version']]])('exits 0 without a stack trace for %j', async (args) => {
    const { code, stderr } = await runWithClosedStdout(args);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});
