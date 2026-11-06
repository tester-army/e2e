/**
 * The readers a document keeps: a read sends only a small call once the
 * preload installed them, a document the preload never ran in gets them with
 * its first read, and a swipe the element already takes skips the
 * actionability wait.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readerCall, readerInstallCall, READERS_INIT_SCRIPT } from '../../src/in-page/readers.ts';
import { byTestId, startWebSession, type WebSession } from '../helpers/web-session.ts';
import { BidiConnection } from '../../src/driver/connection.ts';

/** Records every page function the driver calls; with `dropReaders`, the readers' preload installs nothing. */
function recordCalls(dropReaders: boolean): string[] {
  const declarations: string[] = [];
  const send = BidiConnection.prototype.send;
  vi.spyOn(BidiConnection.prototype, 'send').mockImplementation(function (this: BidiConnection, method, params) {
    const declaration = (params as { functionDeclaration?: unknown }).functionDeclaration;
    if (method === 'script.addPreloadScript' && dropReaders && typeof declaration === 'string' && declaration.includes(READERS_INIT_SCRIPT)) {
      return send.call(this, method, { ...params, functionDeclaration: '() => {}' } as never);
    }
    if (method === 'script.callFunction' && typeof declaration === 'string') declarations.push(declaration);
    return send.call(this, method, params);
  });
  return declarations;
}

const sessions: WebSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe('document readers', () => {
  it('reads through the copy the preload installed, sending only a small call', async () => {
    const declarations = recordCalls(false);
    const page = await startWebSession();
    sessions.push(page);
    await page.setContent('<button data-testid="go">Go</button>');
    declarations.length = 0;
    expect(await page.locate(byTestId('go'))).toHaveLength(1);
    expect(declarations).toEqual([readerCall('locate')]);
  });

  it('installs the readers with the first read of a document the preload never ran in, and keeps them', async () => {
    const declarations = recordCalls(true);
    const page = await startWebSession();
    sessions.push(page);
    await page.setContent('<button data-testid="go">Go</button>');
    declarations.length = 0;
    expect(await page.locate(byTestId('go'))).toHaveLength(1);
    const installs = declarations.filter((declaration) => declaration === readerInstallCall('locate'));
    expect(installs).toHaveLength(1);
    expect(declarations.indexOf(readerCall('locate'))).toBeLessThan(declarations.indexOf(installs[0]!));
    declarations.length = 0;
    expect(await page.locate(byTestId('go'))).toHaveLength(1);
    expect(declarations).toEqual([readerCall('locate')]);
  });

  it('locates nothing in a document without a root, as one a navigation just opened', async () => {
    const page = await startWebSession();
    sessions.push(page);
    await page.setContent('<button data-testid="go">Go</button>');
    await page.browser.evaluate(() => { document.documentElement.remove(); return null; });
    expect(await page.locate(byTestId('go'))).toEqual([]);
  });

  it('wheels an element it hits at once, without waiting for it to hold still', async () => {
    const declarations = recordCalls(false);
    const page = await startWebSession();
    sessions.push(page);
    await page.setContent('<div data-testid="feed" style="height: 200px; overflow: auto"><div style="height: 2000px">rows</div></div>');
    const [feed] = await page.locate(byTestId('feed'));
    declarations.length = 0;
    await page.engine.perform!(feed!.ref, { kind: 'swipe', direction: 'down' }, page.op());
    expect(declarations.some((declaration) => declaration.includes('actionPoint'))).toBe(false);
    await expect.poll(() => page.browser.evaluate(() => document.querySelector('[data-testid="feed"]')!.scrollTop)).toBe(100);
  });

  it('waits for a covered element to become actionable before wheeling it', async () => {
    const declarations = recordCalls(false);
    const page = await startWebSession();
    sessions.push(page);
    let releaseCover!: () => void;
    const coverHeld = new Promise<void>((resolve) => { releaseCover = resolve; });
    page.serve('/cover-gone', (_request, response) => { void coverHeld.then(() => response.end('gone')); });
    await page.setContent(`
      <div data-testid="feed" style="height: 200px; overflow: auto"><div style="height: 2000px">rows</div></div>
      <div id="cover" style="position: fixed; inset: 0; background: white"></div>
      <script>fetch('/cover-gone').then(() => document.getElementById('cover').remove());</script>`);
    const [feed] = await page.locate(byTestId('feed'));
    declarations.length = 0;
    const wheeled = page.engine.perform!(feed!.ref, { kind: 'swipe', direction: 'down' }, page.op());
    // The cover stays until the wheel is waiting on it, so the wait is what this sees.
    await expect.poll(() => declarations.some((declaration) => declaration.includes('actionPoint'))).toBe(true);
    releaseCover();
    await wheeled;
    await expect.poll(() => page.browser.evaluate(() => document.querySelector('[data-testid="feed"]')!.scrollTop)).toBe(100);
  });
});
