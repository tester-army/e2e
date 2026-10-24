import { money } from './money.mjs';
import { categories, expenseView } from './expenses-domain.mjs';

const main = document.querySelector('#main');
const header = document.querySelector('#header');
const feedback = document.querySelector('#feedback');
const lists = new Map();
let state;
let pending = false;
let confirmation = null;

/** Escapes editable Unicode text for the rendered document. */
function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** Keeps a category filter in ordinary list and editor return links. */
function filterValue() {
  const value = new URLSearchParams(location.search).get('category') ?? 'All';
  return categories.includes(value) ? value : 'All';
}

/** Produces a public filter suffix without including saved account data. */
function filterSuffix(filter = filterValue()) {
  return filter === 'All' ? '' : '?category=' + filter;
}

/** Reads ordered committed data and invalidates views changed by another tab. */
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Could not load saved data');
  const next = await response.json();
  if (state && (next.revision ?? 0) <= (state.revision ?? 0)) return false;
  lists.clear();
  state = next;
  return true;
}

/** Sends one durable operation and preserves edited controls on failure. */
async function submit(command, after = () => render(), operationId = crypto.randomUUID()) {
  if (pending) return;
  pending = true;
  feedback.textContent = 'Saving...';
  const buttons = [...document.querySelectorAll('button')].map(button => [button, button.disabled]);
  for (const [button] of buttons) button.disabled = true;
  let result;
  try {
    const response = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId, command }) });
    const update = await response.json();
    if (!response.ok) throw new Error(update.error ?? 'Could not save data');
    state = update.state;
    result = update.result;
  } catch (error) {
    pending = false;
    feedback.innerHTML = '<p role="alert">' + escape(error.message) + '</p><button id="retry">Retry</button>';
    feedback.querySelector('#retry').addEventListener('click', () => submit(command, after, operationId));
    for (const [button, disabled] of buttons) if (button.isConnected) button.disabled = disabled;
    return;
  }
  pending = false;
  feedback.textContent = '';
  try { await after(result); } catch (error) { showReadError(error); }
}

/** Invalidates category membership and totals after an acknowledged edit. */
function invalidateExpenseLists() {
  lists.clear();
}

/** Returns the cached list projection for the active saved filter. */
function visibleList(filter) {
  if (!lists.has(filter)) lists.set(filter, expenseView(state.expenses, filter));
  return lists.get(filter);
}

/** Preserves filter history while reading the current committed aggregate. */
async function navigate(url, replace = false) {
  if (pending) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  await refresh();
  confirmation = null;
  feedback.textContent = '';
  render();
}

/** Sends exactly the visible editor's three fields to the production reducer. */
async function saveEditor(expense, form) {
  const fields = new FormData(form);
  const submittedCategory = fields.get('category');
  await submit({ type: expense ? 'expense.edit' : 'expense.add', ...(expense ? { id: expense.id } : {}), description: fields.get('description'), amount: fields.get('amount'), category: submittedCategory }, async () => {
    invalidateExpenseLists();
    await navigate('/expenses' + filterSuffix());
  });
}

