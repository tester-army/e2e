/** Bounded owner for technical mask regressions, independent of Vitest's timeout. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, BrowserServer } from 'playwright-core';
import type { OperationContext } from 'e2e/engine';
import { browserType, type BrowserConnection, type BrowserName } from '../../src/browser-connection.ts';
import { PlaywrightSurface } from '../../src/surface.ts';
import { ignoreTrace, noSecrets } from './secrets.ts';

export type MaskStep = <T>(work: (operation: OperationContext) => Promise<T>, milliseconds?: number) => Promise<T>;

/** A race only bounds waiting; the owner separately closes transports/processes. */
export async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mask fixture deadline')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

let tainted = false;

/** Own the real surface connection without replacing any method or capture behavior. */
export async function withMaskOwner(
  browserName: BrowserName,
  endpoint: string | undefined,
  closeHttp: () => Promise<void>,
  run: (surface: PlaywrightSurface, directory: string, step: MaskStep) => Promise<void>,
): Promise<void> {
  if (tainted) { await closeHttp(); throw new Error('previous mask fixture did not confirm cleanup'); }
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-js-mask-'));
  const abort = new AbortController();
  const surface = new PlaywrightSurface({ browser: browserName, viewport: { width: 390, height: 844 } });
  // The actual source-owned connection offers acquire's real launch thunk.
  // Pre-acquiring it avoids any SDK launch monkeypatch or production seam.
  const connection = Reflect.get(surface, 'connection') as BrowserConnection;
  let server: BrowserServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stopping: Promise<void> | undefined;
  let cleanupFailed = false;
  let launchPending = false;
  let connectPending = false;
  const cleanupOperation = () => ({ signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 });
  const closeServer = async (owned: BrowserServer) => {
    try {
      const child = owned.process();
      if (!child?.pid || !['darwin', 'linux'].includes(process.platform)) throw new Error('owned browser group cannot be confirmed');
      // Kill while the exact returned leader still anchors its group; after
      // exit only probe absence, never signal a potentially reused PGID.
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      const deadline = Date.now() + 1_000;
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error('owned browser group absence was not confirmed');
        await delay(20);
      }
    } finally { await bounded(owned.close(), 1_000); }
  };
  const stop = () => stopping ??= (async () => {
    abort.abort();
    // A not-yet-returned owner cannot be confirmed closed. Its late callback
    // still closes it; taint prevents another case from overlapping it.
    if (launchPending || connectPending) cleanupFailed = true;
    try {
      try { if (context !== undefined) await bounded(context.close(), 2_000); }
      catch { cleanupFailed = true; }
      finally {
        const closed = await Promise.allSettled([
          browser === undefined ? Promise.resolve() : bounded(browser.close(), 2_000),
          bounded(surface.dispose(cleanupOperation()), 3_000),
        ]);
        if (closed.some((result) => result.status === 'rejected')) cleanupFailed = true;
      }
    } finally {
      try { if (server !== undefined) await closeServer(server); }
      catch { cleanupFailed = true; }
      finally {
        try { await bounded(closeHttp(), 1_000); }
        catch { cleanupFailed = true; }
      }
    }
  })();
  const lifetime = setTimeout(() => { void stop(); }, 18_000);
  const step: MaskStep = async (work, milliseconds = 5_000) => {
    if (abort.signal.aborted) throw new Error('mask fixture cancelled');
    const operationAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, operationAbort.signal]);
    const operation: OperationContext = { runId: 'mask-js', attemptId: 'mask-js', origin: 'test', signal, timeoutMs: milliseconds };
    const expired = setTimeout(() => { operationAbort.abort(); void stop(); }, milliseconds);
    try { return await bounded(work(operation), milliseconds); }
    catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === 'mask fixture deadline')) { operationAbort.abort(); await stop(); }
      throw error;
    }
    finally { operationAbort.abort(); clearTimeout(expired); }
  };
  let failure: { cause: unknown } | undefined;
  try {
    if (endpoint === undefined) {
      const env = Object.fromEntries(['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
      launchPending = true;
      const launching = browserType(browserName).launchServer({ headless: true, host: '127.0.0.1', timeout: 5_000, env, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      void launching.then(async (late) => { launchPending = false; if (abort.signal.aborted) await closeServer(late); }, () => { launchPending = false; }).catch(() => { cleanupFailed = true; tainted = true; });
      server = await step(() => launching);
      endpoint = server.wsEndpoint();
    }
    const target = new URL(endpoint);
    if (target.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('mask fixture requires an owned loopback browser');
    connectPending = true;
    const connecting = connection.acquire(browserName, false, 5_000, () => browserType(browserName).connect(target.href, { timeout: 5_000 }));
    void connecting.then(async (late) => { connectPending = false; if (abort.signal.aborted) await bounded(late.close(), 2_000); }, () => { connectPending = false; }).catch(() => { cleanupFailed = true; tainted = true; });
    browser = await step(() => connecting);
    await step((operation) => surface.init({ runId: 'mask-js', targetName: browserName, projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: {}, headed: false, workerSlot: 0, signal: operation.signal, log: () => undefined }));
    await step((operation) => surface.startAttempt({ attemptId: 'mask-js', artifactsDir: directory, signal: operation.signal, resolveSecret: noSecrets, ...ignoreTrace }));
    context = surface.requireContext();
    await step(() => run(surface, directory, step), 12_000);
  } catch (cause) { failure = { cause }; }
  finally {
    await stop();
    clearTimeout(lifetime);
    rmSync(directory, { recursive: true, force: true });
  }
  if (cleanupFailed) { tainted = true; throw new Error('mask fixture cleanup could not be confirmed'); }
  if (failure !== undefined) throw failure.cause;
}
