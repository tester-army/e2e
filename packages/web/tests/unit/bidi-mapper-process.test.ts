/**
 * The out-of-process `chromium-bidi` mapper's lifecycle: it waits for the
 * CDP URL on stdin, exits cleanly when the driver goes away first, and
 * exits with the reason when the browser cannot be reached.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../../src/bidi/mapper-process.ts', import.meta.url));

/** Starts the mapper; resolves with its exit code and stderr once it exits. */
function run(stdin: (write: (line: string) => void, end: () => void) => void): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  stdin((line) => child.stdin.write(`${line}\n`), () => child.stdin.end());
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })));
}

describe('mapper process', () => {
  it('exits cleanly when the driver closes stdin before naming a browser', async () => {
    await expect(run((_write, end) => end())).resolves.toEqual({ code: 0, stderr: '' });
  });

  it('exits with the reason when the CDP endpoint does not answer', async () => {
    const { code, stderr } = await run((write) => write('ws://127.0.0.1:9/devtools/browser/none'));
    expect(code).toBe(1);
    expect(stderr).toContain('CDP WebSocket ws://127.0.0.1:9/devtools/browser/none failed to open');
  });
});
