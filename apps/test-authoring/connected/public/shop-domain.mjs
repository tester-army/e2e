import { products, compareCodePoints } from './catalog.mjs';
import { trimAscii } from './money.mjs';

export const clock = 1792324800000;
const statuses = new Set(['placed', 'processing', 'packed', 'shipped', 'cancelled']);
const addressFields = ['label', 'recipient', 'street', 'city', 'postalCode', 'country'];

/** Creates one independent account aggregate with fixed seeds and counters. */
export function initialShop() {
  const addresses = [
    { id: 'address-home', label: 'Home', recipient: 'Ada Green', street: '10 Oak Street', city: 'Warsaw', postalCode: '00-001', country: 'Poland' },
    { id: 'address-office', label: 'Work', recipient: 'Ada Green', street: '20 Pine Street', city: 'Warsaw', postalCode: '00-002', country: 'Poland' },
    { id: 'address-studio', label: 'Home', recipient: 'Ada Green', street: '30 Elm Street', city: 'Warsaw', postalCode: '00-003', country: 'Poland' },
  ];
  const seeds = [
    ['order-v2-recent', 2, '2026-10-18T08:00:00.000Z', 'placed'],
    ['order-v2-packed', 2, '2026-10-18T08:00:00.000Z', 'packed'],
    ['order-v2-shipped', 2, '2026-10-18T08:00:00.000Z', 'shipped'],
    ['order-v2-cancelled', 2, '2026-10-18T08:00:00.000Z', 'cancelled'],
    ['order-v1-edge', 1, '2026-10-17T12:00:00.000Z', 'processing'],
    ['order-v1-expired', 1, '2026-10-17T11:59:59.999Z', 'processing'],
    ['order-v2-old-detail', 2, '2026-10-17T00:00:00.000Z', 'processing'],
    ['order-v2-old-list', 2, '2026-10-17T00:00:00.000Z', 'processing'],
  ];
  return {
    account: { id: 'account-ada', name: 'Ada Green' }, addresses, defaultAddressId: 'address-home',
    basket: [], code: null, draft: null, wishlist: ['titanium-mug'],
    orders: seeds.map(([id, policyVersion, createdAt, status]) => ({ id, policyVersion, createdAt: Date.parse(createdAt), status, destination: { ...addresses[0] }, lines: [], quote: { subtotal: 0, eligible: 0, discount: 0, delivery: 0, payable: 0 }, code: null })),
    counters: { address: 0, order: 0 },
  };
}

/** Resolves stable manual IDs before the current account default. */
export function resolveShipping(addresses, defaultAddressId, manualAddressId) {
  return addresses.find(address => address.id === manualAddressId) ?? addresses.find(address => address.id === defaultAddressId) ?? null;
}

