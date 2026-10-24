import { defineCige } from '@e2e-dev/cige';
import { shop } from './cige.plugins.ts';

export default defineCige({
  cases: 'tests/cige/*.cige.json',
  root: new URL('.', import.meta.url),
  build: process.env.GITHUB_SHA,
  hooks: {
    // Precondition: seed the cart through the test API, not the UI.
    seedCart: async () => {
      const response = await fetch('http://localhost:3000/test-api/cart', { method: 'POST', body: '{"sku":"ITEM-100","qty":2}' });
      if (!response.ok) throw new Error(`seeding the cart returned ${response.status}`);
    },
    // Evidence: the order exists in the backend. Only `true` holds.
    orderPersisted: async ({ screen }) => {
      const orderId = await screen.getByTestId('order-id').textContent();
      // No order number on the page is no evidence: fail it, don't look up "null".
      if (orderId === null || orderId.trim() === '') return false;
      const response = await fetch(`http://localhost:3000/test-api/orders/${encodeURIComponent(orderId.trim())}`);
      return response.ok;
    },
  },
  environments: {
    staging: {
      config: 'e2e.config.ts',
      reset: async () => {
        const response = await fetch('http://localhost:3000/test-api/reset', { method: 'POST' });
        if (!response.ok) throw new Error(`resetting staging returned ${response.status}`);
      },
    },
  },
  plugins: [shop],
  refs: {
    build: ({ build }) => (build === undefined ? undefined : { url: `https://github.com/acme/shop/commit/${build}` }),
    expected: ({ pointer }) => (pointer === undefined ? undefined : { files: [pointer] }),
  },
});