/** Renders list, editor and overview from saved expense identities. */
function render() {
  const path = location.pathname;
  const filter = filterValue();
  header.innerHTML = '<h1>Everyday expenses</h1><p>Signed in as Ada Green</p><nav><a href="/expenses' + filterSuffix() + '">Expenses</a><a href="/expenses/overview">Overview</a></nav>';
  if (path === '/' || path === '/expenses') {
    if (path === '/') history.replaceState(null, '', '/expenses');
    const view = visibleList(filter);
    main.innerHTML = '<h2>Expenses</h2><form id="filter"><label>Category filter<select name="category">' + ['All', ...categories].map(category => '<option' + (category === filter ? ' selected' : '') + '>' + category + '</option>').join('') + '</select></label><button>Apply filter</button></form><a href="/expenses/new' + filterSuffix() + '">Add expense</a><section aria-label="Expense list"><h2>' + filter + ' expenses</h2>' +
      (view.records.length ? '<ul>' + view.records.map(expense => '<li><article aria-label="Expense ' + expense.id + '"><h3>' + escape(expense.description) + '</h3><p>Expense ID ' + expense.id + '</p><p>' + escape(expense.category) + '</p><p>' + money(expense.amountCents) + '</p><a href="/expenses/' + expense.id + filterSuffix() + '">Edit ' + expense.id + '</a><button data-delete="' + expense.id + '">Delete ' + expense.id + '</button></article></li>').join('') + '</ul>' : '<p>No expenses</p>') +
      '<p>Total <output aria-label="Expense total">' + money(view.total) + '</output></p></section><button id="reset">Reset demo data</button>';
    main.querySelector('#filter').addEventListener('submit', event => { event.preventDefault(); const chosen = new FormData(event.target).get('category'); navigate('/expenses' + filterSuffix(chosen)).catch(showReadError); });
    main.querySelector('#reset').addEventListener('click', () => { confirmation = { message: 'Reset demo data?', command: { type: 'reset' }, reset: true }; render(); });
    for (const button of main.querySelectorAll('[data-delete]')) button.addEventListener('click', () => { confirmation = { message: 'Delete ' + button.dataset.delete + '?', command: { type: 'expense.delete', id: button.dataset.delete } }; render(); });
  } else if (path === '/expenses/overview') {
    const view = expenseView(state.expenses);
    main.innerHTML = '<h2>Overview</h2><section aria-label="All expenses"><h2>All expenses</h2>' + (view.records.length ? '<ul>' + view.records.map(expense => '<li>' + expense.id + ' ' + escape(expense.description) + ' ' + escape(expense.category) + ' ' + money(expense.amountCents) + '</li>').join('') + '</ul>' : '<p>No expenses</p>') + '<p>Total <output aria-label="Overview total">' + money(view.total) + '</output></p></section>';
  } else if (path.startsWith('/expenses/')) {
    const id = path.slice('/expenses/'.length);
    const expense = id === 'new' ? null : state.expenses.find(entry => entry.id === id);
    if (id !== 'new' && !expense) main.innerHTML = '<h2>Expense not found</h2><a href="/expenses' + filterSuffix() + '">Back to expenses</a>';
    else {
      main.innerHTML = '<h2>' + (expense ? 'Edit expense ' + expense.id : 'Add expense') + '</h2>' + (expense ? '<p>Created UTC ' + new Date(expense.createdAt).toISOString() + '</p>' : '') + '<form id="editor"><label>Description<input name="description" value="' + escape(expense?.description ?? '') + '"></label><label>Amount<input name="amount" inputmode="decimal" value="' + (expense ? money(expense.amountCents).slice(1) : '') + '"></label><label>Category<select name="category">' + categories.map(category => '<option' + (expense?.category === category ? ' selected' : '') + '>' + category + '</option>').join('') + '</select></label><button>Save expense</button></form><a href="/expenses' + filterSuffix() + '">Cancel</a><a href="/expenses' + filterSuffix() + '">Back to expenses</a>';
      main.querySelector('#editor').addEventListener('submit', event => { event.preventDefault(); saveEditor(expense, event.target); });
    }
  } else main.innerHTML = '<h2>Page not found</h2>';
  if (confirmation) {
    const current = confirmation;
    main.insertAdjacentHTML('beforeend', '<section role="dialog" aria-label="Confirmation"><h2>' + escape(current.message) + '</h2><button id="confirm">Confirm</button><button id="cancel-confirm">Cancel</button></section>');
    main.querySelector('#confirm').addEventListener('click', () => submit(current.command, async () => { lists.clear(); confirmation = null; if (current.reset) await navigate('/expenses', true); else render(); }));
    main.querySelector('#cancel-confirm').addEventListener('click', () => { confirmation = null; render(); });
  }
}

/** Presents an ordinary retry after a failed navigation read. */
function showReadError(error) {
  feedback.innerHTML = '<p role="alert">' + escape(error.message) + '</p><button id="retry-read">Retry</button>';
  feedback.querySelector('#retry-read').addEventListener('click', () => navigate(location.pathname + location.search, true).catch(showReadError));
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search).catch(showReadError);
});
window.addEventListener('popstate', async () => { try { await refresh(); confirmation = null; render(); } catch (error) { showReadError(error); } });
window.addEventListener('focus', async () => { if (!pending) { try { if (await refresh()) render(); } catch (error) { showReadError(error); } } });
try { await refresh(); render(); } catch (error) { showReadError(error); }
