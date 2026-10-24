import type { HardFixture } from '../harder.ts';

const requirement = `# Cedar Market

Cedar Market has a small catalog and a local checkout. The basket starts empty. The catalog and basket are available from the Basket navigation link.

## Catalog and basket

| Product | Unit price | Eligible for FOREST20 |
| --- | --- | --- |
| Cedar tote | $25.00 | Yes |
| Sketchbook | $15.00 | Yes |
| Gift card | $20.00 | No |

Each product has a labeled Quantity select with the values 0, 1, 2, 3, and 4. The label includes the product name. Zero removes that product from the basket. Each product has one basket line. Changing a quantity updates the basket and quote immediately. Products retain the catalog order shown above.

The quote shows Merchandise, Promotion discount, Discounted merchandise, Delivery, and Total as separate amounts. Prices and calculations use integer cents. Every supported promotion calculation is exact to a cent.

## Promotions

The Promotion code input accepts at most 16 ASCII characters. FOREST20 is the only accepted code. Applying a code ignores leading and trailing ASCII spaces and compares ASCII letters without case sensitivity. The discount is 20% of eligible merchandise. Gift cards contribute to merchandise totals and never receive the discount.

The Apply promotion button is disabled while the basket is empty. Applying an empty code to a nonempty basket shows Enter a promotion code. Applying another code shows Promotion code is not valid. An invalid application removes any previously applied promotion and recalculates the quote. Editing the input alone does not change the applied promotion.

Applying FOREST20 shows FOREST20 applied. A Remove promotion button removes the applied promotion. Applying the same code again has the same result as applying it once. A quantity change recalculates an applied promotion. Removing the final item clears the promotion and its feedback.

## Delivery

The Delivery method select has Standard delivery and Pickup. Standard delivery is the initial selection. For a nonempty basket, Standard delivery costs $0.00 when Discounted merchandise is at least $50.00 and costs $5.00 otherwise. The threshold includes all merchandise after eligible discounts. Pickup costs $0.00 for every nonempty basket. Delivery method changes recalculate the quote immediately and do not alter merchandise or promotion amounts.

An empty basket always shows $0.00 for every quote amount, including Delivery and Total. The selected delivery method remains visible. An empty basket cannot place an order.

## Order confirmation

The Place order button is enabled for a nonempty basket. It creates a local order with the displayed products, quantities, promotion, delivery method, and quote. The confirmation displays those committed values and the status Order placed. No payment occurs.

Placing an order empties the basket, clears its promotion, and returns its delivery selection to Standard delivery. The Orders navigation link shows completed orders in creation order. Order numbers begin at 1 and increase once per placed order. Reload preserves orders and the current basket. Continue shopping returns to the basket. An order confirmation cannot submit the same order again.
`;

