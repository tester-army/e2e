import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExcluded, sizeOf, type ChangedFile } from './size.ts';

const file = (filename: string, additions: number, deletions = 0): ChangedFile => ({ filename, additions, deletions });

test('leaves tests, fixtures, snapshots, and the lockfile out of the count', () => {
  for (const path of [
    'packages/e2e/tests/unit/config.test.ts',
    'packages/web/src/locator.test.ts',
    'apps/testbed/tests-agent/login.e2e.ts',
    'apps/testbed/tests/visual.e2e.ts-snapshots/home.png',
    'packages/e2e/schema/fixtures/report.json',
    'pnpm-lock.yaml',
  ]) {
    assert.equal(isExcluded(path), true, path);
  }
  for (const path of ['packages/e2e/src/run/fixture.ts', 'packages/e2e/src/run/execute.ts', 'docs/guide.mdx', 'packages/web/pnpm-lock.yaml.md']) {
    assert.equal(isExcluded(path), false, path);
  }
});

test('sizes a mixed PR by its non-test lines', () => {
  const size = sizeOf([file('packages/e2e/src/a.ts', 12, 3), file('packages/e2e/tests/unit/a.test.ts', 400), file('pnpm-lock.yaml', 900, 200)]);
  assert.deepEqual({ total: size.total, counted: size.counted, label: size.label.name }, { total: 1515, counted: 15, label: 'size:S' });
});

test('sizes a test-only PR by all of its lines', () => {
  assert.equal(sizeOf([file('packages/e2e/tests/unit/a.test.ts', 120, 30)]).label.name, 'size:L');
});

test('puts each boundary in the right label', () => {
  const labels = [0, 9, 10, 29, 30, 99, 100, 499, 500, 999, 1000].map((lines) => sizeOf([file('src/a.ts', lines)]).label.name);
  assert.deepEqual(labels, ['size:XS', 'size:XS', 'size:S', 'size:S', 'size:M', 'size:M', 'size:L', 'size:L', 'size:XL', 'size:XL', 'size:XXL']);
});
