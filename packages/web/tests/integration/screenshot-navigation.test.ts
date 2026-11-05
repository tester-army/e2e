/**
 * An artifact screenshot taken while the page navigates captures the
 * document showing, masked, instead of failing because the document its
 * masks were resolved in went away.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import type { OperationContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { decodePng } from '../helpers/png.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** The race Playwright reports when the document a capture's masks were resolved in is replaced. */
const RACE = 'page.screenshot: Execution context was destroyed, most likely because of a navigation';

/** `/hop?n=<n>` holds a white password field on a white page and moves on to the next hop a moment after it loads, up to 40. */
function startHoppingServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const hop = Number(new URL(request.url ?? '/', 'http://host').searchParams.get('n') ?? '0');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Hop ${hop}</title>
      <style>body { margin: 0; background: #fff; } input { position: absolute; left: 20px; top: 20px; width: 120px; height: 40px; border: 0; background: #fff; color: #fff; }</style>
      <input type="password" value="hunter22">
      <script>if (${hop} < 40) setTimeout(() => { location.href = '/hop?n=${hop + 1}'; }, 1);</script>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

describe('surface.screenshot while navigating', () => {
  const surface = new PlaywrightSurface({ viewport: { width: 320, height: 200 } });
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-screenshot-navigation-'));
  const signal = new AbortController().signal;
  const operation = (timeoutMs = 10_000): OperationContext => ({ signal, timeoutMs, runId: 'shots', attemptId: 'shots', origin: 'test' });
  let server: Server;
  let origin: string;
  let page: Page;

  /** Takes a screenshot and asserts the password field is covered by the opaque mask, not left white. */
  const expectMaskedShot = async (label: string): Promise<void> => {
    const relative = await surface.screenshot(label, operation());
    const image = decodePng(readFileSync(path.join(projectRoot, relative)));
    expect(image.pixelAt(80, 40)).toEqual([0, 0, 0, 255]);
    expect(image.pixelAt(200, 150)).toEqual([255, 255, 255, 255]);
  };

  beforeAll(async () => {
    ({ server, origin } = await startHoppingServer());
    await surface.init({ runId: 'shots', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'shots', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('captures each screenshot, masked, while the page hops between documents', async () => {
    await page.goto(`${origin}/hop?n=0`);
    for (let shot = 0; shot < 10; shot += 1) await expectMaskedShot(`hop-${shot}`);
  });

  it('takes the capture again, masked, of the document that replaced the one its masks were resolved in', async () => {
    await page.goto(`${origin}/hop?n=40`);
    const capture = vi.spyOn(page, 'screenshot').mockImplementationOnce(async () => {
      await page.goto(`${origin}/hop?n=40`);
      throw new Error(RACE);
    });
    await expectMaskedShot('replaced');
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('fails with the race itself when no document was replaced, tried once', async () => {
    await page.goto(`${origin}/hop?n=40`);
    const capture = vi.spyOn(page, 'screenshot').mockRejectedValueOnce(new Error(RACE));
    await expect(surface.screenshot('unreplaced', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('times out when the page replaces its document during every capture until the step deadline', async () => {
    await page.goto(`${origin}/hop?n=40`);
    vi.spyOn(page, 'screenshot').mockImplementation(async () => {
      await page.goto(`${origin}/hop?n=40`);
      throw new Error(RACE);
    });
    await expect(surface.screenshot('restless', operation(1_000))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: false });
  });

  it('keeps any other capture failure an engine failure, tried once', async () => {
    await page.goto(`${origin}/hop?n=40`);
    const capture = vi.spyOn(page, 'screenshot')
      .mockRejectedValueOnce(new Error('Target page, context or browser has been closed'));
    await expect(surface.screenshot('closed', operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
