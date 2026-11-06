/**
 * `attachBrowser` on a Chrome the test owns: `browser` and `screen` drive the
 * open tab in the default context, and closing detaches without closing the
 * tab or the browser, whose cookies the next attach still sees.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachBrowser } from '../../src/index.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';

/** The page targets Chrome lists over its DevTools HTTP endpoint. */
async function pages(endpoint: string): Promise<{ id: string; url: string }[]> {
  const targets = (await (await fetch(`${endpoint}/json/list`)).json()) as { id: string; type: string; url: string }[];
  return targets.filter((target) => target.type === 'page').map(({ id, url }) => ({ id, url }));
}

describe('attachBrowser', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let endpoint: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome();
    endpoint = `http://${new URL(chrome.endpoint).host}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('signs in on the open tab and leaves the tab, the browser, and the cookie behind', async () => {
    const [tab] = await pages(endpoint);
    expect(tab).toBeDefined();

    const first = await attachBrowser(endpoint);
    try {
      await first.browser.goto(`${app.url}/sign-in`);
      await first.screen.getByLabel('Email').fill('qa@example.com');
      await first.screen.getByLabel('Password').fill('hunter2');
      await first.screen.getByRole('button', 'Sign in').tap();
      await first.browser.waitForURL(`${app.url}/`);
    } finally {
      await first.close();
    }

    expect(chrome.proc.exitCode).toBeNull();
    expect(await pages(endpoint)).toEqual([{ id: tab!.id, url: `${app.url}/` }]);

    await using second = await attachBrowser(endpoint);
    expect(await second.browser.url()).toBe(`${app.url}/`);
    expect(await second.screen.getByRole('heading', 'Home').count()).toBe(1);
    expect((await second.browser.cookies()).map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'session', value: 'qa%40example.com' }]);
  });
});
