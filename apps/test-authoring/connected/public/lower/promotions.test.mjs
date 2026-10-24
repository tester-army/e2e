import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteBasket, promotionCode } from '../shop-domain.mjs';

test('eligible quantities receive one inclusive promotion discount', () => {
  assert.deepEqual(quoteBasket([{ productId: 'titanium-mug', quantity: 3 }], 'SAVE10'), { subtotal: 7500, eligible: 7500, discount: 1000, delivery: 500, payable: 7000 });
  assert.equal(quoteBasket([{ productId: 'enamel-cup', quantity: 3 }], 'SAVE10').discount, 0);
});
test('gift cards do not contribute promotion eligibility', () => {
  assert.deepEqual(quoteBasket([{ productId: 'camp-jacket', quantity: 1 }, { productId: 'gift-card-25', quantity: 1 }], 'SAVE10'), { subtotal: 7500, eligible: 5000, discount: 0, delivery: 500, payable: 8000 });
  assert.equal(quoteBasket([{ productId: 'gift-card-25', quantity: 3 }], 'SAVE10').payable, 8000);
});
test('empty baskets and normalized codes have exact values', () => {
  assert.deepEqual(quoteBasket([], 'SAVE10'), { subtotal: 0, eligible: 0, discount: 0, delivery: 0, payable: 0 });
  assert.equal(promotionCode('\t save10\r\n'), 'SAVE10');
  assert.throws(() => promotionCode('ＳＡＶＥ10'), /Invalid promotion/);
});
