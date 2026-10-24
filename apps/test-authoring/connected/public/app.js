import { products, parseQuery, normalizeQuery, querySuffix, searchProducts } from './catalog.mjs';
import { money } from './money.mjs';
import { resolveShipping, quoteBasket, canCancelV1, canCancelV2, sortedOrders } from './shop-domain.mjs';

const main = document.querySelector('#main');
const header = document.querySelector('#header');
const feedback = document.querySelector('#feedback');
let state;
let pending = false;
let retry = null;
let query = '';
let invalidQuery = false;
let draftDestination = null;
let previousPath = location.pathname;
let accountReturn = false;
let cachedDiscount = null;
let currentQuote = null;
let confirmation = null;

/** Escapes text before putting it in ordinary HTML controls. */
function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** Reads current durable data after prior submissions in this profile. */
async function refresh() {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('Could not load saved data');
  const next = await response.json();
  if (state && (next.revision ?? 0) <= (state.revision ?? 0)) return false;
  draftDestination = null;
  cachedDiscount = null;
  state = next;
  return true;
}

/** Sends a stable operation ID and leaves data-backed DOM unchanged until acknowledgment. */
async function submit(command, after = () => render(), operationId = crypto.randomUUID()) {
  if (pending) return;
  pending = true;
  retry = null;
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
    retry = () => submit(command, after, operationId);
    feedback.innerHTML = '<p role="alert">' + escape(error.message) + '</p><button type="button" id="retry">Retry</button>';
    feedback.querySelector('#retry').addEventListener('click', retry);
    for (const [button, disabled] of buttons) if (button.isConnected) button.disabled = disabled;
    return;
  }
  pending = false;
  feedback.textContent = '';
  try { await after(result); } catch (error) { showReadError(error); }
}

/** Reads raw query text and keeps invalid links out of partial catalog searches. */
function restoreCatalog() {
  try { query = parseQuery(location.search); invalidQuery = false; }
  catch { query = ''; invalidQuery = true; }
  if (!invalidQuery) history.replaceState(null, '', location.pathname + querySuffix(query));
}

/** Restores checkout selection at a route boundary from stable durable IDs. */
function restoreDraft(returningFromAccount) {
  const restoredManualId = state.draft?.manualAddressId ?? null;
  const resolved = resolveShipping(state.addresses, state.defaultAddressId, restoredManualId);
  if (returningFromAccount) draftDestination = null;
  draftDestination ??= resolved;
}

/** Keeps quote projection invalidation in the browser basket adapter. */
function basketChanged() {
  cachedDiscount = null;
}

/** Restores a quote with the catalog's complete merchandise eligibility. */
function restoreReviewQuote() {
  const reviewCatalog = products.map(product => ({ ...product, eligibleMerchandise: product.eligibleMerchandise }));
  cachedDiscount = quoteBasket(state.basket, state.code, reviewCatalog).discount;
}

/** Reuses the promotion projection until a basket command invalidates it. */
function quoteForPage() {
  const quote = quoteBasket(state.basket, state.code);
  cachedDiscount ??= quote.discount;
  return { ...quote, discount: cachedDiscount, payable: quote.subtotal + quote.delivery - cachedDiscount };
}

/** Renders the amount fields shared by basket, review and receipt. */
function quoteMarkup(quote, code) {
  return '<section aria-label="Quote"><h2>Quote</h2><dl>' + [
    ['Merchandise', quote.subtotal], ['Promotion discount', quote.discount], ['Delivery', quote.delivery], ['Total', quote.payable],
  ].map(([name, cents]) => '<dt>' + name + '</dt><dd><output aria-label="' + name + '">' + money(cents) + '</output></dd>').join('') + '</dl>' + (code ? '<p>Applied code ' + escape(code) + '</p><p role="status" aria-label="Promotion eligibility">' + (quote.discount ? 'Eligible' : 'Not eligible') + '</p>' : '') + '</section>';
}

/** Renders a shipping copy without conflating repeated labels. */
function destinationMarkup(destination) {
  return destination ? '<section aria-label="Shipping destination"><h2>Shipping destination</h2><p>' + [destination.recipient, destination.street, destination.city + ' ' + destination.postalCode, destination.country].map(escape).join('<br>') + '</p><p>Address ID ' + escape(destination.id) + '</p></section>' : '<p role="alert">A shipping address is required</p>';
}

