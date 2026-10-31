/** Coordinate double-clicks through the browser fixture and native DOM events. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from 'e2e/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

describe('mouse double-click input', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-mouse-double-click-'));
  const signal = new AbortController().signal;
  let browser: Browser;
  beforeAll(async () => {
    await surface.init({ runId: 'mouse', targetName: 'web', projectRoot, app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });
  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'mouse', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    const page = await surface.ensurePage();
    await page.setContent('<h1 id="events"></h1>');
    browser = createBrowserFixture(surface, {
      app: { resolveUrl: (url: string) => url },
      operation: (timeoutMs = 5000) => ({ signal, timeoutMs, runId: 'mouse', attemptId: 'mouse', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });
  afterEach(async () => { await surface.endAttempt({ signal, timeoutMs: 5000 }); });
  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5000 });
    rmSync(projectRoot, { recursive: true, force: true });
  });
  it('sends a trusted double-click with click count two at viewport coordinates', async () => {
    await browser.evaluate(() => {
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick'] as const) {
        document.addEventListener(type, event => {
          document.querySelector('#events')!.textContent += `${event.type}|${event.isTrusted}|${event.button}|${event.detail}|${event.clientX},${event.clientY};`;
        });
      }
      return null;
    });
    await browser.mouse.dblclick(120, 80);
    expect(await browser.evaluate(() => document.querySelector('#events')!.textContent)).toBe(
      'mousedown|true|0|1|120,80;mouseup|true|0|1|120,80;click|true|0|1|120,80;' +
      'mousedown|true|0|2|120,80;mouseup|true|0|2|120,80;click|true|0|2|120,80;dblclick|true|0|2|120,80;',
    );
  });
});
