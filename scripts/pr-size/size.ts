/**
 * How big a pull request is, for the `size:*` labels (`label.ts`). Counts
 * added plus deleted lines, leaving out tests, fixtures, snapshots, and the
 * lockfile unless a PR changes nothing else.
 */

import { matchesGlob } from 'node:path';

export interface SizeLabel {
  name: string;
  /** Largest effective line count that still gets this label. */
  max: number;
  color: string;
}

export const SIZE_LABELS: readonly SizeLabel[] = [
  { name: 'size:XS', max: 9, color: '0e8a16' },
  { name: 'size:S', max: 29, color: '5ebd3e' },
  { name: 'size:M', max: 99, color: 'fbca04' },
  { name: 'size:L', max: 499, color: 'fe7d37' },
  { name: 'size:XL', max: 999, color: 'd93f0b' },
  { name: 'size:XXL', max: Infinity, color: 'b60205' },
];

const EXCLUDED: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.e2e.*',
  '**/tests/**',
  '**/tests-*/**',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/*-snapshots/**',
  '**/fixtures/**',
  'pnpm-lock.yaml',
];

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
}

export interface Size {
  total: number;
  counted: number;
  label: SizeLabel;
}

/** Whether a path is left out of the count. */
export function isExcluded(path: string): boolean {
  return EXCLUDED.some((glob) => matchesGlob(path, glob));
}

/** Sizes a PR by its counted lines, or by all of them when every changed file is excluded. */
export function sizeOf(files: readonly ChangedFile[]): Size {
  const lines = ({ additions, deletions }: ChangedFile) => additions + deletions;
  const total = files.reduce((sum, file) => sum + lines(file), 0);
  const counted = files.filter(({ filename }) => !isExcluded(filename)).reduce((sum, file) => sum + lines(file), 0);
  const effective = counted === 0 ? total : counted;
  const label = SIZE_LABELS.find(({ max }) => effective <= max);
  if (label === undefined) throw new Error(`no size label for ${effective} lines`);
  return { total, counted, label };
}
