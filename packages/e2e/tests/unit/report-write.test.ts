import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonReport } from '../../src/report/write.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonReport', () => {
  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'deep', 'nested', 'report.json');
    await writeJsonReport(file, []);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('atomically replaces an existing report', async () => {
    const file = path.join(dir, 'report.json');
    await writeJsonReport(file, { version: 1 });
    await writeJsonReport(file, { version: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2 });
    expect(readdirSync(dir)).toEqual(['report.json']);
  });
});
