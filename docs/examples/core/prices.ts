import { launch } from 'e2e-core';
import { web } from '@e2e-dev/web/engine';

await using shop = await launch(web(), { app: { url: 'https://shop.example.com' } });

for (const sku of ['A-1001', 'B-2040']) {
  await using session = await shop.newSession();
  await session.app.open(`/products/${sku}`);
  if (await session.screen.getByText('Sold out', { exact: false, visible: true }).isVisible()) continue;
  const price = await session.screen.getByTestId('sale-price').textContent();
  console.log(sku, price);
}