/** Renders a product with its own stable identity and accessible actions. */
function productMarkup(product, detailed = false) {
  const saved = state.wishlist.includes(product.id);
  return '<article aria-label="Product ' + escape(product.id) + '"><h2>' + escape(product.name) + '</h2><p>Product ID ' + product.id + '</p><p>' + money(product.priceCents) + '</p>' +
    (!detailed ? '<a href="/products/' + product.id + querySuffix(query) + '">View ' + escape(product.name) + '</a>' : '') +
    '<form data-add="' + product.id + '"><label>Quantity ' + escape(product.name) + '<input name="quantity" inputmode="numeric" value="1"></label><button>Add ' + escape(product.name) + ' to basket</button></form>' +
    '<button type="button" data-wish="' + product.id + '" data-saved="' + saved + '">' + (saved ? 'Unsave ' : 'Save ') + escape(product.name) + '</button></article>';
}

/** Retains committed order identity, destination and amount copies. */
function orderMarkup(order, receipt = false) {
  return '<article aria-label="Order ' + order.id + '"><h2>' + order.id + '</h2><p>Policy version ' + order.policyVersion + '</p><p>Created UTC ' + new Date(order.createdAt).toISOString() + '</p><p>Status <output aria-label="Status ' + order.id + '">' + escape(order.status) + '</output></p>' + destinationMarkup(order.destination) +
    (receipt ? '<section aria-label="Purchased items"><h2>Purchased items</h2><ul>' + order.lines.map(line => '<li>' + escape(line.name) + ' Quantity ' + line.quantity + ' Line amount ' + money(line.priceCents * line.quantity) + '</li>').join('') + '</ul></section>' + quoteMarkup(order.quote, order.code) : '') + '</article>';
}

/** Selects policy adapters independently for list and detail entry points. */
function detailEligibility(order) {
  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');
  return order.policyVersion === 2 ? canCancelV2(order) : canCancelV1(order);
}

/** Selects the list's stored-version policy. */
function listEligibility(order) {
  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');
  return order.policyVersion === 2 ? canCancelV2(order) : canCancelV1(order);
}

/** Keeps wishlist persistence at the UI provider's command boundary. */
async function saveProduct(id) {
  await submit({ type: 'wishlist.save', id });
}

/** Persists removal before acknowledging changed membership. */
async function unsaveProduct(id) {
  await submit({ type: 'wishlist.unsave', id });
}

/** Shows ordinary visible confirmation controls for reset, delete and cancellation. */
function confirmAction(message, command, after) {
  confirmation = { message, command, after };
  render();
}

/** Navigates with ordinary URL history and refreshes current committed state. */
async function navigate(url, replace = false, historyRestoration = false) {
  if (pending) return;
  const oldPath = previousPath;
  if (!historyRestoration) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  await refresh();
  const path = location.pathname;
  if (path === '/catalog' || path.startsWith('/products/')) restoreCatalog();
  accountReturn ||= oldPath.startsWith('/account') && (path === '/checkout' || path === '/checkout/review');
  if (path === '/checkout' || path === '/checkout/review') {
    restoreDraft(accountReturn);
    if (path === '/checkout/review') restoreReviewQuote();
    accountReturn = false;
  }
  previousPath = path;
  confirmation = null;
  feedback.textContent = '';
  render();
}

