/**
 * The bug garden: a small bookshop with planted defects of different kinds, so
 * `e2e explore` runs can be scored against known ground truth. No
 * dependencies; state lives in memory and resets when the process starts.
 *
 * Planted defects (`scripts/explore-bench.mjs` keys on these ids):
 *
 *   B1  navigation      the "Help" link in the header goes to /hlep, a 404
 *   B2  dead control    "Add to cart" on Dune does nothing
 *   B3  calculation     the cart total ignores quantities (sums unit prices)
 *   B4  wrong target    "Remove" always removes the first cart row
 *   B5  persistence     saving the account profile reports success but keeps the old name
 *   B6  dates           the order confirmation is dated 1970 and delivers before it was placed
 *   B7  security        the password field is a plain text input (the shop's one account is ada@example.test / bookworm)
 *   B8  copy            the home greeting leaks the template token {{userName}}
 *   B9  data            Neuromancer shows a negative stock count
 *   B10 inconsistency   the orders page says "2 orders" above a list of one
 *   W1  copy (minor)    "Recieve" is misspelled on the checkout form
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4275);

const BOOKS = [
  { id: 'dune', title: 'Dune', author: 'Frank Herbert', price: 12.5, stock: 4 },
  { id: 'neuromancer', title: 'Neuromancer', author: 'William Gibson', price: 9.99, stock: -3 },
  { id: 'hyperion', title: 'Hyperion', author: 'Dan Simmons', price: 14.0, stock: 7 },
  { id: 'solaris', title: 'Solaris', author: 'Stanisław Lem', price: 11.25, stock: 2 },
];

/** The shop's one account; the testbed config hands it to the explorer as a credential. */
const ACCOUNT = { email: 'ada@example.test', password: 'bookworm' };

const state = {
  /** Cart rows in insertion order: { id, qty }. */
  cart: [],
  profile: { name: 'Ada Lovelace', email: 'ada@example.test' },
  /** B5: the name a save stores, shown only after the next save. */
  pendingName: undefined,
  orders: [{ id: 1041, total: 23.99, placed: '2026-08-30' }],
  signedIn: false,
};

const money = (value) => `$${value.toFixed(2)}`;

