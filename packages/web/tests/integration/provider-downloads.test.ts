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
import { web as webEngine, surfaceOf, type BrowserProvider, type BrowserProviderScope, type Web } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { noSecrets } from '../helpers/secrets.ts';

function operation(): OperationContext {
  return { timeoutMs: 15_000, signal: new AbortController().signal, runId: 'run-downloads', attemptId: 'a1', origin: 'test' };
}

function cleanup() {
  return { timeoutMs: 10_000, signal: new AbortController().signal };
}

const signal = () => new AbortController().signal;

describe.each<BrowserProviderScope>(['worker', 'attempt'])('downloads through a provider, %s scope', (scope) => {
  let app: FixtureApp;
  let artifactsDir: string;
  let remoteDisk: string;
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
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(remoteDisk, { recursive: true, force: true });
  });

  it('saves the file on the browser\'s disk and reads it back through the provider', async () => {
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
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), slots: 1, env: {}, signal: signal(), log: () => undefined });
    await engine.init!({
      runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: { ...prepared?.env }, headed: false,
      workerSlot: 0, signal: signal(), log: () => undefined,
    });
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets });
    await engine.session!.open!(`${app.url}/login`, operation());
    const page = surfaceOf(engine)!.page();
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['report body']));
      link.download = 'report.txt';
      link.id = 'download';
      link.textContent = 'Download';
      document.body.append(link);
    });
    const attached: string[] = [];
    const web = engine.fixtures!['web']!({
      operation: () => operation(),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: (_kind: string, relative: string) => attached.push(relative),
    } as unknown as EngineFixtureContext) as Web;

    const file = await web.waitForDownload(() => page.locator('#download').click());

    expect(file.suggestedFilename).toBe('report.txt');
    expect(readFileSync(path.join(artifactsDir, file.path), 'utf8')).toBe('report body');
    expect(attached).toEqual([file.path]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.lease).toBe('lease-1');
    expect(path.dirname(reads[0]!.file)).toBe(path.join(remoteDisk, 'downloads'));
    expect(readdirSync(path.join(remoteDisk, 'downloads'))).toEqual([path.basename(reads[0]!.file)]);
  });
});
