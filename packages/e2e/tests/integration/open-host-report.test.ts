/** Hosted sessions expose their trace report after close without transferring ownership. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { openHost, sdkExpect, type GadgetFixtures } from '../helpers/open-host.ts';
import { assertValidReport } from '../helpers/report-schema.ts';

describe('openHost: report', { timeout: 60_000 }, () => {
  it('returns independent closed reports that remain stable across host reuse', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-report-'));
    try {
      const fake = createFakeEngine({ fixtures: true, artifacts: true });
      const opened = await openHost<GadgetFixtures>({
        cwd: dir, env: {},
        config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: FAKE_APP }] },
      });
      try {
        const session = await opened.openSession({ name: 'snapshot' });
        try {
          expect(session.report()).toBeUndefined();
          await session.fixtures.app.screenshot();
          await session.fixtures.gadget.dropFile();
          sdkExpect.soft(1).toBe(2);
          expect(await session.close()).toHaveLength(1);
          const report = session.report()!;
          assertValidReport(report);
          expect(report.run.status).toBe('failed');
          const attempt = report.run.results[0]!.attempts[0]!;
          expect(attempt.id).toBe(session.attemptId);
          expect(attempt.artifacts.length).toBeGreaterThan(0);
          for (const artifact of attempt.artifacts) {
            expect(readFileSync(path.join(dir, '.e2e', 'results', artifact.path!)).length).toBe(artifact.size);
            expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
          }
          const original = JSON.stringify(report);
          report.run.usage.modelTokens = 999;
          report.run.targets[0]!.engine.name = 'caller mutation';
          attempt.artifacts[0]!.size = 999;
          expect(JSON.stringify(session.report())).toBe(original);
          const next = await opened.openSession({ name: 'next attempt' });
          try {
            expect(next.report()).toBeUndefined();
            expect(await next.close()).toEqual([]);
            expect(next.report()!.run.results[0]!.attempts[0]!.id).toBe(next.attemptId);
            expect(JSON.stringify(session.report())).toBe(original);
          } finally {
            await next.close();
          }
          expect(await session.close()).toHaveLength(1);
        } finally {
          await session.close();
        }
      } finally {
        await opened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the trace write fails', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-host-report-'));
    try {
      const fake = createFakeEngine();
      const opened = await openHost({
        cwd: dir, env: {},
        config: { targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: FAKE_APP }] },
      });
      try {
        const session = await opened.openSession({ name: 'failed write' });
        try {
          mkdirSync(session.tracePath);
          const failures = await session.close();
          expect(failures).toHaveLength(1);
          expect(session.report()).toBeUndefined();
          expect(await session.close()).toEqual(failures);
        } finally {
          await session.close();
        }
      } finally {
        await opened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
