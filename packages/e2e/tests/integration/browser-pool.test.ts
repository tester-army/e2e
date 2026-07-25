import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DriverContext, DriverSession } from '../../src/driver/index.js';
import { playwright } from '../../src/playwright/index.js';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';

function driverContext(app: FixtureApp, artifactsDir: string, attemptId: string): DriverContext {
  const operation = {
    signal: new AbortController().signal,
    timeoutMs: 30_000,
    runId: 'run-pool',
    attemptId,
  };
  return {
    target: { name: 'web', platform: 'web', browser: 'chromium' },
    targetId: 'web',
    app: {
      baseUrl: app.url,
      allowedOrigins: [new URL(app.url).origin],
      environment: 'test',
      allowProduction: false,
      testIdAttribute: 'data-testid',
    },
    artifactsDir,
    runId: 'run-pool',
    attemptId,
    operation,
    launchOptions: { headed: false },
  };
}

describe('playwright browser pool', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-pool-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('shares one browser across sessions without coupling their lifecycles', async () => {
    const driver = playwright();
    const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000, runId: 'run-pool', attemptId: 'a' };

    let first: DriverSession | null = null;
    let second: DriverSession | null = null;
    try {
      first = await driver.launch(driverContext(app, artifactsDir, 'a1'));
      second = await driver.launch(driverContext(app, artifactsDir, 'a2'));

      const firstRuntime = await first.runtime(driverContext(app, artifactsDir, 'a1').operation);
      const secondRuntime = await second.runtime(driverContext(app, artifactsDir, 'a2').operation);
      expect(firstRuntime.browser?.version).toBe(secondRuntime.browser?.version);

      // Closing one session must not tear down the shared browser process.
      await first.close(cleanup);
      first = null;
      await second.app.open('/', driverContext(app, artifactsDir, 'a2').operation);
      const title = await second.web?.title(driverContext(app, artifactsDir, 'a2').operation);
      expect(title).toBe('Fixture Home');
    } finally {
      await first?.close(cleanup);
      await second?.close(cleanup);
      await driver.dispose?.();
    }
  });

  it('relaunches after dispose and stays idempotent', async () => {
    const driver = playwright();
    const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000, runId: 'run-pool', attemptId: 'b' };

    const before = await driver.launch(driverContext(app, artifactsDir, 'b1'));
    await before.close(cleanup);
    await driver.dispose?.();
    await driver.dispose?.();

    const after = await driver.launch(driverContext(app, artifactsDir, 'b2'));
    try {
      await after.app.open('/', driverContext(app, artifactsDir, 'b2').operation);
      const title = await after.web?.title(driverContext(app, artifactsDir, 'b2').operation);
      expect(title).toBe('Fixture Home');
    } finally {
      await after.close(cleanup);
      await driver.dispose?.();
    }
  });
});
