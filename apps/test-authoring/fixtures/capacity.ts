import type { HardFixture } from '../harder.ts';

const requirement = `# Juniper Workshops

Juniper Workshops has one workshop, Clay basics, on October 22, 2026 from 10:00 to 11:00 UTC. The workshop has two seats. It starts with no reservations.

## Workshop and reservation form

The Workshops navigation link shows the workshop, Capacity 2, Available seats, and a Reserve seats button. Available seats is the capacity minus the seats in active reservations. The overview always uses current saved reservations.

Reserve seats opens the reservation form. Its Seats select contains 1 and 2. One seat is selected initially. The form shows the current Available seats count when it opens and after each reservation. It disables any quantity above current availability. If no seats remain, it shows No seats available and disables Confirm reservation. There is no zero-seat option or free-text quantity.

Confirm reservation creates one active reservation for the selected quantity. It shows Reservation confirmed and a reservation record containing its number, workshop, seat count, and Active status. It updates current availability before it shows success. Reservations never exceed two active seats in total.

Reservation numbers begin at 1 and increase once per created reservation. A completed confirmation cannot submit the same reservation again. The Back to workshops link returns to the overview. Reopening the form reads current saved availability and starts with one seat selected if one seat is available. It retains the two options when full but disables both.

## Reservations and cancellation

The Reservations navigation link lists all records in reservation-number order. An empty list shows No reservations. Each active record has a Cancel reservation button whose accessible name includes the reservation number.

Cancelling marks the selected record Cancelled, shows Reservation cancelled, and releases that record's entire seat count exactly once. The overview and any newly opened reservation form use the released seats. A cancelled record remains visible with a disabled cancellation action. Repeating cancellation does not release seats again or alter another record.

An invalid or unavailable request creates no record and shows Not enough seats available. Navigation and reload preserve reservations and current availability. Unsaved seat selections are discarded when the form closes.
`;