/** Validates ASCII integer quantity input without coercion or partial parsing. */
function parseQuantity(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new Error('Invalid quantity. Use an integer from 1 through 9.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 9) throw new Error('Invalid quantity. Use an integer from 1 through 9.');
  return number;
}

/** Accepts the one promotion using ASCII-only case conversion. */
export function promotionCode(value) {
  const code = trimAscii(value).replace(/[a-z]/g, char => char.toUpperCase());
  if (code !== 'SAVE10') throw new Error('Invalid promotion code');
  return code;
}

/** Quotes ordered basket lines against catalog prices and eligibility. */
export function quoteBasket(lines, code, catalog = products) {
  let subtotal = 0;
  let eligible = 0;
  for (const line of lines) {
    const product = catalog.find(entry => entry.id === line.productId);
    if (!product) throw new Error('Product not found');
    const quantity = parseQuantity(String(line.quantity));
    const amount = product.priceCents * quantity;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid amount');
    subtotal += amount;
    if (product.eligibleMerchandise) eligible += amount;
  }
  const discount = code === 'SAVE10' && eligible >= 7500 ? 1000 : 0;
  const delivery = lines.length ? 500 : 0;
  const payable = subtotal + delivery - discount;
  if (![subtotal, eligible, payable].every(Number.isSafeInteger)) throw new Error('Invalid total');
  return { subtotal, eligible, discount, delivery, payable };
}

/** Implements the original version 1 age policy at the fixed product clock. */
export function canCancelV1(order, now = clock) {
  const age = now - order.createdAt;
  return statuses.has(order.status) && order.status !== 'cancelled' && Number.isSafeInteger(age) && age >= 0 && age <= 86400000;
}

/** Implements the stored version 2 status policy without an age restriction. */
export function canCancelV2(order) {
  return order.status === 'placed' || order.status === 'processing';
}

/** Selects the stored policy and rejects unknown versions or statuses. */
function canCancelOrder(order) {
  if (!statuses.has(order.status) || ![1, 2].includes(order.policyVersion)) throw new Error('Unsupported policy');
  return order.policyVersion === 1 ? canCancelV1(order) : canCancelV2(order);
}

/** Orders account history without conflating equal timestamps. */
export function sortedOrders(orders) {
  return orders.toSorted((a, b) => b.createdAt - a.createdAt || compareCodePoints(a.id, b.id));
}

/** Produces a complete next aggregate or throws before the caller can commit it. */
export function changeShop(current, command) {
  const state = structuredClone(current);
  let result = null;
  const address = id => {
    const found = state.addresses.find(entry => entry.id === id);
    if (!found) throw new Error('Address not found');
    return found;
  };
  const product = id => {
    const found = products.find(entry => entry.id === id);
    if (!found) throw new Error('Product not found');
    return found;
  };
  switch (command.type) {
    case 'reset': return { state: { ...initialShop(), counters: { ...current.counters } }, result: null };
    case 'address.add': {
      const fields = Object.fromEntries(addressFields.map(key => [key, trimAscii(command.fields?.[key])]));
      for (const key of addressFields) if (!fields[key]) throw new Error('Address ' + key + ' is required');
      if (!Number.isSafeInteger(state.counters.address + 1)) throw new Error('Address ID limit reached');
      const id = 'address-' + String(++state.counters.address).padStart(16, '0');
      state.addresses.push({ id, ...fields });
      if (!state.defaultAddressId) state.defaultAddressId = id;
      result = id;
      break;
    }
    case 'address.default': state.defaultAddressId = address(command.id).id; break;
    case 'address.delete': {
      address(command.id);
      state.addresses = state.addresses.filter(entry => entry.id !== command.id);
      if (state.defaultAddressId === command.id) state.defaultAddressId = state.addresses[0]?.id ?? null;
      if (state.draft?.manualAddressId === command.id) state.draft.manualAddressId = null;
      break;
    }
    case 'basket.add': {
      product(command.id);
      const quantity = parseQuantity(command.quantity);
      const line = state.basket.find(entry => entry.productId === command.id);
      if (line) line.quantity = parseQuantity(String(line.quantity + quantity));
      else state.basket.push({ productId: command.id, quantity });
      break;
    }
    case 'basket.quantity': {
      const line = state.basket.find(entry => entry.productId === command.id);
      if (!line) throw new Error('Basket line not found');
      line.quantity = parseQuantity(command.quantity);
      break;
    }
    case 'basket.remove': state.basket = state.basket.filter(line => line.productId !== command.id); break;
    case 'code.apply': state.code = promotionCode(command.code); break;
    case 'code.remove': state.code = null; break;
    case 'checkout.start':
      if (!state.basket.length) throw new Error('Your basket is empty');
      state.draft ??= { manualAddressId: null };
      break;
    case 'checkout.choose':
      if (!state.draft) throw new Error('Start checkout first');
      state.draft.manualAddressId = command.id === null ? null : address(command.id).id;
      break;
    case 'order.place': {
      if (!state.basket.length || !state.draft) throw new Error('Your basket is empty');
      const destination = resolveShipping(state.addresses, state.defaultAddressId, state.draft.manualAddressId);
      if (!destination) throw new Error('A shipping address is required');
      const quote = quoteBasket(state.basket, state.code);
      if (!Number.isSafeInteger(state.counters.order + 1)) throw new Error('Order ID limit reached');
      const id = 'order-' + String(++state.counters.order).padStart(16, '0');
      state.orders.push({ id, policyVersion: 2, createdAt: clock, status: 'placed', destination: { ...destination },
        lines: state.basket.map(line => ({ ...product(line.productId), quantity: line.quantity })), quote, code: state.code });
      state.basket = [];
      state.code = null;
      state.draft = null;
      result = id;
      break;
    }
    case 'order.cancel': {
      const order = state.orders.find(entry => entry.id === command.id);
      if (!order) throw new Error('Order not found');
      if (!canCancelOrder(order) && order.status !== 'cancelled') throw new Error('This order cannot be cancelled');
      order.status = 'cancelled';
      break;
    }
    case 'wishlist.save':
      product(command.id);
      if (!state.wishlist.includes(command.id)) state.wishlist.push(command.id);
      break;
    case 'wishlist.unsave': state.wishlist = state.wishlist.filter(id => id !== command.id); break;
    default: throw new Error('Unknown operation');
  }
  return { state, result };
}
