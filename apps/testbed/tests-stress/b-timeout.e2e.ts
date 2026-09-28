import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const MARKER = path.join(tmpdir(), 'e2e-stress-flaky-marker');

test('times out after one second', { timeout: 1_000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});

test('flakes once then passes', { retries: 1 }, async ({ app, screen }) => {
  await app.open();
  if (!existsSync(MARKER)) {
    writeFileSync(MARKER, '1');
    throw new Error('first attempt fails on purpose');
  }
  rmSync(MARKER, { force: true });
  await expect(screen.getByRole('heading', { name: 'Playground' })).toBeVisible();
});

test('fails on every attempt', { retries: 1 }, async ({ app }) => {
  await app.open();
  throw new Error('deterministic failure, retried once');
});
