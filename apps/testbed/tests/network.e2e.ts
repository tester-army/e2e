import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('network', { requires: ['browser'], tags: ['network'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/network');
  });

  test('loads users from the real API', async ({ screen, browser }) => {
    const [response] = await Promise.all([
      browser.waitForResponse('**/api/users'),
      screen.getByRole('button', 'Load users').tap(),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json<{ name: string }[]>()).toEqual([
      { name: 'Ada' },
      { name: 'Grace' },
      { name: 'Margaret' },
    ]);
    await expect(screen.getByRole('status', 'Network state')).toHaveText('loaded 3');
    await expect(screen.getByText('Grace')).toBeVisible();
  });

  test('stubs the API with route fulfillment', async ({ screen, browser }) => {
    await browser.route('**/api/users', (route) =>
      route.fulfill({ json: [{ name: 'Stubbed' }] }),
    );
    await screen.getByRole('button', 'Load users').tap();
    await expect(screen.getByRole('status', 'Network state')).toHaveText('loaded 1');
    await expect(screen.getByText('Stubbed')).toBeVisible();

    await browser.unroute('**/api/users');
    await screen.getByRole('button', 'Load users').tap();
    await expect(screen.getByRole('status', 'Network state')).toHaveText('loaded 3');
  });

  test('surfaces aborted requests as failures', async ({ screen, browser }) => {
    await browser.route('**/api/users', (route) => route.abort());
    await screen.getByRole('button', 'Load users').tap();
    await expect(screen.getByRole('status', 'Network state')).toHaveText('failed');
  });

  test('evaluate inspects live page state', async ({ screen, browser }) => {
    await screen.getByRole('button', 'Load users').tap();
    await expect(screen.getByRole('status', 'Network state')).toHaveText('loaded 3');
    const names = await browser.evaluate(() =>
      Array.from(document.querySelectorAll('#users li')).map((item) => item.textContent),
    );
    expect(names).toEqual(['Ada', 'Grace', 'Margaret']);
  });
});
