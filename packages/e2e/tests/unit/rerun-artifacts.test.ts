/**
 * The artifact tree a `--last-failed` rerun starts from: the files the report
 * it reruns names stay byte for byte, everything else goes, and the rerun's
 * own attempts get a `rerun-<n>` directory no earlier run wrote into.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimRerunDir, pruneArtifacts } from '../../src/run/artifacts.ts';

let root: string;

beforeEach(() => {
  root = path.join(mkdtempSync(path.join(os.tmpdir(), 'e2e-rerun-artifacts-')), 'artifacts');
});

afterEach(() => {
  rmSync(path.dirname(root), { recursive: true, force: true });
});

/** Writes a file at a report path under the root, with the path as its content. */
function plant(reportPath: string): void {
  const file = path.join(root, ...reportPath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, reportPath);
}

/** Every file under the root, as report paths, sorted. */
function tree(): string[] {
  return (readdirSync(root, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .toSorted();
}

describe('pruneArtifacts', () => {
  it('keeps exactly the files the report names, untouched, and removes the rest and the directories left empty', async () => {
    const kept = ['web/a/default/attempt-0/screenshots/001-landing.png', 'web/b/default/attempt-0/video/video.webm', 'rerun-1/web/b/default/attempt-0/failure/screen.txt'];
    const dropped = ['web/a/default/attempt-0/stray.log', 'web/c/default/attempt-0/video/video.webm', 'web/sessions/0192/screen.png', 'top-level.txt'];
    for (const file of [...kept, ...dropped]) plant(file);

    await pruneArtifacts(root, new Set(kept));

    expect(tree()).toEqual(kept.toSorted());
    for (const file of kept) expect(readFileSync(path.join(root, file), 'utf8')).toBe(file);
    expect(existsSync(path.join(root, 'web', 'c'))).toBe(false);
    expect(existsSync(path.join(root, 'web', 'sessions'))).toBe(false);
  });

  it('empties the tree when the report names nothing, and accepts a tree that is not there', async () => {
    plant('web/a/default/attempt-0/screenshots/001.png');
    await pruneArtifacts(root, new Set());
    expect(tree()).toEqual([]);
    rmSync(root, { recursive: true });
    await expect(pruneArtifacts(root, new Set(['web/a.png']))).resolves.toBeUndefined();
  });
});

describe('claimRerunDir', () => {
  it('claims rerun-1 in a tree without one, then the number past the highest there, never one that exists', async () => {
    plant('web/a/default/attempt-0/x.png');
    expect(await claimRerunDir(root)).toBe('rerun-1');
    expect(await claimRerunDir(root)).toBe('rerun-2');
    // An earlier rerun's directory pruned away does not bring its number back.
    rmSync(path.join(root, 'rerun-1'), { recursive: true });
    expect(await claimRerunDir(root)).toBe('rerun-3');
    // Names that only look alike, a target called that way among them, do not count.
    mkdirSync(path.join(root, 'rerun-07'));
    mkdirSync(path.join(root, 'rerun-x'));
    expect(await claimRerunDir(root)).toBe('rerun-4');
    expect(readdirSync(root).toSorted()).toEqual(['rerun-07', 'rerun-2', 'rerun-3', 'rerun-4', 'rerun-x', 'web']);
  });

  it('creates the root when the tree is not there', async () => {
    expect(await claimRerunDir(root)).toBe('rerun-1');
    expect(existsSync(path.join(root, 'rerun-1'))).toBe(true);
  });
});
