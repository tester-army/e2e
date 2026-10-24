import type { HardFixture } from '../harder.ts';

const requirement = `# Pine Events

Pine Events shows saved bookings and the cancellation rule attached to each booking. All records are synthetic. The app clock is fixed at October 20, 2026, 00:00 UTC. Navigation and reload never advance that clock.

## Bookings

The Bookings navigation link shows these active records in the order listed. Dates and times are UTC.

| Booking | Policy version | Event start |
| --- | --- | --- |
| Dawn studio | 2 | October 20, 2026, 05:00 |
| Breakfast studio | 2 | October 20, 2026, 06:00 |
| Noon studio | 2 | October 20, 2026, 12:00 |
| Next-day studio | 2 | October 21, 2026, 00:00 |
| Legacy noon studio | 1 | October 20, 2026, 12:00 |
| Legacy next-day studio | 1 | October 21, 2026, 00:00 |

Each record shows its booking name, policy version, event start, Active or Cancelled status, and cancellation eligibility. Records remain separate when event starts are equal. The Details button includes the booking name in its accessible name. Details shows the same saved record and a Back to bookings link.

## Cancellation policies

POLICIES.md and the Policies navigation link describe both versions. Version 2 is the current policy for version 2 bookings. It permits cancellation when at least six hours remain until the event, including exactly six hours. Version 1 is retained for version 1 bookings. It permits cancellation when at least 24 hours remain, including exactly 24 hours. A booking keeps its stored version. A legacy example never changes a version 2 booking's rule.

Eligibility uses the exact event timestamp minus the fixed app clock. One hour is exactly 3,600,000 milliseconds. There is no date-only comparison, rounding, local-time conversion, grace period, or live clock.

## Cancellation feedback

An eligible active record shows Cancellation available and an enabled Cancel booking button whose accessible name includes the booking name. An ineligible active record shows Cancellation unavailable, its applicable six-hour or 24-hour requirement, and a disabled Cancel booking action. Cancellation is available from the list and the record's Details screen.

Cancelling an eligible record marks only that booking Cancelled and shows Booking cancelled. Both list and Details show the committed status. Cancelled records retain disabled cancellation actions. Repeating cancellation has no additional effect. Navigation and reload preserve cancellation state. Viewing a booking or a policy never changes a record.
`;

export const policy = {
  id: 'policy',
  name: 'pine-events',
  kind: 'safeguard',
  requirement,
  files: {
    'PRODUCT.md': requirement,
    'POLICIES.md': `# Cancellation policies

The fixed app clock is October 20, 2026, 00:00 UTC.

| Stored booking policy | Cancellation rule |
| --- | --- |
| Version 2, current | At least six hours remain before event start. Exactly six hours qualifies. |
| Version 1, retained legacy | At least 24 hours remain before event start. Exactly 24 hours qualifies. |

A booking uses its stored policy version. Current version 2 bookings do not use the version 1 cutoff. The rule uses exact UTC timestamps and an hour of 3,600,000 milliseconds. Navigation and reload do not advance the clock. A cancellation changes one eligible active booking to Cancelled exactly once.
`,
    'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Pine Events</title></head>
<body>
<h1>Pine Events</h1>
<p role="status" aria-label="App clock">October 20, 2026, 00:00 UTC</p>
<nav><a href="#bookings">Bookings</a> <a href="#policies">Policies</a></nav>
<main></main>
<p role="status" aria-label="Cancellation result"></p>
<script type="module" src="/app.js"></script>
</body>
</html>
`,
    'rules.mjs': `export const canCancelV1 = (eventStart, clock) => eventStart - clock >= 24 * 3600000;
`,
    'data.mjs': `export const CLOCK = Date.parse('2026-10-20T00:00:00Z');
export const HOUR = 3600000;
export const bookings = [
  { id: 'dawn', name: 'Dawn studio', policyVersion: 2, eventStart: Date.parse('2026-10-20T05:00:00Z'), label: 'October 20, 2026, 05:00 UTC' },
  { id: 'breakfast', name: 'Breakfast studio', policyVersion: 2, eventStart: Date.parse('2026-10-20T06:00:00Z'), label: 'October 20, 2026, 06:00 UTC' },
  { id: 'noon', name: 'Noon studio', policyVersion: 2, eventStart: Date.parse('2026-10-20T12:00:00Z'), label: 'October 20, 2026, 12:00 UTC' },
  { id: 'next-day', name: 'Next-day studio', policyVersion: 2, eventStart: Date.parse('2026-10-21T00:00:00Z'), label: 'October 21, 2026, 00:00 UTC' },
  { id: 'legacy-noon', name: 'Legacy noon studio', policyVersion: 1, eventStart: Date.parse('2026-10-20T12:00:00Z'), label: 'October 20, 2026, 12:00 UTC' },
  { id: 'legacy-next-day', name: 'Legacy next-day studio', policyVersion: 1, eventStart: Date.parse('2026-10-21T00:00:00Z'), label: 'October 21, 2026, 00:00 UTC' },
];
`,
    'view.mjs': `import { canCancelV1 } from './rules.mjs';
import { CLOCK, HOUR } from './data.mjs';

export const eligible = booking => booking.policyVersion === 2
  ? booking.eventStart - CLOCK >= 6 * HOUR
  : canCancelV1(booking.eventStart, CLOCK);
`,
    'app.js': `import { bookings } from './data.mjs';
import { eligible } from './view.mjs';

const storageKey = 'pine-bookings:v1';
const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
const main = document.querySelector('main');
const result = document.querySelector('[aria-label="Cancellation result"]');
let page = 'bookings';

const bookingCard = booking => {
  const cancelled = saved[booking.id] === 'Cancelled';
  const available = !cancelled && eligible(booking);
  return '<article aria-label="' + booking.name + '"><h3>' + booking.name + '</h3>' +
    '<p role="status" aria-label="' + booking.name + ' policy">Policy version ' + booking.policyVersion + '</p>' +
    '<p>Event start: ' + booking.label + '</p>' +
    '<p role="status" aria-label="' + booking.name + ' status">' + (cancelled ? 'Cancelled' : 'Active') + '</p>' +
    '<p role="status" aria-label="' + booking.name + ' eligibility">Cancellation ' + (available ? 'available' : 'unavailable') + '</p>' +
    '<p>' + (booking.policyVersion === 2 ? 'At least six hours required.' : 'At least 24 hours required.') + '</p>' +
    '<button data-cancel="' + booking.id + '" ' + (available ? '' : 'disabled') + '>Cancel booking ' + booking.name + '</button>' +
    (page === 'bookings' ? '<button data-details="' + booking.id + '">Details ' + booking.name + '</button>' : '') + '</article>';
};

const render = () => {
  if (page === 'policies') {
    main.innerHTML = '<h2>Cancellation policies</h2>' +
      '<p>The fixed app clock is October 20, 2026, 00:00 UTC.</p>' +
      '<table><thead><tr><th>Stored booking policy</th><th>Cancellation rule</th></tr></thead><tbody>' +
      '<tr><td>Version 2, current</td><td>At least six hours remain before event start. Exactly six hours qualifies.</td></tr>' +
      '<tr><td>Version 1, retained legacy</td><td>At least 24 hours remain before event start. Exactly 24 hours qualifies.</td></tr></tbody></table>' +
      '<p>A booking uses its stored policy version. Current version 2 bookings do not use the version 1 cutoff. The rule uses exact UTC timestamps and an hour of 3,600,000 milliseconds. Navigation and reload do not advance the clock. A cancellation changes one eligible active booking to Cancelled exactly once.</p>';
    return;
  }
  const records = page === 'bookings' ? bookings : bookings.filter(booking => booking.id === page);
  main.innerHTML = '<h2>' + (page === 'bookings' ? 'Bookings' : 'Details') + '</h2>' +
    records.map(bookingCard).join('') + (page === 'bookings' ? '' : '<a href="#bookings">Back to bookings</a>');
};

document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (link) {
    event.preventDefault();
    page = link.getAttribute('href').slice(1);
    result.textContent = '';
    render();
    return;
  }
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.details) {
    page = button.dataset.details;
    result.textContent = '';
    render();
    return;
  }
  const booking = bookings.find(record => record.id === button.dataset.cancel);
  if (!booking || saved[booking.id] === 'Cancelled' || !eligible(booking)) return;
  saved[booking.id] = 'Cancelled';
  localStorage.setItem(storageKey, JSON.stringify(saved));
  render();
  result.textContent = 'Booking cancelled';
});

