/** Compile-time assertions for `app` on a web target: `web()` requires `app.url`, so `baseUrl` is a string. */
import { test as core } from 'e2e';
import { test, type WebApp } from '../../src/index.ts';

test('reads the base URL without a cast', async ({ app }) => {
  void (app satisfies WebApp);
  void (`${app.baseUrl}/api/users` satisfies string);
  void new URL(app.baseUrl);
});

test.extend<{ api: (path: string) => Promise<Response> }>({
  api: async ({ app }, use) => {
    await use((path) => fetch(`${app.baseUrl}${path}`));
  },
});

core('a target-agnostic test still handles a target without a URL', async ({ app }) => {
  // @ts-expect-error e2e's own test runs on any target, and one without app.url has no base URL.
  void new URL(app.baseUrl);
});
