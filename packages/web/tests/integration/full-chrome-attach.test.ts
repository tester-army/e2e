/**
 * Attaching over CDP to the pinned full Chrome, not the headless shell: its
 * browser UI targets and component extension service workers sit beside the
 * tab, as in a user's own Chrome, and `attachBrowser` and
 * `web({ connect })` still navigate and locate. Skipped when the headed build
 * is not installed (`npx @e2e-dev/web install chromium --headed`).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineHandle, OperationContext } from 'e2e/engine';
import { attachBrowser, web } from '../../src/index.ts';
import { browserExecutable } from '../../src/install/provision.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** The pinned full Chrome's executable, when it is installed. */
async function installedChrome(): Promise<string | undefined> {
  try {
    const executable = await browserExecutable('chromium', true);
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

const fullChrome = await installedChrome();

describe.skipIf(fullChrome === undefined)('attaching to the pinned full Chrome over CDP', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let endpoint: string;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome({ fullChrome: fullChrome! });
    endpoint = `http://${new URL(chrome.endpoint).host}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-full-chrome-artifacts-'));
  }, 60_000);

  afterAll(async () => {
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    await app?.close();
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('lists browser UI targets beside the tab', async () => {
    const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as { type: string }[];
    expect(targets.map(({ type }) => type)).toEqual(expect.arrayContaining(['page', 'browser_ui']));
  });

  it('navigates and locates through attachBrowser', async () => {
    await using attached = await attachBrowser(endpoint, { timeout: 30_000 });
    await attached.browser.goto(`${app.url}/`);
    expect(await attached.browser.url()).toBe(`${app.url}/`);
    expect(await attached.screen.getByRole('heading', 'Home').count()).toBe(1);
  }, 60_000);

  it('navigates and locates through web({ connect })', async () => {
    const engine: EngineHandle = web({ connect: { cdpEndpoint: () => chrome.endpoint } });
    const cleanup = (): EngineCleanupContext => ({ signal: new AbortController().signal, timeoutMs: 30_000 });
    const operation: OperationContext = { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-full', attemptId: 'a1', origin: 'test' };
    await engine.init!({
      runId: 'run-full',
      targetName: 'web',
      projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname },
      env: {},
      headed: false,
      workerSlot: 0,
      log: () => undefined,
      signal: new AbortController().signal,
    });
    try {
      await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/`, operation);
      const headings = await engine.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'heading', exact: true } } }, operation);
      expect(headings[0]?.name).toBe('Home');
      expect((await engine.observe!(operation)).location).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
    expect(chrome.proc.exitCode).toBeNull();
  }, 60_000);
});
