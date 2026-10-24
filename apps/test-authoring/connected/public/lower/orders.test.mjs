import test from 'node:test';
import assert from 'node:assert/strict';
import { canCancelV1, clock } from '../shop-domain.mjs';

test('version 1 includes the exact 24-hour boundary', () => {
  assert.equal(canCancelV1({ createdAt: clock - 86400000, status: 'processing' }), true);
  assert.equal(canCancelV1({ createdAt: clock - 86400001, status: 'processing' }), false);
});
test('version 1 accepts recent noncancelled statuses and rejects future time', () => {
  assert.equal(canCancelV1({ createdAt: clock, status: 'packed' }), true);
  assert.equal(canCancelV1({ createdAt: clock, status: 'cancelled' }), false);
  assert.equal(canCancelV1({ createdAt: clock + 1, status: 'placed' }), false);
});