/** Renders each connected route from the last acknowledged aggregate. */
function render() {
  const path = location.pathname;
  header.innerHTML = '<h1>Green Trail</h1><p>Signed in as Ada Green</p><nav aria-label="Shop"><a href="/">Home</a><a href="/catalog">Catalog</a><a href="/cart">Basket</a><a href="/account">Account</a><a href="/account/wishlist">Saved products <output aria-label="Saved count">' + state.wishlist.length + '</output></a></nav>';
  if (path === '/') main.innerHTML = '<h2>Welcome, Ada</h2><p>Explore the catalog and manage your account.</p><a href="/catalog">Browse catalog</a>';
  else if (path === '/catalog') {
    main.innerHTML = '<h2>Catalog</h2>' + (invalidQuery ? '<p role="alert">Invalid search link</p><button type="button" id="clear-search">Clear search</button>' :
      '<form id="search"><label>Search products<input name="query" value="' + escape(query) + '"></label><button>Search</button><button type="button" id="clear-search">Clear search</button></form><section aria-label="Search results"><h2>Search results</h2>' + (searchProducts(query).map(product => productMarkup(product)).join('') || '<p>No products</p>') + '</section>');
    main.querySelector('#search')?.addEventListener('submit', event => {
      event.preventDefault();
      try { query = normalizeQuery(new FormData(event.target).get('query')); invalidQuery = false; history.replaceState(null, '', '/catalog' + querySuffix(query)); render(); }
      catch { invalidQuery = true; render(); }
    });
    main.querySelector('#clear-search')?.addEventListener('click', () => { query = ''; invalidQuery = false; history.replaceState(null, '', '/catalog'); render(); });
  } else if (path.startsWith('/products/')) {
    if (invalidQuery) { main.innerHTML = '<p role="alert">Invalid search link</p><button id="clear-invalid-search">Clear search</button>'; main.querySelector('#clear-invalid-search').addEventListener('click', () => navigate('/catalog', true)); return; }
    const product = products.find(entry => entry.id === path.slice('/products/'.length));
    const returnQuery = parseQuery(location.search);
    query = '';
    main.innerHTML = '<a href="/catalog' + querySuffix(returnQuery) + '">Back to catalog</a>' + (product ? productMarkup(product, true) : '<h2>Product not found</h2>');
  } else if (path === '/cart') {
    currentQuote = quoteForPage();
    main.innerHTML = '<h2>Basket</h2><section aria-label="Basket lines"><h2>Basket lines</h2>' + (state.basket.length ? state.basket.map(line => {
      const product = products.find(entry => entry.id === line.productId);
      return '<article aria-label="Basket line ' + line.productId + '"><h3>' + escape(product.name) + '</h3><p>Product ID ' + line.productId + '</p><p>Line amount <output aria-label="Line amount ' + line.productId + '">' + money(product.priceCents * line.quantity) + '</output></p><form data-quantity="' + line.productId + '"><label>Quantity ' + escape(product.name) + '<input name="quantity" value="' + line.quantity + '"></label><button>Update ' + escape(product.name) + ' quantity</button></form><button data-remove="' + line.productId + '">Remove ' + escape(product.name) + '</button></article>';
    }).join('') : '<p>Your basket is empty</p>') + '</section><form id="promotion"><label>Promotion code<input name="code" value="' + escape(state.code ?? '') + '"></label><button>Apply code</button></form>' + (state.code ? '<button id="remove-code">Remove code</button>' : '') + quoteMarkup(currentQuote, state.code) + '<button id="checkout"' + (state.basket.length ? '' : ' disabled') + '>Checkout</button>';
    for (const form of main.querySelectorAll('[data-quantity]')) form.addEventListener('submit', event => { event.preventDefault(); submit({ type: 'basket.quantity', id: form.dataset.quantity, quantity: new FormData(form).get('quantity') }, () => { basketChanged(); render(); }); });
    for (const button of main.querySelectorAll('[data-remove]')) button.addEventListener('click', () => submit({ type: 'basket.remove', id: button.dataset.remove }, () => { basketChanged(); render(); }));
    main.querySelector('#promotion').addEventListener('submit', event => { event.preventDefault(); submit({ type: 'code.apply', code: new FormData(event.target).get('code') }, () => { basketChanged(); render(); }); });
    main.querySelector('#remove-code')?.addEventListener('click', () => submit({ type: 'code.remove' }, () => { basketChanged(); render(); }));
    main.querySelector('#checkout').addEventListener('click', () => submit({ type: 'checkout.start' }, async () => { draftDestination = null; await navigate('/checkout'); }));
  } else if (path === '/checkout' || path === '/checkout/review') {
    if (!state.basket.length) main.innerHTML = '<h2>Checkout</h2><p>Your basket is empty</p><a href="/cart">Back to basket</a>';
    else if (!state.draft) main.innerHTML = '<h2>Checkout</h2><p>Start checkout from your basket.</p><a href="/cart">Back to basket</a>';
    else {
      if (!draftDestination) restoreDraft(false);
      currentQuote = quoteForPage();
      main.innerHTML = '<h2>' + (path.endsWith('/review') ? 'Review order' : 'Checkout') + '</h2><a href="/cart">Edit basket</a> <a href="/account/addresses">Manage shipping addresses</a>' + destinationMarkup(draftDestination) +
        (path === '/checkout' ? '<form id="shipping"><label>Shipping address<select name="address">' + state.addresses.map(address => '<option value="' + address.id + '"' + (draftDestination?.id === address.id ? ' selected' : '') + '>' + escape(address.label + ' | ' + address.street + ' | ' + address.id) + '</option>').join('') + '</select></label><button' + (state.addresses.length ? '' : ' disabled') + '>Use selected address</button></form><button id="use-default">Use account default</button>' : '<section aria-label="Review items"><h2>Review items</h2><ul>' + state.basket.map(line => { const product = products.find(entry => entry.id === line.productId); return '<li>' + escape(product.name) + ' Quantity ' + line.quantity + ' Line amount ' + money(product.priceCents * line.quantity) + '</li>'; }).join('') + '</ul></section>') +
        quoteMarkup(currentQuote, state.code) + (path === '/checkout' ? '<a href="/checkout/review">Review order</a>' : '<button id="place-order"' + (draftDestination ? '' : ' disabled') + '>Place order ' + money(currentQuote.payable) + '</button>');
      main.querySelector('#shipping')?.addEventListener('submit', event => { event.preventDefault(); submit({ type: 'checkout.choose', id: new FormData(event.target).get('address') }, () => { draftDestination = null; restoreDraft(false); render(); }); });
      main.querySelector('#use-default')?.addEventListener('click', () => submit({ type: 'checkout.choose', id: null }, () => { draftDestination = null; restoreDraft(false); render(); }));
      main.querySelector('#place-order')?.addEventListener('click', () => submit({ type: 'order.place' }, async id => { cachedDiscount = null; draftDestination = null; await navigate('/orders/' + id + '/receipt'); }));
    }
  } else if (/^\/orders\/[^/]+\/receipt$/.test(path)) {
    const order = state.orders.find(entry => entry.id === path.split('/')[2]);
    main.innerHTML = order ? '<h2>Receipt</h2><p role="status" aria-label="Order status">Order placed</p>' + orderMarkup(order, true) + '<a href="/catalog">Continue shopping</a>' : '<h2>Order not found</h2>';
  } else if (path === '/account') {
    main.innerHTML = '<h2>Account</h2><p>Account ID account-ada</p><nav aria-label="Account"><a href="/account/addresses">Shipping addresses</a><a href="/account/orders">Orders</a><a href="/account/wishlist">Wishlist</a></nav><button id="reset">Reset demo data</button>';
    main.querySelector('#reset').addEventListener('click', () => confirmAction('Reset demo data?', { type: 'reset' }, async () => { query = ''; draftDestination = null; cachedDiscount = null; await navigate('/', true); }));
  } else if (path === '/account/addresses') {
    main.innerHTML = '<h2>Shipping addresses</h2><a href="/checkout">Return to checkout</a>' + (state.addresses.length ? state.addresses.map(address => '<article aria-label="Address ' + address.id + '"><h2>' + escape(address.label) + '</h2><p>Address ID ' + address.id + '</p><p>' + escape(address.recipient + ', ' + address.street + ', ' + address.city + ' ' + address.postalCode + ', ' + address.country) + '</p><p>' + (state.defaultAddressId === address.id ? 'Default shipping address' : '') + '</p><button data-default="' + address.id + '">Set default ' + address.id + '</button><button data-delete-address="' + address.id + '">Delete ' + address.id + '</button></article>').join('') : '<p>No addresses</p>') +
      '<form id="add-address"><h2>Add address</h2>' + [['label', 'Label'], ['recipient', 'Recipient'], ['street', 'Street'], ['city', 'City'], ['postalCode', 'Postal code'], ['country', 'Country']].map(([name, label]) => '<label>' + label + '<input name="' + name + '"></label>').join('') + '<button>Add address</button></form>';
    main.querySelector('#add-address').addEventListener('submit', event => { event.preventDefault(); submit({ type: 'address.add', fields: Object.fromEntries(new FormData(event.target)) }); });
    for (const button of main.querySelectorAll('[data-default]')) button.addEventListener('click', () => submit({ type: 'address.default', id: button.dataset.default }));
    for (const button of main.querySelectorAll('[data-delete-address]')) button.addEventListener('click', () => confirmAction('Delete ' + button.dataset.deleteAddress + '?', { type: 'address.delete', id: button.dataset.deleteAddress }));
  } else if (path === '/account/wishlist') {
    main.innerHTML = '<h2>Wishlist</h2><section aria-label="Saved products"><h2>Saved products</h2>' + (state.wishlist.length ? state.wishlist.map(id => productMarkup(products.find(product => product.id === id))).join('') : '<p>No saved products</p>') + '</section>';
  } else if (path === '/account/orders') {
    main.innerHTML = '<h2>Orders</h2>' + (state.orders.length ? sortedOrders(state.orders).map(order => {
      let eligible = false, error = '';
      try { eligible = listEligibility(order); } catch (cause) { error = '<p role="alert">' + escape(cause.message) + '</p>'; }
      return '<section aria-label="Order row ' + order.id + '">' + orderMarkup(order) + error + '<a href="/account/orders/' + order.id + '">View ' + order.id + '</a><button data-cancel="' + order.id + '"' + (eligible ? '' : ' disabled') + '>Cancel ' + order.id + '</button></section>';
    }).join('') : '<p>No orders</p>');
  } else if (path.startsWith('/account/orders/')) {
    const order = state.orders.find(entry => entry.id === path.slice('/account/orders/'.length));
    let eligible = false, error = '';
    if (order) { try { eligible = detailEligibility(order); } catch (cause) { error = '<p role="alert">' + escape(cause.message) + '</p>'; } }
    main.innerHTML = '<a href="/account/orders">Back to orders</a>' + (order ? orderMarkup(order) + error + '<button data-cancel="' + order.id + '"' + (eligible ? '' : ' disabled') + '>Cancel ' + order.id + '</button>' : '<h2>Order not found</h2>');
  } else main.innerHTML = '<h2>Page not found</h2>';
  for (const form of main.querySelectorAll('[data-add]')) form.addEventListener('submit', event => { event.preventDefault(); submit({ type: 'basket.add', id: form.dataset.add, quantity: new FormData(form).get('quantity') }, () => { basketChanged(); render(); }); });
  for (const button of main.querySelectorAll('[data-wish]')) button.addEventListener('click', () => button.dataset.saved === 'true' ? unsaveProduct(button.dataset.wish) : saveProduct(button.dataset.wish));
  for (const button of main.querySelectorAll('[data-cancel]')) button.addEventListener('click', () => confirmAction('Cancel ' + button.dataset.cancel + '?', { type: 'order.cancel', id: button.dataset.cancel }));
  if (confirmation) {
    const current = confirmation;
    main.insertAdjacentHTML('beforeend', '<section role="dialog" aria-label="Confirmation"><h2>' + escape(current.message) + '</h2><button id="confirm">Confirm</button><button id="cancel-confirm">Cancel</button></section>');
    main.querySelector('#confirm').addEventListener('click', () => submit(current.command, async result => { confirmation = null; if (current.after) await current.after(result); else render(); }));
    main.querySelector('#cancel-confirm').addEventListener('click', () => { confirmation = null; render(); });
  }
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search).catch(showReadError);
});

