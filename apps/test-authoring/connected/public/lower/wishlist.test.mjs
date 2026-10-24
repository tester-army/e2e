import test from 'node:test';
import assert from 'node:assert/strict';
import { money } from '../money.mjs';

test('prices render exact integer USD cents', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(2000), '$20.00');
  assert.equal(money(2499), '$24.99');
  assert.equal(money(2501), '$25.01');
});
