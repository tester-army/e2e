/**
 * Long flow: a full procurement cycle — a dozen dependent `agent.act` steps
 * across three pages with forty-row tables. Later steps refer back to things
 * earlier steps created ("the supplier you added", "the order you just
 * created"), so the step hand-off has to carry those facts. Every act is
 * verified deterministically so a wrong verdict cannot pass.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('runs a procurement cycle end to end', async ({ web, agent, screen }) => {
  await fetch('http://localhost:4273/api/reset', { method: 'POST' });
  await web.goto('/procure/suppliers');

  await agent.act(
    'Add a supplier named "Nimbus Paper Co" with contact email ops@nimbus.example, country Poland and payment terms Net 60.',
  );
  await expect(screen.getByText('ops@nimbus.example')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Deactivate Nimbus Paper Co' })).toBeVisible();

  await agent.act('Deactivate the supplier "Old Mill Pulp".');
  await expect(screen.getByRole('button', { name: 'Reactivate Old Mill Pulp' })).toBeVisible();

  await agent.act('Go to the Catalog page.');
  await expect(screen.getByRole('heading', { name: 'Catalog' })).toBeVisible();

  await agent.act(
    'Add a product with SKU NP-A4-80, name "A4 copy paper 80g", unit price 4.25, unit Ream, supplied by the supplier you added earlier.',
  );
  await expect(screen.getByText('NP-A4-80')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Edit stock of A4 copy paper 80g' })).toBeVisible();

  await agent.act(
    'Add another product from the same supplier: SKU NP-A3-90, name "A3 copy paper 90g", unit price 7.90, unit Ream.',
  );
  await expect(screen.getByText('NP-A3-90')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Edit stock of A3 copy paper 90g' })).toBeVisible();

  await agent.act('Set the stock of "A4 copy paper 80g" to 120.');
  await expect(screen.getByText('Stock: 120')).toBeVisible();

  await agent.act('Archive every product supplied by "Old Mill Pulp" (use the search box to find them).');
  await expect(screen.getByRole('status', { name: 'Catalog count' })).toContainText('of 37 products');

  await agent.act('Go to the Orders page.');
  await expect(screen.getByRole('heading', { name: 'Purchase orders' })).toBeVisible();

  await agent.act(
    'Create a new purchase order for the supplier you added at the start, with 10 reams of the A4 paper and 4 reams of the A3 paper, discount code SPRING10 and the internal note "Q3 restock".',
  );
  // 10 × 4.25 + 4 × 7.90 = 74.10, minus 10% = 66.69
  await expect(screen.getByText(/PO-1007 — Nimbus Paper Co — Draft — total \$66\.69/)).toBeVisible();

  await agent.act('Approve the order you just created.');
  await expect(screen.getByText(/PO-1007 — Nimbus Paper Co — Approved/)).toBeVisible();

  await agent.act('In that order, change the quantity of the A3 paper line to 6.');
  // 10 × 4.25 + 6 × 7.90 = 89.90, minus 10% = 80.91
  await expect(screen.getByText(/PO-1007 — Nimbus Paper Co — Approved — total \$80\.91/)).toBeVisible();

  await agent.act('Ship that order.');
  await expect(screen.getByText(/PO-1007 — Nimbus Paper Co — Shipped/)).toBeVisible();

  await agent.act('Cancel purchase order PO-1003.');
  await expect(screen.getByText(/PO-1003 — .* — Cancelled/)).toBeVisible();

  await agent.act('Filter the list to show only shipped orders.');
  await expect(screen.getByRole('status', { name: 'Order count' })).toHaveText('2 order(s)');
  await expect(screen.getByText(/PO-1003/)).toBeHidden();

  await agent.assert('Both listed orders are shipped and one of them is the Nimbus Paper Co order for $80.91.');
});
