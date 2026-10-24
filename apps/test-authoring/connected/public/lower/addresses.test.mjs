import test from 'node:test';
import assert from 'node:assert/strict';
import { initialShop, resolveShipping, changeShop } from '../shop-domain.mjs';

test('shipping follows the current account default without a manual ID', () => {
  const state = initialShop();
  assert.equal(resolveShipping(state.addresses, 'address-office', null).street, '20 Pine Street');
  assert.equal(resolveShipping(state.addresses, 'address-studio', null).street, '30 Elm Street');
});
test('a manual stable ID takes precedence over the default', () => {
  const state = initialShop();
  assert.equal(resolveShipping(state.addresses, 'address-studio', 'address-office').street, '20 Pine Street');
});
test('equal labels retain distinct IDs and deleting a default uses insertion order', () => {
  const state = initialShop();
  assert.equal(resolveShipping(state.addresses, 'address-home', 'address-studio').street, '30 Elm Street');
  const update = changeShop(state, { type: 'address.delete', id: 'address-home' }).state;
  assert.equal(update.defaultAddressId, 'address-office');
  assert.equal(update.addresses[1].id, 'address-studio');
});