export const capacity = {
  id: "capacity",
  name: "juniper-workshops",
  kind: 'informative',
  requirement,
  files: {
    "PRODUCT.md": requirement,
    "index.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Juniper Workshops</title></head>
<body><h1>Juniper Workshops</h1><nav aria-label="Main navigation"><a href="/" data-page="workshops">Workshops</a> <a href="/" data-page="reservations">Reservations</a></nav><main></main><script type="module" src="/app.js"></script></body></html>
`,
    "app.js": `import { availableSeats, reservationReducer } from './rules.mjs';
import { formAvailability } from './view.mjs';

const key = 'juniper-workshops:v1';
const stored = localStorage.getItem(key);
const initial = { workshop: { nextNumber: 1, reservations: [] }, snapshot: 2 };
const saved = stored === null ? initial : JSON.parse(stored);
let state = saved.workshop;
let snapshot = saved.snapshot;
if (stored === null) localStorage.setItem(key, JSON.stringify(saved));
const main = document.querySelector('main');
let page = 'workshops';
let selectedSeats = 1;
let feedback = '';
let confirmationNumber = null;

function save() {
  localStorage.setItem(key, JSON.stringify({ workshop: state, snapshot }));
}

function recordMarkup(record) {
  return \`<li aria-label="Reservation \${record.number}"><p role="status" aria-label="Reservation \${record.number} details">Reservation \${record.number} | Clay basics | Seats \${record.seats} | \${record.status}</p>
    <button type="button" data-cancel="\${record.number}" aria-label="Cancel reservation \${record.number}" \${record.status === 'Cancelled' ? 'disabled' : ''}>Cancel reservation</button></li>\`;
}

function render() {
  let content = '';
  if (page === 'workshops') {
    content = \`<h2>Workshops</h2><p>Clay basics | October 22, 2026 | 10:00 to 11:00 UTC</p><p>Capacity 2</p>
      <p role="status" aria-label="Available seats">Available seats \${availableSeats(state)}</p><button type="button" name="open-form">Reserve seats</button>\`;
  } else if (page === 'form') {
    const available = formAvailability(state, snapshot);
    content = \`<h2>Reserve seats</h2><p>Clay basics | October 22, 2026 | 10:00 to 11:00 UTC</p>
      <p role="status" aria-label="Available seats">Available seats \${available}</p>\${available === 0 ? '<p>No seats available</p>' : ''}
      <label>Seats <select name="seats">\${[1, 2].map(seats => \`<option value="\${seats}" \${seats === selectedSeats ? 'selected' : ''} \${seats > available ? 'disabled' : ''}>\${seats}</option>\`).join('')}</select></label>
      <button type="button" name="confirm" \${selectedSeats > available ? 'disabled' : ''}>Confirm reservation</button><a href="/" data-page="workshops">Back to workshops</a>\`;
  } else if (page === 'confirmation') {
    const record = state.reservations.find(item => item.number === confirmationNumber);
    content = \`<h2>Reservation</h2><p role="status" aria-label="Available seats">Available seats \${availableSeats(state)}</p><ul>\${recordMarkup(record)}</ul><a href="/" data-page="workshops">Back to workshops</a>\`;
  } else {
    content = \`<h2>Reservations</h2>\${state.reservations.length ? \`<ul aria-label="Reservations">\${state.reservations.map(recordMarkup).join('')}</ul>\` : '<p>No reservations</p>'}\`;
  }
  main.innerHTML = content + \`<p role="status" aria-label="Reservation feedback">\${feedback}</p>\`;
  const openForm = main.querySelector('[name=open-form]');
  if (openForm) openForm.addEventListener('click', () => {
    page = 'form';
    selectedSeats = 1;
    feedback = '';
    render();
  });
  const seats = main.querySelector('[name=seats]');
  if (seats) seats.addEventListener('change', event => {
    selectedSeats = Number(event.target.value);
    feedback = '';
    render();
  });
  const confirm = main.querySelector('[name=confirm]');
  if (confirm) confirm.addEventListener('click', () => {
    if (selectedSeats > formAvailability(state, snapshot)) {
      feedback = 'Not enough seats available';
      render();
      return;
    }
    const next = reservationReducer(state, { type: 'reserve', seats: selectedSeats });
    if (next === state) {
      feedback = 'Not enough seats available';
      render();
      return;
    }
    state = next;
    snapshot = availableSeats(state);
    save();
    confirmationNumber = state.nextNumber - 1;
    page = 'confirmation';
    feedback = 'Reservation confirmed';
    render();
  });
  for (const button of main.querySelectorAll('[data-cancel]')) button.addEventListener('click', () => {
    const record = state.reservations.find(item => item.number === Number(button.dataset.cancel));
    if (record.status === 'Cancelled') return;
    state = reservationReducer(state, { type: 'cancel', number: record.number });
    save();
    feedback = 'Reservation cancelled';
    render();
  });
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[data-page]');
  if (!link) return;
  event.preventDefault();
  page = link.dataset.page;
  selectedSeats = 1;
  feedback = '';
  render();
});
render();
`,
    "rules.mjs": `export function availableSeats(state) {
  return 2 - state.reservations.filter(record => record.status === 'Active').reduce((total, record) => total + record.seats, 0);
}

export function reservationReducer(state, action) {
  if (action.type === 'reserve') {
    if (![1, 2].includes(action.seats) || action.seats > availableSeats(state)) return state;
    return {
      nextNumber: state.nextNumber + 1,
      reservations: [...state.reservations, { number: state.nextNumber, seats: action.seats, status: 'Active' }],
    };
  }
  if (action.type === 'cancel') {
    return { ...state, reservations: state.reservations.map(record => record.number === action.number && record.status === 'Active' ? { ...record, status: 'Cancelled' } : record) };
  }
  return state;
}
`,
    "view.mjs": `import { availableSeats } from './rules.mjs';

export function formAvailability(state, snapshot) {
  return availableSeats(state);
}
`,
    "lower/rules.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
import { availableSeats, reservationReducer } from '../rules.mjs';

test('workshop reservations and cancellations', () => {
  const empty = { nextNumber: 1, reservations: [] };
  assert.equal(availableSeats(empty), 2);
  assert.equal(reservationReducer(empty, { type: 'reserve', seats: 0 }), empty);
  const twoSeats = reservationReducer(empty, { type: 'reserve', seats: 2 });
  assert.deepEqual(twoSeats, { nextNumber: 2, reservations: [{ number: 1, seats: 2, status: 'Active' }] });
  assert.equal(availableSeats(twoSeats), 0);
  assert.equal(reservationReducer(twoSeats, { type: 'reserve', seats: 1 }), twoSeats);
  const cancelled = reservationReducer(twoSeats, { type: 'cancel', number: 1 });
  assert.equal(availableSeats(cancelled), 2);
  assert.deepEqual(cancelled.reservations, [{ number: 1, seats: 2, status: 'Cancelled' }]);
  assert.deepEqual(reservationReducer(cancelled, { type: 'cancel', number: 1 }), cancelled);
  const oneSeat = reservationReducer(empty, { type: 'reserve', seats: 1 });
  assert.equal(availableSeats(oneSeat), 1);
  const twoRecords = reservationReducer(oneSeat, { type: 'reserve', seats: 1 });
  assert.equal(availableSeats(twoRecords), 0);
  const released = reservationReducer(twoRecords, { type: 'cancel', number: 1 });
  assert.equal(availableSeats(released), 1);
  assert.deepEqual(released.reservations, [{ number: 1, seats: 1, status: 'Cancelled' }, { number: 2, seats: 1, status: 'Active' }]);
  assert.equal(availableSeats(reservationReducer(released, { type: 'cancel', number: 2 })), 2);
});
`,
  },
  lowerExit: 0,
  mutationFile: 'view.mjs',
  mutation: ["return availableSeats(state);", "return snapshot;"],
  strong: `await screen.getByRole('button', 'Reserve seats').tap();
  await screen.getByLabel('Seats').selectOption({ value: '2' });
  await screen.getByRole('button', 'Confirm reservation').tap();
  await expect(screen.getByRole('status', 'Reservation feedback')).toHaveText('Reservation confirmed');
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 0');
  await expect(screen.getByRole('status', 'Reservation 1 details')).toHaveText('Reservation 1 | Clay basics | Seats 2 | Active');
  await screen.getByRole('link', 'Reservations').tap();
  await screen.getByRole('button', 'Cancel reservation 1').tap();
  await expect(screen.getByRole('status', 'Reservation 1 details')).toHaveText('Reservation 1 | Clay basics | Seats 2 | Cancelled');
  await screen.getByRole('link', 'Workshops').tap();
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 2');
  await screen.getByRole('button', 'Reserve seats').tap();
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 2');
  await screen.getByLabel('Seats').selectOption({ value: '2' });
  await screen.getByRole('button', 'Confirm reservation').tap();
  await expect(screen.getByRole('status', 'Reservation 2 details')).toHaveText('Reservation 2 | Clay basics | Seats 2 | Active');
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 0');`,
  weak: `await screen.getByRole('button', 'Reserve seats').tap();
  await screen.getByRole('button', 'Confirm reservation').tap();
  await expect(screen.getByRole('status', 'Reservation 1 details')).toHaveText('Reservation 1 | Clay basics | Seats 1 | Active');
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 1');
  await screen.getByRole('link', 'Reservations').tap();
  await screen.getByRole('button', 'Cancel reservation 1').tap();
  await expect(screen.getByRole('status', 'Reservation feedback')).toHaveText('Reservation cancelled');
  await expect(screen.getByRole('status', 'Reservation 1 details')).toHaveText('Reservation 1 | Clay basics | Seats 1 | Cancelled');
  await screen.getByRole('link', 'Workshops').tap();
  await expect(screen.getByRole('status', 'Available seats')).toHaveText('Available seats 2');`,
  expected: "Available seats 2",
} satisfies HardFixture;