render();
`,
    'lower/rules.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelV1 } from '../rules.mjs';

test('retained version 1 cancellation policy', () => {
  const clock = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(canCancelV1(Date.parse('2026-10-20T12:00:00Z'), clock), false);
  assert.equal(canCancelV1(Date.parse('2026-10-20T23:59:59.999Z'), clock), false);
  assert.equal(canCancelV1(Date.parse('2026-10-21T00:00:00Z'), clock), true);
  assert.equal(canCancelV1(Date.parse('2026-10-21T01:00:00Z'), clock), true);
});
`,
  },
  lowerExit: 0,
  mutationFile: 'view.mjs',
  mutation: [`booking.eventStart - CLOCK >= 6 * HOUR`, `canCancelV1(booking.eventStart, CLOCK)`],
  strong: `await expect(screen.getByRole('status', 'App clock')).toHaveText('October 20, 2026, 00:00 UTC');
  await expect(screen.getByRole('status', 'Noon studio policy')).toHaveText('Policy version 2');
  await screen.getByRole('button', 'Details Noon studio').tap();
  await expect(screen.getByRole('status', 'Noon studio eligibility')).toHaveText('Cancellation available');
  await expect(screen.getByRole('button', 'Cancel booking Noon studio')).toBeEnabled();
  await screen.getByRole('button', 'Cancel booking Noon studio').tap();
  await expect(screen.getByRole('status', 'Cancellation result')).toHaveText('Booking cancelled');
  await expect(screen.getByRole('status', 'Noon studio status')).toHaveText('Cancelled');
  await screen.getByRole('link', 'Back to bookings').tap();
  await expect(screen.getByRole('status', 'Noon studio status')).toHaveText('Cancelled');`,
  weak: `await screen.getByRole('button', 'Details Next-day studio').tap();
  await expect(screen.getByRole('status', 'Next-day studio eligibility')).toHaveText('Cancellation available');
  await screen.getByRole('button', 'Cancel booking Next-day studio').tap();
  await expect(screen.getByRole('status', 'Next-day studio status')).toHaveText('Cancelled');
  await screen.getByRole('link', 'Back to bookings').tap();
  await expect(screen.getByRole('status', 'Next-day studio status')).toHaveText('Cancelled');
  await screen.getByRole('button', 'Details Next-day studio').tap();
  await expect(screen.getByRole('status', 'Next-day studio status')).toHaveText('Cancelled');`,
  expected: 'Cancellation available',
} satisfies HardFixture;
