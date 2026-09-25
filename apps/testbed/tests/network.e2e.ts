import { test } from '@e2edev/web';
import { expect } from 'e2e';

test.describe('network', { requires: ['web'], tags: ['network'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/network');
  });

  test('loads users from the real API', async ({ screen, web }) => {
    const [response] = await Promise.all([
      web.waitForResponse('**/api/users'),
      screen.getByRole('button', { name: 'Load users' }).tap(),
    ]);
    expect(response.status).toBe(200);
    expect(await response.json<{ name: string }[]>()).toEqual([
      { name: 'Ada' },
      { name: 'Grace' },
      { name: 'Margaret' },
    ]);
    await expect(screen.getByRole('status', { name: 'Network state' })).toHaveText('loaded 3');
    await expect(screen.getByText('Grace')).toBeVisible();
  });

  test('stubs the API with route fulfillment', async ({ screen, web }) => {
    await web.route('**/api/users', (route) =>
      route.fulfill({ json: [{ name: 'Stubbed' }] }),
    );
    await screen.getByRole('button', { name: 'Load users' }).tap();
    await expect(screen.getByRole('status', { name: 'Network state' })).toHaveText('loaded 1');
    await expect(screen.getByText('Stubbed')).toBeVisible();

    await web.unroute('**/api/users');
    await screen.getByRole('button', { name: 'Load users' }).tap();
    await expect(screen.getByRole('status', { name: 'Network state' })).toHaveText('loaded 3');
  });

  test('surfaces aborted requests as failures', async ({ screen, web }) => {
    await web.route('**/api/users', (route) => route.abort());
    await screen.getByRole('button', { name: 'Load users' }).tap();
    await expect(screen.getByRole('status', { name: 'Network state' })).toHaveText('failed');
  });

  test('evaluate inspects live page state', async ({ screen, web }) => {
    await screen.getByRole('button', { name: 'Load users' }).tap();
    await expect(screen.getByRole('status', { name: 'Network state' })).toHaveText('loaded 3');
    const names = await web.evaluate(() =>
      Array.from(document.querySelectorAll('#users li')).map((item) => item.textContent),
    );
    expect(names).toEqual(['Ada', 'Grace', 'Margaret']);
  });
});
