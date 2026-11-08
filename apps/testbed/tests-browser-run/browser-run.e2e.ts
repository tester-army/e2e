import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('CDP authorization stays out of page requests and artifacts', async ({ app, browser, screen }) => {
  await app.open('/forms');
  const headers = await browser.evaluate("async () => (await fetch('/echo-headers')).json()");
  expect(headers).not.toHaveProperty('authorization');
  await screen.getByLabel('Full name').fill('Browser Run on Roundtrip');
  await screen.getByRole('button', 'Save profile').tap();
  await expect(screen.getByRole('status', 'Save result')).toHaveText('Saved profile for Browser Run on Roundtrip');
  await app.screenshot('browser-run-form');
});

for (let n = 0; n < 4; n++) {
  test(`cookies and local storage start empty ${n}`, async ({ app, browser }) => {
    await app.open('/forms');
    expect(await browser.cookies()).toEqual([]);
    expect(await browser.evaluate('() => localStorage.getItem("previous-attempt")')).toBe(null);
    await browser.evaluate('() => { localStorage.setItem("previous-attempt", "dirty"); document.cookie = "previous=dirty; Path=/"; }');
  });
}

test('network interception, dialogs and iframe actions work remotely', async ({ app, browser, screen }) => {
  await browser.route('**/api/users', (route) => route.fulfill({ json: [{ name: 'Browser Run' }] }));
  await app.open('/forms');
  expect(await browser.evaluate("async () => (await fetch('/api/users')).json()")).toEqual([{ name: 'Browser Run' }]);
  await app.open('/dialogs');
  await browser.onDialog('accept');
  await screen.getByRole('button', 'Delete everything').tap();
  await expect(screen.getByRole('status', 'Decision')).toHaveText('deleted');
  await app.open('/frames');
  const editor = browser.frameLocator('#editor');
  await editor.getByLabel('Note').fill('Cloudflare iframe');
  await editor.getByRole('button', 'Save note').tap();
  await expect(editor.getByRole('status', 'Note state')).toHaveText('saved: Cloudflare iframe');
});
