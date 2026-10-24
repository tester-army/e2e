import type { HardFixture } from '../harder.ts';

const requirement = `# Harbor Rooms

Harbor Rooms reserves one room on two dates. All times are UTC. The Schedule navigation link opens the schedule.

## Schedule

The Date select contains October 20, 2026 and October 21, 2026. October 20 is selected initially. October 20 starts with booking Room visit 1 from 10:00 to 11:00 UTC. October 21 has no bookings.

Start time and End time are labeled selects. Each contains 09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30, and 13:00. A newly opened schedule starts with 09:00 and 09:30. Changing the date restores those time selections and clears form feedback. It preserves all saved bookings.

## Reservation rules

A reservation must start before it ends. Equal endpoints show End time must be after start time. A start after the end shows the same error. The Reserve room button is disabled while the interval is invalid.

Bookings use half-open intervals. A booking includes its start and excludes its end. Two intervals overlap only when each interval starts before the other ends. Touching endpoints are allowed. Bookings on different dates never conflict.

Selecting an interval that overlaps an active booking shows This time overlaps an existing booking and disables Reserve room. A valid available interval shows Available. Reserving it creates one active booking, shows Room reserved, and displays its date and UTC interval in the schedule.

Every booking has its own identity even when another booking has the same duration. New names begin with Room visit 2 and increase once per reservation. The same interval cannot create a duplicate active booking. The form updates availability after each reservation.

## Booking list and cancellation

The booking list shows records for the selected date. It shows the booking name, start, end, UTC label, and Active or Cancelled status. Records sort by start time, then by their creation number. An empty list shows No bookings for this date.

Each active booking has a Cancel booking button whose accessible name includes its booking name. Cancelling marks that record Cancelled, shows Booking cancelled, and makes its interval available. Cancelled records remain in the list. Their cancellation actions are disabled. Repeating cancellation has no additional effect. Cancellation never changes another booking.

Navigation and reload preserve bookings and cancellation state. Reopening Schedule selects October 20 with 09:00 and 09:30. The form evaluates saved active bookings for the selected date.
`;

