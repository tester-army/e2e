/**
 * Dogfood app: a small expense-claims tool with the rough edges of a real
 * product — async saves with a spinner, client-side validation, a confirm
 * modal, a filter, a password-gated admin panel, and a drag-only archive
 * zone. Server-backed state so project tools can seed and reset it.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4310);
const SAVE_DELAY_MS = 1_200;

/** @type {{ id: number; description: string; amount: number; category: string }[]} */
let expenses = [];
let nextId = 1;

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Expense claims</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 640px; }
    .error { color: #b00020; }
    .toast { background: #e6f4ea; padding: 0.5rem; }
    dialog::backdrop { background: rgb(0 0 0 / 40%); }
    #archive { border: 2px dashed #999; padding: 1rem; margin-top: 2rem; color: #666; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <h1>Expense claims</h1>

  <form id="claim-form">
    <label for="description">Description</label>
    <input id="description" autocomplete="off" />
    <label for="amount">Amount</label>
    <input id="amount" inputmode="decimal" autocomplete="off" />
    <label for="category">Category</label>
    <select id="category">
      <option>Meals</option>
      <option>Travel</option>
      <option>Equipment</option>
    </select>
    <button id="add" type="submit">Add expense</button>
    <span id="saving" role="status" aria-label="Save state" hidden>Saving…</span>
  </form>
  <p id="form-error" class="error" role="alert" hidden></p>
  <p id="toast" class="toast" role="status" aria-label="Notice" hidden></p>

  <label for="filter">Filter</label>
  <select id="filter">
    <option>All</option>
    <option>Meals</option>
    <option>Travel</option>
    <option>Equipment</option>
  </select>

  <ul id="list" aria-label="Expenses"></ul>
  <p><output role="status" aria-label="Total">Total: $0.00</output></p>

  <dialog id="confirm">
    <p id="confirm-text">Delete this expense?</p>
    <button id="confirm-yes">Delete</button>
    <button id="confirm-no">Keep</button>
  </dialog>

  <div id="archive" aria-label="Archive zone">Drag an expense here to archive it</div>

  <h2>Admin</h2>
  <label for="admin-password">Admin password</label>
  <input id="admin-password" type="password" autocomplete="off" />
  <button id="admin-open">Open admin panel</button>
  <p id="admin-error" class="error" role="alert" hidden></p>
  <section id="admin-panel" hidden>
    <h3>Admin panel</h3>
    <p>Quarterly budget: $12,000</p>
  </section>

  <script>
    let pendingDelete = null;

    async function refresh() {
      const filter = document.getElementById('filter').value;
      const expenses = await (await fetch('/api/expenses')).json();
      const visible = filter === 'All' ? expenses : expenses.filter((e) => e.category === filter);
      const list = document.getElementById('list');
      list.innerHTML = '';
      for (const expense of visible) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = expense.description + ' — $' + expense.amount.toFixed(2) + ' (' + expense.category + ')';
        const remove = document.createElement('button');
        remove.textContent = 'Delete ' + expense.description;
        remove.addEventListener('click', () => {
          pendingDelete = expense.id;
          document.getElementById('confirm-text').textContent = 'Delete "' + expense.description + '"?';
          document.getElementById('confirm').showModal();
        });
        item.append(label, ' ', remove);
        list.append(item);
      }
      const total = visible.reduce((sum, e) => sum + e.amount, 0);
      document.querySelector('output').textContent = 'Total: $' + total.toFixed(2);
    }

    function showError(text) {
      const error = document.getElementById('form-error');
      error.textContent = text;
      error.hidden = false;
    }

    document.getElementById('claim-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      document.getElementById('form-error').hidden = true;
      document.getElementById('toast').hidden = true;
      const description = document.getElementById('description').value.trim();
      const amount = Number(document.getElementById('amount').value);
      if (description === '') return showError('Description is required');
      if (!Number.isFinite(amount) || amount <= 0) return showError('Amount must be a positive number');
      const button = document.getElementById('add');
      button.disabled = true;
      document.getElementById('saving').hidden = false;
      await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description, amount, category: document.getElementById('category').value }),
      });
      button.disabled = false;
      document.getElementById('saving').hidden = true;
      document.getElementById('description').value = '';
      document.getElementById('amount').value = '';
      const toast = document.getElementById('toast');
      toast.textContent = 'Expense saved';
      toast.hidden = false;
      await refresh();
    });

    document.getElementById('filter').addEventListener('change', refresh);
    document.getElementById('confirm-yes').addEventListener('click', async () => {
      await fetch('/api/expenses/' + pendingDelete, { method: 'DELETE' });
      document.getElementById('confirm').close();
      await refresh();
    });
    document.getElementById('confirm-no').addEventListener('click', () => {
      document.getElementById('confirm').close();
    });

    document.getElementById('admin-open').addEventListener('click', () => {
      const password = document.getElementById('admin-password').value;
      const error = document.getElementById('admin-error');
      if (password === 'hunter2') {
        document.getElementById('admin-panel').hidden = false;
        error.hidden = true;
      } else {
        error.textContent = 'Invalid admin password';
        error.hidden = false;
      }
    });

    refresh();
  </script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status, body, type = 'application/json') => {
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  };

  if (url.pathname === '/' && request.method === 'GET') {
    return send(200, PAGE, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/api/expenses' && request.method === 'GET') {
    return send(200, JSON.stringify(expenses));
  }
  if (url.pathname === '/api/expenses' && request.method === 'POST') {
    const body = JSON.parse(await readBody(request));
    await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS));
    expenses.push({ id: nextId++, description: body.description, amount: body.amount, category: body.category });
    return send(201, JSON.stringify(expenses.at(-1)));
  }
  if (url.pathname.startsWith('/api/expenses/') && request.method === 'DELETE') {
    const id = Number(url.pathname.split('/').at(-1));
    expenses = expenses.filter((expense) => expense.id !== id);
    return send(204, '');
  }
  if (url.pathname === '/api/reset' && request.method === 'POST') {
    expenses = [];
    nextId = 1;
    return send(200, '{"ok":true}');
  }
  if (url.pathname === '/api/seed' && request.method === 'POST') {
    const body = JSON.parse((await readBody(request)) || '{}');
    const count = Math.min(Number(body.count ?? 2), 10);
    for (let index = 0; index < count; index += 1) {
      expenses.push({
        id: nextId++,
        description: `Seeded expense ${nextId - 1}`,
        amount: 10 * (index + 1),
        category: index % 2 === 0 ? 'Meals' : 'Travel',
      });
    }
    return send(200, JSON.stringify({ seeded: count, total: expenses.length }));
  }
  send(404, '{"error":"not found"}');
});

function readBody(request) {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dogfood app on http://127.0.0.1:${PORT}`);
});