const layout = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} · Bookshelf</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 720px; }
    nav a { margin-right: 0.75rem; }
    table { border-collapse: collapse; }
    td, th { padding: 0.25rem 0.75rem; text-align: left; }
    .muted { color: #666; }
  </style>
</head>
<body>
  <nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/catalog">Catalog</a>
    <a href="/cart">Cart</a>
    <a href="/account">Account</a>
    <a href="/orders">Orders</a>
    <a href="/login">${state.signedIn ? 'Sign out' : 'Sign in'}</a>
    <a href="/hlep">Help</a>
  </nav>
  <main>${body}</main>
</body>
</html>`;

const cartCount = () => state.cart.reduce((sum, row) => sum + row.qty, 0);

const pages = {
  '/': () =>
    layout(
      'Home',
      `<h1>Bookshelf</h1>
       <p role="status" aria-label="Greeting">Welcome, {{userName}}! You have ${cartCount()} item(s) in your cart.</p>
       <p>Four science fiction classics, shipped anywhere.</p>
       <p><a href="/catalog">Browse the catalog</a></p>`,
    ),

  '/catalog': () =>
    layout(
      'Catalog',
      `<h1>Catalog</h1>
       <ul>
         ${BOOKS.map(
           (book) => `<li>
             <article aria-label="${book.title}">
               <h2>${book.title}</h2>
               <p class="muted">${book.author}</p>
               <p>Price: ${money(book.price)} · In stock: ${book.stock}</p>
               <form method="post" action="/cart/add" ${book.id === 'dune' ? 'onsubmit="event.preventDefault()"' : ''}>
                 <input type="hidden" name="id" value="${book.id}" />
                 <button type="submit">Add to cart</button>
               </form>
             </article>
           </li>`,
         ).join('')}
       </ul>`,
    ),

  '/cart': (request) => {
    const rows = state.cart.map((row) => ({ ...row, book: BOOKS.find((book) => book.id === row.id) }));
    // B3: the total ignores quantities.
    const total = rows.reduce((sum, row) => sum + row.book.price, 0);
    return layout(
      'Cart',
      `<h1>Cart</h1>
       ${request.added ? `<p role="status">Added ${escapeHtml(request.added)} to your cart.</p>` : ''}
       ${
         rows.length === 0
           ? '<p>Your cart is empty. <a href="/catalog">Browse the catalog</a>.</p>'
           : `<table>
         <thead><tr><th>Book</th><th>Quantity</th><th>Unit price</th><th>Line total</th><th></th></tr></thead>
         <tbody>
           ${rows
             .map(
               (row) => `<tr>
                 <td>${row.book.title}</td>
                 <td>
                   <form method="post" action="/cart/qty" style="display:inline">
                     <input type="hidden" name="id" value="${row.id}" /><input type="hidden" name="delta" value="-1" />
                     <button type="submit" aria-label="Decrease ${row.book.title} quantity">−</button>
                   </form>
                   <span aria-label="${row.book.title} quantity">${row.qty}</span>
                   <form method="post" action="/cart/qty" style="display:inline">
                     <input type="hidden" name="id" value="${row.id}" /><input type="hidden" name="delta" value="1" />
                     <button type="submit" aria-label="Increase ${row.book.title} quantity">+</button>
                   </form>
                 </td>
                 <td>${money(row.book.price)}</td>
                 <td>${money(row.book.price * row.qty)}</td>
                 <td>
                   <form method="post" action="/cart/remove" style="display:inline">
                     <input type="hidden" name="id" value="${row.id}" />
                     <button type="submit" aria-label="Remove ${row.book.title}">Remove</button>
                   </form>
                 </td>
               </tr>`,
             )
             .join('')}
         </tbody>
       </table>
       <p><strong>Total: <span aria-label="Cart total">${money(total)}</span></strong></p>
       <p><a href="/checkout">Proceed to checkout</a></p>`
       }`,
    );
  },

  '/checkout': () =>
    layout(
      'Checkout',
      `<h1>Checkout</h1>
       <p>${cartCount()} item(s) in your cart.</p>
       <form method="post" action="/checkout">
         <label for="address">Shipping address</label>
         <input id="address" name="address" autocomplete="street-address" required />
         <label for="newsletter">Recieve the newsletter</label>
         <input id="newsletter" name="newsletter" type="checkbox" />
         <button type="submit">Place order</button>
       </form>`,
    ),

  '/orders': () =>
    layout(
      'Orders',
      `<h1>Orders</h1>
       <p role="status" aria-label="Order count">You have ${state.orders.length + 1} orders.</p>
       <ul>
         ${state.orders
           .map((order) => `<li>Order #${order.id} · ${money(order.total)} · placed ${order.placed}</li>`)
           .join('')}
       </ul>`,
    ),

  '/order-confirmation': (request) =>
    layout(
      'Order placed',
      `<h1>Thank you</h1>
       <p role="status">Order #${request.order.id} placed on ${request.order.placedShown} for ${money(request.order.total)}.</p>
       <p>Estimated delivery: ${request.order.delivery}.</p>
       <p><a href="/orders">View your orders</a></p>`,
    ),

  '/account': (request) =>
    layout(
      'Account',
      `<h1>Account</h1>
       ${request.saved ? '<p role="status">Profile saved.</p>' : ''}
       <form method="post" action="/account">
         <label for="name">Display name</label>
         <input id="name" name="name" value="${escapeHtml(state.profile.name)}" autocomplete="name" />
         <label for="email">Email</label>
         <input id="email" name="email" type="email" value="${escapeHtml(state.profile.email)}" autocomplete="email" />
         <button type="submit">Save profile</button>
       </form>`,
    ),

  '/login': (request) =>
    layout(
      'Sign in',
      `<h1>Sign in</h1>
       ${request.failed ? '<p role="alert">Enter your email and password.</p>' : ''}
       ${request.rejected ? '<p role="alert">Invalid email or password.</p>' : ''}
       <form method="post" action="/login">
         <label for="login-email">Email</label>
         <input id="login-email" name="email" type="email" autocomplete="username" />
         <label for="password">Password</label>
         <input id="password" name="password" type="text" autocomplete="current-password" />
         <button type="submit">Sign in</button>
       </form>`,
    ),
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

async function readForm(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const send = (status, headers, body) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const html = (body, status = 200) => send(status, { 'content-type': 'text/html; charset=utf-8' }, body);
  const redirect = (location) => send(303, { location }, '');

  if (request.method === 'POST') {
    const form = await readForm(request);
    if (url.pathname === '/cart/add') {
      const id = form.get('id');
      const book = BOOKS.find((candidate) => candidate.id === id);
      if (book === undefined) return html(layout('Not found', '<h1>Unknown book</h1>'), 404);
      const row = state.cart.find((candidate) => candidate.id === id);
      if (row === undefined) state.cart.push({ id, qty: 1 });
      else row.qty += 1;
      return redirect(`/cart?added=${encodeURIComponent(book.title)}`);
    }
    if (url.pathname === '/cart/qty') {
      const row = state.cart.find((candidate) => candidate.id === form.get('id'));
      if (row !== undefined) {
        row.qty = Math.max(1, row.qty + Number(form.get('delta')));
      }
      return redirect('/cart');
    }
    if (url.pathname === '/cart/remove') {
      // B4: the first row goes, whichever button was pressed.
      state.cart.shift();
      return redirect('/cart');
    }
    if (url.pathname === '/checkout') {
      // Nothing to order: back to the cart, which says so.
      if (state.cart.length === 0) return redirect('/cart');
      const total = state.cart.reduce((sum, row) => sum + BOOKS.find((book) => book.id === row.id).price * row.qty, 0);
      const order = { id: 1041 + state.orders.length, total, placed: new Date().toISOString().slice(0, 10) };
      state.orders.push(order);
      state.cart = [];
      // B6: the confirmation formats the epoch instead of the order date.
      const shown = { ...order, placedShown: new Date(0).toISOString().slice(0, 10), delivery: new Date(-3 * 86_400_000).toISOString().slice(0, 10) };
      return html(pages['/order-confirmation']({ order: shown }));
    }
    if (url.pathname === '/account') {
      // B5: the new name is stored as pending and shown only after the next save.
      if (state.pendingName !== undefined) state.profile.name = state.pendingName;
      state.pendingName = form.get('name') ?? state.profile.name;
      state.profile.email = form.get('email') ?? state.profile.email;
      return redirect('/account?saved=1');
    }
    if (url.pathname === '/login') {
      if ((form.get('email') ?? '') === '' || (form.get('password') ?? '') === '') {
        return html(pages['/login']({ failed: true }));
      }
      if (form.get('email') !== ACCOUNT.email || form.get('password') !== ACCOUNT.password) {
        return html(pages['/login']({ rejected: true }));
      }
      state.signedIn = true;
      return redirect('/account');
    }
    return html(layout('Not found', '<h1>Not found</h1>'), 404);
  }

  if (url.pathname === '/login' && state.signedIn) {
    state.signedIn = false;
    return redirect('/');
  }
  // The confirmation is rendered by the checkout POST only; the route has no page of its own.
  const page = url.pathname === '/order-confirmation' ? undefined : pages[url.pathname];
  if (page === undefined) return html(layout('Not found', `<h1>Page not found</h1><p>There is nothing at ${escapeHtml(url.pathname)}.</p>`), 404);
  return html(page({ added: url.searchParams.get('added'), saved: url.searchParams.get('saved') === '1' }));
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`bug garden listening on http://127.0.0.1:${PORT}\n`);
});
