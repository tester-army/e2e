import { test as base } from '@e2e-dev/web';
import type { App } from 'e2e';

export { expect } from 'e2e';

interface Account {
  readonly email: string;
  readonly sessionToken: string;
}

/** The URL the run serves the app at, including a port it picked. */
function appUrl(app: App): string {
  if (app.baseUrl === undefined) throw new Error('set app.url on the target');
  return app.baseUrl;
}

/** Calls the app's test API and fails on any status but 2xx. */
async function testApi(app: App, path: string, method: 'POST' | 'DELETE'): Promise<Response> {
  const response = await fetch(new URL(path, appUrl(app)), { method });
  if (!response.ok) throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
  return response;
}

/** A fresh account for each test, deleted after it. */
export const test = base.extend<{ account: Account }>({
  account: async ({ app }, use) => {
    const response = await testApi(app, '/api/test/accounts', 'POST');
    const account = (await response.json()) as Account;
    await use(account);
    await testApi(app, `/api/test/accounts/${encodeURIComponent(account.email)}`, 'DELETE');
  },
});

/** The same account, already signed in to the browser. */
export const signedInTest = test.extend<{ signedIn: Account }>({
  signedIn: async ({ account, app, browser }, use) => {
    await browser.setCookies([{ url: appUrl(app), name: 'session', value: account.sessionToken }]);
    await use(account);
  },
});
