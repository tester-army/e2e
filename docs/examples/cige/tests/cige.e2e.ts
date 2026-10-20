import { cigeSuite } from '@e2e-dev/cige';

cigeSuite('tests/cige/*.cige.json', {
  hooks: {
    // Precondition: seed the cart through the test API, not the UI.
    seedCart: async () => {
      await fetch('http://localhost:3000/test-api/cart', { method: 'POST', body: '{"sku":"ITEM-100","qty":2}' });
    },
    // Evidence: the order exists in the backend, not only on the confirmation page.
    orderPersisted: async ({ screen }) => {
      const orderId = await screen.getByTestId('order-id').textContent();
      const response = await fetch(`http://localhost:3000/test-api/orders/${orderId}`);
      return response.ok;
    },
  },
});
