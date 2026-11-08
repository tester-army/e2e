/** Chrome started outside Playwright keeps its back/forward cache enabled. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { EngineFixtureContext, OperationContext } from 'e2e/engine';
import { createBrowserFixture } from '../../src/browser.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { closeRemoteChrome, launchRemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

it('back, forward, and app.back finish when CDP restores a document from history', async () => {
  const app = await startFixtureApp();
  const remote = await launchRemoteChrome();
  const surface = new PlaywrightSurface({ connect: { cdpEndpoint: () => remote.endpoint } });
  const signal = new AbortController().signal;
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-history-'));
  const operation = (): OperationContext => ({ signal, timeoutMs: 2_000, runId: 'history', attemptId: 'a', origin: 'test' });
  const cleanup = { signal, timeoutMs: 5_000 };

  try {
    await surface.init({ runId: 'history', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'a', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });

    const fixtureContext = {
      targetName: 'web', signal, operation,
      timeouts: { test: 2_000, action: 2_000, assertion: 2_000 },
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: <T extends object>(target: T) => target,
      fixture: <T extends object>(_name: string, target: T) => target,
      attachArtifact: () => undefined,
      attachViewport: () => undefined,
      locator: () => { throw new Error('history test does not use locators'); },
      screen: () => { throw new Error('history test does not use screen queries'); },
    };

    // SAFETY: this test uses Vitest assertions, so its expectable callback needs no e2e matcher brand; all navigation/evaluation context members are supplied.
    const browser = createBrowserFixture(surface, fixtureContext as EngineFixtureContext);
    await browser.goto('/');
    await browser.evaluate('() => { window.historyMarker = "restored"; }');
    await browser.goto('/form');
    await browser.back();
    expect(await browser.title()).toBe('Fixture Home');
    expect(await browser.evaluate('() => window.historyMarker')).toBe('restored');
    await browser.forward();
    expect(await browser.title()).toBe('Fixture Form');
    await surface.back(operation());
    expect(await browser.title()).toBe('Fixture Home');
    await surface.endAttempt(cleanup);
  } finally {
    await surface.dispose(cleanup);
    await closeRemoteChrome(remote);
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  }
}, 30_000);
