/**
 * A `goto` whose response turns into a download fails as Playwright's does,
 * with "Download is starting", while the download itself is saved; an abort
 * no download follows keeps its own error, without waiting for one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

describe('navigations that turn into downloads', () => {
  let page: WebSession;
  beforeAll(async () => {
    page = await startWebSession({ timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await page.close();
  });

  it('fails the navigation as a starting download and saves the file', async () => {
    const start = page.serve('/start', '<p>start</p>');
    const attachment = page.serve('/attachment', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=hello.txt' });
      response.end('Hello world');
    });
    await page.browser.goto(start);
    let failure: unknown;
    const download = await page.browser.waitForDownload(async () => {
      failure = await page.browser.goto(attachment).catch((caught: unknown) => caught);
    });
    expect((failure as Error).message).toContain('Download is starting');
    expect(download.suggestedFilename).toBe('hello.txt');
    expect(await page.browser.url()).toBe(start);
  });

  it('keeps the abort of a navigation to a No Content response, at once', async () => {
    const empty = page.serve('/no-content', (_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const started = Date.now();
    const failure = await page.browser.goto(empty).catch((caught: unknown) => caught);
    expect((failure as Error).message).toContain(onFirefox ? 'NS_BINDING_ABORTED' : 'net::ERR_ABORTED');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
