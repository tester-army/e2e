/**
 * `unique()` on the Saved Addresses scenario: the label typed in is different
 * on every run and appears in the list afterwards, the shape every creation
 * flow has. Marked, the step keys and records a slot for the label, so a
 * second run replays it with a fresh label and zero model calls; unmarked,
 * the value is in the key and every run misses.
 */

import { test } from '@e2e-dev/web';
import { expect, unique } from 'e2e';

test('act adds an address with a run-unique label', async ({ app, agent, screen }) => {
  const label = `Cabin ${Date.now().toString(36)}`;
  await app.open('/e/saved-addresses');
  await agent.act('add a new address labelled {label} at {line}', {
    params: { label: unique(label), line: '7 Pine Way, Bend' },
  });
  await expect(screen.getByTestId('address-list')).toContainText(label);
  await expect(screen.getByTestId('toast')).toHaveText('Address saved');
});
