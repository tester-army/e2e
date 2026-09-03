/**
 * Hand-off stress: a fact the app generated and showed exactly once (the
 * ticket code and colour) must survive to a step many steps later, on a page
 * that does not show it. The only channel is the step ledger, so this measures
 * how well one step's context reaches the next — and whether it survives the
 * ledger's byte budget once enough steps sit in between.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

async function reset(): Promise<{ code: string; colour: string }> {
  await fetch('http://localhost:4273/api/reset', { method: 'POST' });
  const response = await fetch('http://localhost:4273/api/handoff');
  const body = (await response.json()) as { ticket: { code: string; colour: string } };
  return body.ticket;
}

test('carries a ticket across a short chain of steps', async ({ web, agent, screen }) => {
  const ticket = await reset();
  await web.goto('/handoff');

  // Terse on purpose: nothing tells the model to memorize the ticket.
  await agent.act('Get a visitor ticket from the desk.');
  await expect(screen.getByRole('status', { name: 'Ticket' })).toContainText(ticket.code);

  await agent.act('Go to the Procurement pages and deactivate the supplier "Fjord Furniture".');
  await expect(screen.getByRole('button', { name: 'Reactivate Fjord Furniture' })).toBeVisible();

  await agent.act('Open the Catalog page and set the stock of "Small Binder" to 5.');
  await expect(screen.getByText('Stock: 5')).toBeVisible();

  await agent.act('Go to the visitor gate and enter the details of the ticket you were issued earlier.');
  await expect(screen.getByRole('status', { name: 'Gate result' })).toHaveText(
    new RegExp(`Access granted for ${ticket.code}`),
  );
});

test('carries a ticket across a long chain of steps', async ({ web, agent, screen }) => {
  const ticket = await reset();
  await web.goto('/handoff');

  await agent.act('Get a visitor ticket from the desk and note everything printed on it.');
  await expect(screen.getByRole('status', { name: 'Ticket' })).toContainText(ticket.code);

  await agent.act('Go to the Procurement suppliers page.');
  await expect(screen.getByRole('heading', { name: 'Suppliers' })).toBeVisible();

  for (const supplier of ['Alder Office Supply', 'Brightline Toners', 'Cobalt Packaging', 'Delta Desk Works']) {
    await agent.act(`Deactivate the supplier "${supplier}".`);
    await expect(screen.getByRole('button', { name: `Reactivate ${supplier}` })).toBeVisible();
  }
  await agent.act('Reactivate the supplier "Alder Office Supply".');
  await expect(screen.getByRole('button', { name: 'Deactivate Alder Office Supply' })).toBeVisible();

  await agent.act(
    'Add a supplier named "Quill & Co" with contact email hello@quill.example, country Sweden and payment terms Prepaid.',
  );
  await expect(screen.getByRole('button', { name: 'Deactivate Quill & Co' })).toBeVisible();

  await agent.act('Go to the Catalog page.');
  await expect(screen.getByRole('heading', { name: 'Catalog' })).toBeVisible();

  for (const [product, stock] of [
    ['Small Binder', '5'],
    ['Medium Envelope', '17'],
    ['Large Marker', '0'],
  ] as const) {
    await agent.act(`Set the stock of "${product}" to ${stock}.`);
    await expect(screen.getByText(`Stock: ${stock}`)).toBeVisible();
  }
  await agent.act('Archive the product "XL Notebook".');
  await expect(screen.getByRole('status', { name: 'Catalog count' })).toContainText('of 39 products');

  await agent.act('Go to the Orders page and approve purchase order PO-1003.');
  await expect(screen.getByText(/PO-1003 — .* — Approved/)).toBeVisible();

  await agent.act('Cancel purchase order PO-1005.');
  await expect(screen.getByText(/PO-1005 — .* — Cancelled/)).toBeVisible();

  await agent.act('Filter the list to show only draft orders.');
  await expect(screen.getByRole('status', { name: 'Order count' })).toHaveText('1 order(s)');

  await agent.act(
    'Go to the visitor gate (the Ticket desk page links to it) and enter the details of the ticket you were issued at the start.',
  );
  await expect(screen.getByRole('status', { name: 'Gate result' })).toHaveText(
    new RegExp(`Access granted for ${ticket.code}`),
  );
});
