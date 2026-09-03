/**
 * Long single step: eighteen fields across six wizard pages inside ONE
 * `agent.act`. Exercises in-step context management — many actions, many
 * screen snapshots, values carried from the instruction to the last page.
 */

import { test } from '@e2edev/playwright';
import { expect } from 'e2e';

test('completes the six-page onboarding wizard in one step', async ({ web, agent, screen }) => {
  await web.goto('/onboarding');

  await agent.act('Complete the onboarding wizard with the given details, accepting the terms of service but not subscribing to the newsletter, and finish it.', {
    company: 'Helios Robotics',
    website: 'https://helios.example',
    industry: 'Manufacturing',
    companySize: '51-200',
    street: 'Sonnenallee 12',
    city: 'Berlin',
    postalCode: '12045',
    country: 'Germany',
    vatNumber: 'DE123456789',
    billingEmail: 'billing@helios.example',
    currency: 'EUR',
    accountOwner: 'Mara Lindqvist',
    ownerEmail: 'mara@helios.example',
    seats: '25',
    timeZone: 'Europe/Berlin',
    language: 'German',
  });

  await expect(screen.getByRole('status', { name: 'Result' })).toHaveText(
    'Onboarding complete for Helios Robotics (25 seats, EUR, Europe/Berlin)',
  );
});