/** Restores history as a single URL, input and result update. */
async function restoreHistory() {
  await refresh();
  restoreCatalog();
  if (location.pathname === '/checkout' || location.pathname === '/checkout/review') { restoreDraft(previousPath.startsWith('/account')); if (location.pathname === '/checkout/review') restoreReviewQuote(); }
  previousPath = location.pathname;
  render();
}

/** Leaves the prior saved view available when an ordinary read fails. */
function showReadError(error) {
  feedback.innerHTML = '<p role="alert">' + escape(error.message) + '</p><button id="retry-read">Retry</button>';
  feedback.querySelector('#retry-read').addEventListener('click', () => navigate(location.pathname + location.search, true).catch(showReadError));
}

window.addEventListener('popstate', () => restoreHistory().catch(showReadError));
window.addEventListener('focus', async () => { if (!pending) { try { if (await refresh()) { if (location.pathname.startsWith('/checkout')) { restoreDraft(false); if (location.pathname === '/checkout/review') restoreReviewQuote(); } render(); } } catch (error) { showReadError(error); } } });
try { await refresh(); restoreCatalog(); if (location.pathname.startsWith('/checkout')) { restoreDraft(false); if (location.pathname === '/checkout/review') restoreReviewQuote(); } render(); }
catch (error) { showReadError(error); }
