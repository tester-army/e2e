import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-guide-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it('rejects an unknown guide topic with the CLI usage-error status', async () => {
  await expect(execFileAsync(process.execPath, [CLI, 'guide', 'nope'], { cwd: dir })).rejects.toMatchObject({ code: 2 });
});