export const checkout = {
  id: 'checkout',
  name: 'cedar-market',
  kind: 'informative',
  requirement,
  files: {
    'PRODUCT.md': requirement,
    'index.html': `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cedar Market</title></head>
<body>
<h1>Cedar Market</h1>
<nav aria-label="Main"><a href="#basket" data-page="basket">Basket</a> <a href="#orders" data-page="orders">Orders</a></nav>
<main></main>
<script type="module" src="/app.js"></script>
</body>
</html>
`,
    'rules.mjs': `export const catalog = [
  { id: 'tote', name: 'Cedar tote', cents: 2500, eligible: true },
  { id: 'sketchbook', name: 'Sketchbook', cents: 1500, eligible: true },
  { id: 'gift-card', name: 'Gift card', cents: 2000, eligible: false },
];

export function promotionCode(value) {
  return value.replace(/^ +| +$/g, '').replace(/[a-z]/g, letter => letter.toUpperCase());
}

export function merchandise(quantities) {
  return catalog.reduce((cents, product, index) => cents + product.cents * quantities[index], 0);
}

export function promotionDiscount(quantities, promotion) {
  if (promotion !== 'FOREST20') return 0;
  return catalog.reduce((cents, product, index) => cents + (product.eligible ? product.cents * quantities[index] / 5 : 0), 0);
}

export function deliveryCharge(discountedMerchandise, deliveryMethod, hasItems) {
  return !hasItems || deliveryMethod === 'pickup' || discountedMerchandise >= 5000 ? 0 : 500;
}

export const money = cents => '$' + (cents / 100).toFixed(2);
`,
    'view.mjs': `import { merchandise, promotionDiscount, deliveryCharge } from './rules.mjs';

export function quoteForView(quantities, promotion, deliveryMethod) {
  const subtotal = merchandise(quantities);
  const discount = promotionDiscount(quantities, promotion);
  const discounted = subtotal - discount;
  const delivery = deliveryCharge(discounted, deliveryMethod, subtotal > 0);
  return { merchandise: subtotal, discount, discounted, delivery, total: discounted + delivery };
}
`,
    'app.js': `import { catalog, money, promotionCode } from './rules.mjs';
import { quoteForView } from './view.mjs';

const storageKey = 'cedar-market:v1';
const initial = { quantities: [0, 0, 0], promotion: null, delivery: 'standard', orders: [] };
if (localStorage.getItem(storageKey) === null) localStorage.setItem(storageKey, JSON.stringify(initial));
const state = JSON.parse(localStorage.getItem(storageKey));
const main = document.querySelector('main');
let page = 'basket';
let selectedOrder;
let code = '';
let feedback = '';
const persist = () => localStorage.setItem(storageKey, JSON.stringify(state));
const hasItems = () => state.quantities.some(quantity => quantity > 0);
const deliveryName = value => value === 'standard' ? 'Standard delivery' : 'Pickup';

function quoteMarkup(quote) {
  return '<dl>' + [
    ['Merchandise', quote.merchandise],
    ['Promotion discount', quote.discount],
    ['Discounted merchandise', quote.discounted],
    ['Delivery', quote.delivery],
    ['Total', quote.total],
  ].map(([label, cents]) => '<dt>' + label + '</dt><dd><output aria-label="' + label + '">' + money(cents) + '</output></dd>').join('') + '</dl>';
}

function orderMarkup(order) {
  return '<article aria-label="Order ' + order.number + '"><h2>Order ' + order.number + '</h2><ul>' + order.products.map(product => '<li>' + product.name + ' Quantity ' + product.quantity + ' Unit price ' + money(product.cents) + '</li>').join('') + '</ul><p>Promotion ' + (order.promotion || 'None') + '</p><p>Delivery method ' + deliveryName(order.delivery) + '</p>' + quoteMarkup(order.quote) + '</article>';
}

function render() {
  if (page === 'confirmation') {
    main.innerHTML = orderMarkup(selectedOrder) + '<p role="status" aria-label="Order status">Order placed</p><button type="button" data-continue>Continue shopping</button>';
    main.querySelector('[data-continue]').addEventListener('click', () => {
      page = 'basket';
      feedback = '';
      render();
    });
    return;
  }
  if (page === 'orders') {
    main.innerHTML = '<h2>Orders</h2>' + (state.orders.length ? state.orders.map(orderMarkup).join('') : '<p>No orders</p>');
    return;
  }
  const quote = quoteForView(state.quantities, state.promotion, state.delivery);
  main.innerHTML = '<h2>Basket</h2><section aria-label="Catalog">' + catalog.map((product, index) => '<p>' + product.name + ' Unit price ' + money(product.cents) + '</p><label>Quantity ' + product.name + '<select data-product="' + index + '">' + [0, 1, 2, 3, 4].map(quantity => '<option value="' + quantity + '"' + (state.quantities[index] === quantity ? ' selected' : '') + '>' + quantity + '</option>').join('') + '</select></label>').join('') + '</section><section aria-label="Basket lines"><h3>Basket lines</h3>' + (hasItems() ? '<ul>' + catalog.filter((product, index) => state.quantities[index] > 0).map(product => '<li>' + product.name + ' Quantity ' + state.quantities[catalog.indexOf(product)] + '</li>').join('') + '</ul>' : '<p>Your basket is empty</p>') + '</section><label>Promotion code <input name="promotion" maxlength="16"></label><button type="button" data-apply' + (hasItems() ? '' : ' disabled') + '>Apply promotion</button>' + (state.promotion ? '<p>Applied promotion FOREST20</p><button type="button" data-remove>Remove promotion</button>' : '') + '<p role="status" aria-label="Promotion status"></p><label>Delivery method <select name="delivery"><option value="standard"' + (state.delivery === 'standard' ? ' selected' : '') + '>Standard delivery</option><option value="pickup"' + (state.delivery === 'pickup' ? ' selected' : '') + '>Pickup</option></select></label><section aria-label="Quote"><h3>Quote</h3>' + quoteMarkup(quote) + '</section><button type="button" data-order' + (hasItems() ? '' : ' disabled') + '>Place order</button>';
  const input = main.querySelector('[name=promotion]');
  input.value = code;
  main.querySelector('[aria-label="Promotion status"]').textContent = feedback;
  input.addEventListener('input', () => {
    code = input.value.replace(/[^\\x00-\\x7F]/g, '').slice(0, 16);
    input.value = code;
    feedback = '';
    main.querySelector('[aria-label="Promotion status"]').textContent = '';
  });
  for (const select of main.querySelectorAll('[data-product]')) select.addEventListener('change', () => {
    state.quantities[Number(select.dataset.product)] = Number(select.value);
    feedback = '';
    if (!hasItems()) {
      state.promotion = null;
      code = '';
    }
    persist();
    render();
  });
  main.querySelector('[data-apply]').addEventListener('click', () => {
    if (!hasItems()) return;
    const normalized = promotionCode(code);
    state.promotion = normalized === 'FOREST20' ? normalized : null;
    feedback = state.promotion ? 'FOREST20 applied' : normalized ? 'Promotion code is not valid' : 'Enter a promotion code';
    persist();
    render();
  });
  main.querySelector('[data-remove]')?.addEventListener('click', () => {
    state.promotion = null;
    feedback = '';
    persist();
    render();
  });
  main.querySelector('[name=delivery]').addEventListener('change', event => {
    state.delivery = event.target.value;
    feedback = '';
    persist();
    render();
  });
  main.querySelector('[data-order]').addEventListener('click', () => {
    if (!hasItems()) return;
    selectedOrder = {
      number: state.orders.length + 1,
      products: catalog.flatMap((product, index) => state.quantities[index] ? [{ ...product, quantity: state.quantities[index] }] : []),
      promotion: state.promotion,
      delivery: state.delivery,
      quote: quoteForView(state.quantities, state.promotion, state.delivery),
    };
    state.orders.push(selectedOrder);
    state.quantities = [0, 0, 0];
    state.promotion = null;
    state.delivery = 'standard';
    code = '';
    feedback = '';
    persist();
    page = 'confirmation';
    render();
  });
}

for (const link of document.querySelectorAll('nav a')) link.addEventListener('click', event => {
  event.preventDefault();
  page = link.dataset.page;
  feedback = '';
  render();
});
render();
`,
    'lower/rules.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { merchandise, promotionDiscount, promotionCode, deliveryCharge, money } from '../rules.mjs';

test('merchandise promotions and delivery', () => {
  assert.equal(merchandise([0, 0, 0]), 0);
  assert.equal(merchandise([2, 0, 0]), 5000);
  assert.equal(promotionDiscount([2, 0, 0], 'FOREST20'), 1000);
  assert.equal(promotionDiscount([1, 1, 1], 'FOREST20'), 800);
  assert.equal(promotionDiscount([4, 4, 4], null), 0);
  assert.equal(merchandise([0, 0, 2]), 4000);
  assert.equal(promotionDiscount([0, 0, 2], 'FOREST20'), 0);
  assert.equal(promotionCode(' forest20 '), 'FOREST20');
  assert.equal(promotionCode('\\tFOREST20'), '\\tFOREST20');
  assert.equal(deliveryCharge(4000, 'standard', true), 500);
  assert.equal(deliveryCharge(5000, 'standard', true), 0);
  assert.equal(deliveryCharge(1200, 'pickup', true), 0);
  assert.equal(deliveryCharge(0, 'standard', false), 0);
  assert.equal(money(4500), '$45.00');
});
`,
  },
  lowerExit: 0,
  mutationFile: 'view.mjs',
  mutation: [`deliveryCharge(discounted, deliveryMethod, subtotal > 0)`, `deliveryCharge(subtotal, deliveryMethod, subtotal > 0)`],
  strong: `await screen.getByLabel('Quantity Cedar tote').selectOption({ value: '2' });
  await screen.getByLabel('Promotion code').fill('FOREST20');
  await screen.getByRole('button', 'Apply promotion').tap();
  await expect(screen.getByRole('status', 'Merchandise')).toHaveText('$50.00');
  await expect(screen.getByRole('status', 'Promotion discount')).toHaveText('$10.00');
  await expect(screen.getByRole('status', 'Discounted merchandise')).toHaveText('$40.00');
  await expect(screen.getByRole('status', 'Delivery')).toHaveText('$5.00');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$45.00');
  await screen.getByRole('button', 'Place order').tap();
  await expect(screen.getByRole('status', 'Order status')).toHaveText('Order placed');
  await expect(screen.getByRole('status', 'Merchandise')).toHaveText('$50.00');
  await expect(screen.getByRole('status', 'Promotion discount')).toHaveText('$10.00');
  await expect(screen.getByRole('status', 'Discounted merchandise')).toHaveText('$40.00');
  await expect(screen.getByRole('status', 'Delivery')).toHaveText('$5.00');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$45.00');`,
  weak: `await screen.getByLabel('Quantity Sketchbook').selectOption({ value: '1' });
  await screen.getByLabel('Promotion code').fill('FOREST20');
  await screen.getByRole('button', 'Apply promotion').tap();
  await expect(screen.getByRole('status', 'Discounted merchandise')).toHaveText('$12.00');
  await expect(screen.getByRole('status', 'Delivery')).toHaveText('$5.00');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$17.00');`,
  expected: '$5.00',
} satisfies HardFixture;