export const adjacency = {
  id: "adjacency",
  name: "harbor-rooms",
  kind: 'informative',
  requirement,
  files: {
    "PRODUCT.md": requirement,
    "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harbor Rooms</title></head>
<body><h1>Harbor Rooms</h1><nav aria-label="Main navigation"><a href="/">Schedule</a></nav><main></main><script type="module" src="/app.js"></script></body></html>
`,
    "app.js": `import { conflicts } from './view.mjs';

const key = 'harbor-rooms:v1';
const initial = { nextNumber: 2, bookings: [{ number: 1, date: '2026-10-20', start: '10:00', end: '11:00', status: 'Active' }] };
const stored = localStorage.getItem(key);
const state = stored === null ? initial : JSON.parse(stored);
if (stored === null) localStorage.setItem(key, JSON.stringify(state));
const dates = { '2026-10-20': 'October 20, 2026', '2026-10-21': 'October 21, 2026' };
const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
const main = document.querySelector('main');
let date = '2026-10-20';
let start = '09:00';
let end = '09:30';
let feedback = '';

function availability() {
  if (start >= end) return 'End time must be after start time';
  const candidate = { start, end };
  return state.bookings.some(booking => booking.date === date && booking.status === 'Active' && conflicts(candidate, booking))
    ? 'This time overlaps an existing booking' : 'Available';
}

function render() {
  const available = availability();
  const bookings = state.bookings.filter(booking => booking.date === date).sort((a, b) => a.start.localeCompare(b.start) || a.number - b.number);
  const options = selected => times.map(time => \`<option value="\${time}" \${time === selected ? 'selected' : ''}>\${time} UTC</option>\`).join('');
  main.innerHTML = \`<h2>Schedule</h2>
    <label>Date <select name="date">\${Object.entries(dates).map(([value, label]) => \`<option value="\${value}" \${value === date ? 'selected' : ''}>\${label}</option>\`).join('')}</select></label>
    <label>Start time <select name="start">\${options(start)}</select></label>
    <label>End time <select name="end">\${options(end)}</select></label>
    <p role="status" aria-label="Availability">\${available}</p>
    <button type="button" name="reserve" \${available !== 'Available' ? 'disabled' : ''}>Reserve room</button>
    <p role="status" aria-label="Booking feedback">\${feedback}</p>
    \${bookings.length ? \`<ul aria-label="Bookings">\${bookings.map(booking => \`<li aria-label="Room visit \${booking.number}">
      <p role="status" aria-label="Room visit \${booking.number} details">Room visit \${booking.number} | \${dates[booking.date]} | \${booking.start} to \${booking.end} UTC | \${booking.status}</p>
      <button type="button" data-cancel="\${booking.number}" aria-label="Cancel booking Room visit \${booking.number}" \${booking.status === 'Cancelled' ? 'disabled' : ''}>Cancel booking</button></li>\`).join('')}</ul>\` : '<p>No bookings for this date.</p>'}\`;
  main.querySelector('[name=date]').addEventListener('change', event => {
    date = event.target.value;
    start = '09:00';
    end = '09:30';
    feedback = '';
    render();
  });
  for (const name of ['start', 'end']) main.querySelector(\`[name=\${name}]\`).addEventListener('change', event => {
    if (name === 'start') start = event.target.value;
    else end = event.target.value;
    feedback = '';
    render();
  });
  main.querySelector('[name=reserve]').addEventListener('click', () => {
    if (availability() !== 'Available') return;
    state.bookings.push({ number: state.nextNumber++, date, start, end, status: 'Active' });
    localStorage.setItem(key, JSON.stringify(state));
    feedback = 'Room reserved';
    render();
  });
  for (const button of main.querySelectorAll('[data-cancel]')) button.addEventListener('click', () => {
    const booking = state.bookings.find(item => item.number === Number(button.dataset.cancel));
    if (booking.status === 'Cancelled') return;
    booking.status = 'Cancelled';
    localStorage.setItem(key, JSON.stringify(state));
    feedback = 'Booking cancelled';
    render();
  });
}

document.querySelector('nav a').addEventListener('click', event => {
  event.preventDefault();
  date = '2026-10-20';
  start = '09:00';
  end = '09:30';
  feedback = '';
  render();
});
render();
`,
    "rules.mjs": `export function overlaps(first, second) {
  return first.start < second.end && second.start < first.end;
}
`,
    "view.mjs": `import { overlaps } from './rules.mjs';

export function conflicts(candidate, booking) {
  return overlaps(candidate, booking);
}
`,
    "lower/rules.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps } from '../rules.mjs';

test('half-open room intervals', () => {
  const booking = { start: '10:00', end: '11:00' };
  assert.equal(overlaps({ start: '11:00', end: '12:00' }, booking), false);
  assert.equal(overlaps({ start: '09:00', end: '10:00' }, booking), false);
  assert.equal(overlaps({ start: '10:30', end: '11:30' }, booking), true);
  assert.equal(overlaps({ start: '10:00', end: '11:00' }, booking), true);
  assert.equal(overlaps({ start: '12:00', end: '13:00' }, booking), false);
  assert.equal(overlaps({ start: '09:30', end: '11:30' }, booking), true);
  assert.equal(overlaps({ start: '10:00', end: '10:30' }, booking), true);
});
`,
  },
  lowerExit: 0,
  mutationFile: 'view.mjs',
  mutation: ["return overlaps(candidate, booking);", "return candidate.start <= booking.end && booking.start <= candidate.end;"],
  strong: `await screen.getByLabel('Start time').selectOption({ value: '11:00' });
  await screen.getByLabel('End time').selectOption({ value: '12:00' });
  await expect(screen.getByRole('status', 'Availability')).toHaveText('Available');
  await screen.getByRole('button', 'Reserve room').tap();
  await expect(screen.getByRole('status', 'Booking feedback')).toHaveText('Room reserved');
  await expect(screen.getByRole('status', 'Room visit 2 details')).toHaveText('Room visit 2 | October 20, 2026 | 11:00 to 12:00 UTC | Active');`,
  weak: `await screen.getByLabel('End time').selectOption({ value: '13:00' });
  await screen.getByLabel('Start time').selectOption({ value: '12:00' });
  await expect(screen.getByRole('status', 'Availability')).toHaveText('Available');
  await screen.getByRole('button', 'Reserve room').tap();
  await expect(screen.getByRole('status', 'Room visit 2 details')).toHaveText('Room visit 2 | October 20, 2026 | 12:00 to 13:00 UTC | Active');
  await screen.getByRole('button', 'Cancel booking Room visit 2').tap();
  await expect(screen.getByRole('status', 'Room visit 2 details')).toHaveText('Room visit 2 | October 20, 2026 | 12:00 to 13:00 UTC | Cancelled');`,
  expected: "Available",
} satisfies HardFixture;
