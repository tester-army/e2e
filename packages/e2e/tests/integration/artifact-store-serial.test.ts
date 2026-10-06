/**
 * The ArtifactStore seam across a serial group, end to end through the
 * runner: the group-owned shared video reaches the store (it is registered on
 * the group's collector, not a member's), and every artifact a member
 * produces is identified to the store by the GROUP attempt — the attempt the
 * report files it under — never by a member's private attempt id that no
 * report record carries. Both refs land on the group attempt's record.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactStore, StoredArtifact } from '../../src/types.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const SERIAL_SUITE = `import { test, expect } from 'e2e';

test.describe('wizard', { serial: true }, () => {
  test('step 1', async ({ app, screen }) => {
    await app.open();
    await screen.getByRole('button', { name: 'Increment' }).tap();
    await expect(screen.getByRole('status')).toHaveText('1');
    await app.screenshot('after-step-1');
  });

  test('step 2 shares state', async ({ app, screen }) => {
    await screen.getByRole('button', { name: 'Increment' }).tap();
    await app.screenshot('after-step-2');
  });
});
`;

function capturing(): ArtifactStore & { puts: StoredArtifact[] } {
  const puts: StoredArtifact[] = [];
  return {
    puts,
    async put(artifact) {
      puts.push(artifact);
      return { ref: `store://${artifact.kind}/${artifact.sha256.slice(0, 12)}` };
    },
  };
}

describe('ArtifactStore across a serial group', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/wizard.e2e.ts': SERIAL_SUITE });
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('uploads the group-owned video and identifies member artifacts by the group attempt', async () => {
    const store = capturing();
    const outcome = await runExisting(project, {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        cache: 'off' as const,
        video: 'on',
        artifacts: { store },
      },
    });
    expect(outcome.status).toBe('passed');

    const groups = outcome.report.run.serialGroups;
    expect(groups).toHaveLength(1);
    const groupAttempt = groups[0]!.attempts[0]!;

    // Devin #1: the shared video is a group-owned artifact; it must reach the
    // store, and its ref must land on the group attempt's record.
    const videoPuts = store.puts.filter((put) => put.kind === 'video');
    expect(videoPuts.length).toBeGreaterThan(0);
    for (const put of videoPuts) expect(put.attemptId).toBe(groupAttempt.id);
    const videoRecords = groupAttempt.artifacts.filter((artifact) => artifact.kind === 'video');
    expect(videoRecords.length).toBeGreaterThan(0);
    for (const record of videoRecords) {
      expect(record.ref).toBeDefined();
      expect(videoPuts.map((put) => `store://video/${put.sha256.slice(0, 12)}`)).toContain(record.ref);
    }

    // Devin #2: member screenshots are filed under the group attempt in the
    // report, so the store must see that attempt id — not a private member id.
    const shots = store.puts.filter((put) => put.kind === 'screenshot');
    expect(shots).toHaveLength(2);
    for (const put of shots) expect(put.attemptId).toBe(groupAttempt.id);
    const shotRecords = groupAttempt.artifacts.filter((artifact) => artifact.kind === 'screenshot');
    expect(shotRecords).toHaveLength(2);
    for (const record of shotRecords) {
      expect(record.ref).toMatch(/^store:\/\/screenshot\//);
      expect(existsSync(path.join(project.dir, '.e2e', 'results', record.path!))).toBe(true);
      expect(record.size).toBeGreaterThan(0);
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    assertValidReport(outcome.report);

    // Every store identity is a real report identity.
    const reportedIds = new Set(groups.flatMap((group) => group.attempts.map((attempt) => attempt.id)));
    for (const put of store.puts) expect(reportedIds.has(put.attemptId)).toBe(true);
    for (const put of store.puts) expect(put.runId).toBe(outcome.report.run.id);
  }, 120_000);
});
