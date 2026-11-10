/**
 * The upload policy: a model-named path reaches the engine only when it is a
 * regular file inside the project root and not hidden. Everything else fails
 * closed, with the code that says whether the path was refused or merely
 * wrong, and every refusal and the final allow is recorded on the step.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizeUploadPaths } from '../../src/agent/upload-paths.ts';

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'e2e-upload-'));
  root = path.join(base, 'project');
  outside = path.join(base, 'outside.txt');
  mkdirSync(path.join(root, 'fixtures', '.hidden'), { recursive: true });
  writeFileSync(path.join(root, 'fixtures', 'a.txt'), 'a');
  writeFileSync(path.join(root, 'fixtures', '.hidden', 'b.txt'), 'b');
  writeFileSync(path.join(root, '.env'), 'SECRET=1');
  writeFileSync(outside, 'outside');
  symlinkSync(outside, path.join(root, 'fixtures', 'link.txt'));
});

afterAll(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

/** Runs the policy against a recording host; returns the code it threw and what it recorded. */
function authorize(paths: unknown): { code: string | undefined; recorded: string[]; resolved?: readonly string[] } {
  const recorded: string[] = [];
  const host = { recordPolicy: (name: string, decision: string, code?: string) => void recorded.push([name, decision, code].filter(Boolean).join(' ')) };
  try {
    return { code: undefined, recorded, resolved: authorizeUploadPaths(host, paths, root).resolved };
  } catch (error) {
    return { code: (error as { code?: string }).code, recorded };
  }
}

describe('authorizeUploadPaths', () => {
  it('resolves project-relative paths to regular files inside the root, keeps them as given, and records the allow', () => {
    const recorded: string[] = [];
    const host = { recordPolicy: (name: string, decision: string) => void recorded.push(`${name} ${decision}`) };
    const authorized = authorizeUploadPaths(host, ['fixtures/a.txt'], root);
    expect(authorized.given).toEqual(['fixtures/a.txt']);
    expect(authorized.resolved).toEqual([path.join(root, 'fixtures', 'a.txt')]);
    expect(recorded).toEqual(['upload.path allowed']);
  });

  it('refuses a path that leaves the project, by dots or by a symlink, and records the refusal', () => {
    for (const given of ['../outside.txt', outside, 'fixtures/link.txt']) {
      expect(authorize([given])).toMatchObject({ code: 'POLICY_DENIED', recorded: ['upload.path denied POLICY_DENIED'] });
    }
  });

  it('refuses hidden files and anything under a hidden directory', () => {
    expect(authorize(['.env']).code).toBe('POLICY_DENIED');
    expect(authorize(['fixtures/.hidden/b.txt']).code).toBe('POLICY_DENIED');
  });

  it('reports a missing file or a directory as a wrong argument, not a policy refusal, recording nothing', () => {
    expect(authorize(['fixtures/missing.txt'])).toEqual({ code: 'INVALID_ARGUMENT', recorded: [] });
    expect(authorize(['fixtures'])).toEqual({ code: 'INVALID_ARGUMENT', recorded: [] });
  });

  it('requires a non-empty list of non-empty strings, bounded', () => {
    expect(authorize([]).code).toBe('INVALID_ARGUMENT');
    expect(authorize(['fixtures/a.txt', '']).code).toBe('INVALID_ARGUMENT');
    expect(authorize('fixtures/a.txt').code).toBe('INVALID_ARGUMENT');
    expect(authorize(Array.from({ length: 17 }, () => 'fixtures/a.txt')).code).toBe('INVALID_ARGUMENT');
  });

  it('resolves a sample name to e2e\'s own file, outside the project, kept as given', () => {
    const recorded: string[] = [];
    const host = { recordPolicy: (name: string, decision: string) => void recorded.push(`${name} ${decision}`) };
    const authorized = authorizeUploadPaths(host, ['sample:photo.png', 'sample:document.pdf', 'sample:empty.txt'], root);
    expect(authorized.given).toEqual(['sample:photo.png', 'sample:document.pdf', 'sample:empty.txt']);
    const [png, pdf, empty] = authorized.resolved.map((file) => readFileSync(file));
    expect(png!.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(pdf!.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(pdf!.toString('latin1')).toMatch(/startxref\n\d+\n%%EOF\n$/);
    expect(empty!.byteLength).toBe(0);
    expect(authorized.resolved.every((file) => !file.startsWith(root))).toBe(true);
    expect(recorded).toEqual(['upload.path allowed']);
  });

  it('names the samples for an unknown sample, never for a missing project file a step may have named', () => {
    const host = { recordPolicy: () => undefined };
    expect(() => authorizeUploadPaths(host, ['sample:video.mp4'], root)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('sample:photo.png, sample:photo.jpg, sample:document.pdf') }),
    );
    expect(() => authorizeUploadPaths(host, ['fixtures/invoice.pdf'], root)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'no file at "fixtures/invoice.pdf" under the project root' }),
    );
  });

  it('checks every path before any is accepted', () => {
    expect(authorize(['fixtures/a.txt', '.env'])).toMatchObject({ code: 'POLICY_DENIED', recorded: ['upload.path denied POLICY_DENIED'] });
  });
});
