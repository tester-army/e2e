/**
 * A provider that serves downloads, against a real Chrome over CDP: the
 * browser saves the file to the provider's directory on its own disk, not
 * Playwright's on the runner's, and `waitForDownload` gets it back through
 * the provider's `read`. A hosted browser needs exactly this, since the
 * runner's directory does not exist on its machine; here the "remote" disk
 * is a local directory the provider reads.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { EngineFixtureContext, EngineHandle, OperationContext } from 'e2e/engine';
import { web as webEngine, surfaceOf, type BrowserProvider, type BrowserProviderScope, type Browser } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function operation(): OperationContext {
  return { timeoutMs: 15_000, signal: new AbortController().signal, runId: 'run-downloads', attemptId: 'a1', origin: 'test' };
}

function cleanup() {
  return { timeoutMs: 10_000, signal: new AbortController().signal };
}

const signal = () => new AbortController().signal;

describe.each<BrowserProviderScope>(['worker', 'attempt'])('downloads through a provider, %s scope', (scope) => {
  let app: FixtureApp;
  let artifactsDir: string | undefined;
  let remoteDisk: string | undefined;
  let chrome: RemoteChrome | undefined;
  let engine: EngineHandle | undefined;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await engine?.endAttempt!(cleanup());
    await engine?.dispose!(cleanup());
    await engine?.finish!({ runId: 'run-downloads', targetName: 'web', env: {}, log: () => undefined, ...cleanup() });
    if (chrome !== undefined) await closeRemoteChrome(chrome);
    if (artifactsDir !== undefined) rmSync(artifactsDir, { recursive: true, force: true });
    if (remoteDisk !== undefined) rmSync(remoteDisk, { recursive: true, force: true });
  });

  it.each([1, 2])('saves %i files on the browser disk through one trigger', async (count) => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-downloads-'));
    remoteDisk = mkdtempSync(path.join(tmpdir(), 'e2e-browser-disk-'));
    chrome = await launchRemoteChrome();
    const reads: { lease: string; file: string }[] = [];
    const provider: BrowserProvider = {
      name: 'toy-remote',
      scope,
      acquire: async () => ({ id: 'lease-1', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
      downloads: {
        dir: path.join(remoteDisk, 'downloads'),
        async read(lease, file) {
          reads.push({ lease: lease.id, file });
          return readFile(file);
        },
      },
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!({
      runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: { ...prepared?.env }, headed: false,
      workerSlot: 0, signal: signal(), log: () => undefined,
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, operation());
    const page = surfaceOf(engine)!.page();
    await page.evaluate((downloadCount) => {
      for (let index = 0; index < downloadCount; index += 1) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([`report body ${index}`]));
        link.download = `report-${index}.txt`;
        link.id = `download-${index}`;
        link.textContent = 'Download';
        document.body.append(link);
      }
    }, count);
    const attached: string[] = [];
    const browser = engine.fixtures!['browser']!({
      operation: () => operation(),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: (_kind: string, relative: string) => attached.push(relative),
    } as unknown as EngineFixtureContext) as Browser;

    let triggers = 0;
    const trigger = async (): Promise<void> => {
      triggers += 1;
      for (let index = 0; index < count; index += 1) await page.locator(`#download-${index}`).click();
    };
    const files = count === 1
      ? [await browser.waitForDownload(trigger)]
      : await browser.waitForDownloads(trigger, { count });
    expect(triggers).toBe(1);
    expect(files).toHaveLength(count);
    for (const [index, file] of files.entries()) {
      expect(file.suggestedFilename).toBe(`report-${index}.txt`);
      expect(path.isAbsolute(file.absolutePath)).toBe(true);
      expect(file.absolutePath).toBe(path.join(artifactsDir, file.path));
      expect(readFileSync(file.absolutePath, 'utf8')).toBe(`report body ${index}`);
      expect(file.path).toMatch(/^downloads\/\d{3}-report-\d\.txt$/);
    }
    expect(attached).toEqual(files.map(file => file.path));
    expect(reads).toHaveLength(count);
    expect(reads.every(read => read.lease === 'lease-1')).toBe(true);
    expect(reads.every(read => path.dirname(read.file) === path.join(remoteDisk!, 'downloads'))).toBe(true);
    expect(readdirSync(path.join(remoteDisk, 'downloads')).toSorted()).toEqual(reads.map(read => path.basename(read.file)).toSorted());
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s bounds a completed download whose provider read stalls', async (method) => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-stalled-'));
    remoteDisk = mkdtempSync(path.join(tmpdir(), 'e2e-browser-stalled-'));
    chrome = await launchRemoteChrome();
    let readSignal: AbortSignal | undefined;
    const provider: BrowserProvider = {
      name: 'stalled-remote', scope,
      acquire: async () => ({ id: 'stalled-lease', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
      downloads: {
        dir: path.join(remoteDisk, 'downloads'),
        async read(_lease, file, { signal: readCancellation }) {
          expect((await readFile(file)).toString()).toBe('stalled provider body');
          readSignal = readCancellation;
          return new Promise<Uint8Array>((_resolve, reject) => {
            if (readCancellation.aborted) reject(new Error('provider read canceled'));
            else readCancellation.addEventListener('abort', () => reject(new Error('provider read canceled')), { once: true });
          });
        },
      },
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, env: { ...prepared?.env }, headed: false, workerSlot: 0, signal: signal(), log: () => undefined });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(app.url, operation());
    const page = surfaceOf(engine)!.page();
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['stalled provider body']));
      link.download = 'report.txt';
      link.id = 'download';
      link.textContent = 'Download';
      document.body.append(link);
    });
    const attached: string[] = [];
    const browser = engine.fixtures!['browser']!({
      operation: (timeout?: number) => ({ ...operation(), timeoutMs: timeout ?? 15000 }),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target, fixture: (_name: string, target: object) => target,
      attachArtifact: (_kind: string, relative: string) => attached.push(relative),
    } as unknown as EngineFixtureContext) as Browser;
    const trigger = () => page.locator('#download').click();
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => ({ code: 'completed', message: '' }), (error: { code: string; message: string }) => error),
        new Promise<{ code: string; message: string }>((resolve) => { watchdog = setTimeout(() => resolve({ code: 'still pending', message: '' }), 1500); }),
      ]);
      expect(readSignal).toBeDefined();
      expect(result).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('did not finish') });
      expect(readSignal?.aborted).toBe(true);
      expect(attached).toEqual([]);
    } finally { clearTimeout(watchdog); }
  });
});
