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
  it('writes two-space-indented JSON with a trailing newline', async () => {
    const file = path.join(dir, 'report.json');
    await writeJsonReport(file, { a: 1, nested: { b: true } });
    const raw = readFileSync(file, 'utf8');
    expect(raw).toBe(`${JSON.stringify({ a: 1, nested: { b: true } }, null, 2)}\n`);
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({ a: 1, nested: { b: true } });
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'deep', 'nested', 'report.json');
    await writeJsonReport(file, []);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('leaves no temporary files behind', async () => {
    const file = path.join(dir, 'report.json');
    await writeJsonReport(file, { ok: true });
    expect(readdirSync(dir)).toEqual(['report.json']);
  });

  it('atomically replaces an existing report', async () => {
    const file = path.join(dir, 'report.json');
    await writeJsonReport(file, { version: 1 });
    await writeJsonReport(file, { version: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2 });
    expect(readdirSync(dir)).toEqual(['report.json']);
  });
});
