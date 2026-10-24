export const shopFailureSuite = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chmod } from 'node:fs/promises';

test('failed cancellation preserves policy-disabled actions and retries the same save', async ({ app, screen, browser }) => {
  await app.open('/account/orders');
  await expect(screen.getByRole('button', 'Cancel order-v2-packed', { exact: true })).toBeDisabled();
  await chmod('.data/shop', 0o500);
  try {
    await screen.getByRole('button', 'Cancel order-v2-recent', { exact: true }).tap();
    await screen.getByRole('button', 'Confirm', { exact: true }).tap();
    await expect(screen.getByRole('alert')).toContainText('Could not save data');
    await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('placed');
    await expect(screen.getByRole('button', 'Cancel order-v2-packed', { exact: true })).toBeDisabled();
    await expect(screen.getByRole('button', 'Cancel order-v2-shipped', { exact: true })).toBeDisabled();
  } finally { await chmod('.data/shop', 0o700); }
  await screen.getByRole('button', 'Retry', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('cancelled');
  await screen.getByRole('link', 'View order-v2-recent', { exact: true }).tap();
  await browser.reload();
  await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('cancelled');
});

test('a failed saved-product write preserves membership until a successful retry', async ({ app, screen, browser }) => {
  await app.open('/products/cafe-mug');
  await expect(screen.getByRole('button', 'Save Café Mug', { exact: true })).toBeVisible();
  await chmod('.data/shop', 0o500);
  try {
    await screen.getByRole('button', 'Save Café Mug', { exact: true }).tap();
    await expect(screen.getByRole('alert')).toContainText('Could not save data');
    await expect(screen.getByRole('status', 'Saved count')).toHaveText('1');
    await expect(screen.getByRole('button', 'Save Café Mug', { exact: true })).toBeEnabled();
  } finally { await chmod('.data/shop', 0o700); }
  await screen.getByRole('button', 'Retry', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('2');
  await browser.reload();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('2');
  await screen.getByRole('link', /^Saved products /).tap();
  await expect(screen.getByRole('region', 'Saved products').getByRole('article').getByRole('heading')).toHaveText(['Titanium Mug', 'Café Mug']);
});

test('a failed address creation retains fields and creates one record after retry', async ({ app, screen, browser }) => {
  await app.open('/account/addresses');
  await screen.getByLabel('Label', { exact: true }).fill('Home');
  await screen.getByLabel('Recipient', { exact: true }).fill('Ada Green');
  await screen.getByLabel('Street', { exact: true }).fill('40 Birch Street');
  await screen.getByLabel('City', { exact: true }).fill('Warsaw');
  await screen.getByLabel('Postal code', { exact: true }).fill('00-004');
  await screen.getByLabel('Country', { exact: true }).fill('Poland');
  await chmod('.data/shop', 0o500);
  try {
    await screen.getByRole('button', 'Add address', { exact: true }).tap();
    await expect(screen.getByRole('alert')).toContainText('Could not save data');
    await expect(screen.getByRole('article')).toHaveCount(3);
    await expect(screen.getByLabel('Street', { exact: true })).toHaveValue('40 Birch Street');
  } finally { await chmod('.data/shop', 0o700); }
  await screen.getByRole('button', 'Retry', { exact: true }).tap();
  await expect(screen.getByRole('article')).toHaveCount(4);
  await expect(screen.getByRole('article', 'Address address-0000000000000001')).toContainText('40 Birch Street');
  await browser.reload();
  await expect(screen.getByRole('article')).toHaveCount(4);
});

test('browser Back resolves changed defaults and deletion of a manual address', async ({ app, screen, browser }) => {
  await app.open('/catalog');
  await screen.getByRole('button', 'Add Café Mug to basket').tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await screen.getByRole('button', 'Checkout', { exact: true }).tap();
  await screen.getByRole('link', 'Manage shipping addresses').tap();
  await screen.getByRole('button', 'Set default address-office', { exact: true }).tap();
  await browser.back();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await screen.getByLabel('Shipping address').selectOption({ value: 'address-studio' });
  await screen.getByRole('button', 'Use selected address').tap();
  await screen.getByRole('link', 'Manage shipping addresses').tap();
  await screen.getByRole('button', 'Delete address-studio', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await browser.back();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await screen.getByRole('link', 'Manage shipping addresses').tap();
  await screen.getByRole('button', 'Delete address-office', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await screen.getByRole('button', 'Delete address-home', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await screen.getByRole('link', 'Return to checkout').tap();
  await expect(screen.getByRole('alert')).toHaveText('A shipping address is required');
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('button', 'Place order $25.00')).toBeDisabled();
});

test('quantity edits recompute the inclusive promotion and reject an invalid replacement', async ({ app, screen, browser }) => {
  await app.open('/catalog');
  await screen.getByLabel('Quantity Titanium Mug').fill('3');
  await screen.getByRole('button', 'Add Titanium Mug to basket').tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await screen.getByLabel('Promotion code').fill('save10');
  await screen.getByRole('button', 'Apply code').tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$70.00');
  await screen.getByLabel('Quantity Titanium Mug').fill('2');
  await screen.getByRole('button', 'Update Titanium Mug quantity').tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$55.00');
  await expect(screen.getByRole('status', 'Promotion eligibility')).toHaveText('Not eligible');
  await screen.getByLabel('Quantity Titanium Mug').fill('0');
  await screen.getByRole('button', 'Update Titanium Mug quantity').tap();
  await expect(screen.getByRole('alert')).toContainText('Invalid quantity');
  await expect(screen.getByRole('status', 'Line amount titanium-mug')).toHaveText('$50.00');
  await browser.reload();
  await expect(screen.getByLabel('Quantity Titanium Mug')).toHaveValue('2');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$55.00');
});

test('Unicode and invalid search links produce canonical visible results', async ({ app, screen, browser }) => {
  await app.open('/catalog?unknown=discard&q=%C2%A0CAFE%CC%81%20&q=mug');
  await expect(screen.getByLabel('Search products')).toHaveValue('CAFÉ');
  await expect(browser).toHaveURL('/catalog?q=CAF%C3%89');
  await expect(screen.getByRole('region', 'Search results').getByRole('article').getByRole('heading')).toHaveText(['Café Mug']);
  await browser.goto('/catalog?q=%2B');
  await expect(screen.getByLabel('Search products')).toHaveValue('+');
  await expect(screen.getByRole('region', 'Search results')).toContainText('No products');
  await browser.goto('/catalog?q=%C3%28');
  await expect(screen.getByRole('alert')).toHaveText('Invalid search link');
  await screen.getByRole('button', 'Clear search', { exact: true }).tap();
  await expect(browser).toHaveURL('/catalog');
  await expect(screen.getByRole('region', 'Search results').getByRole('article')).toHaveCount(7);
  await browser.goto('/products/unknown-%C3%85?q=mug');
  await expect(screen.getByRole('heading', 'Product not found', { exact: true })).toBeVisible();
  await screen.getByRole('link', 'Back to catalog').tap();
  await expect(screen.getByLabel('Search products')).toHaveValue('mug');
  await expect(screen.getByRole('region', 'Search results').getByRole('article')).toHaveCount(2);
});

test('reset confirmation cancels without change and confirmed reset restores the initial app', async ({ app, screen, browser }) => {
  await app.open('/catalog?q=mug');
  await screen.getByRole('button', 'Add Café Mug to basket').tap();
  await screen.getByRole('link', 'Account', { exact: true }).tap();
  await screen.getByRole('button', 'Reset demo data').tap();
  await screen.getByRole('button', 'Cancel', { exact: true }).tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$25.00');
  await screen.getByRole('link', 'Account', { exact: true }).tap();
  await screen.getByRole('button', 'Reset demo data').tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(browser).toHaveURL('/');
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await expect(screen.getByRole('region', 'Basket lines')).toContainText('Your basket is empty');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$0.00');
  await expect(screen.getByRole('button', 'Checkout', { exact: true })).toBeDisabled();
  await screen.getByRole('link', 'Catalog', { exact: true }).tap();
  await expect(screen.getByLabel('Search products')).toHaveValue('');
});
`;

export const expenseFailureSuite = `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chmod } from 'node:fs/promises';

test('a failed expense write retains editable fields and commits all fields on retry', async ({ app, screen, browser }) => {
  await app.open('/expenses?category=Meals');
  await screen.getByRole('link', 'Edit expense-meal').tap();
  await screen.getByLabel('Description', { exact: true }).fill('Updated lunch');
  await screen.getByLabel('Amount', { exact: true }).fill('15.00');
  await screen.getByLabel('Category', { exact: true }).selectOption({ value: 'Travel' });
  await chmod('.data/expenses', 0o500);
  try {
    await screen.getByRole('button', 'Save expense', { exact: true }).tap();
    await expect(screen.getByRole('alert')).toContainText('Could not save data');
    await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Updated lunch');
    await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('15.00');
    await expect(screen.getByLabel('Category', { exact: true })).toHaveValue('Travel');
  } finally { await chmod('.data/expenses', 0o700); }
  await screen.getByRole('button', 'Retry', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$0.00');
  await browser.goto('/expenses?category=Travel');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$35.00');
  await screen.getByRole('link', 'Edit expense-meal').tap();
  await browser.reload();
  await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Updated lunch');
  await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('15.00');
  await expect(screen.getByLabel('Category', { exact: true })).toHaveValue('Travel');
});

test('invalid amount grammar preserves the saved expense and cancel discards input', async ({ app, screen, browser }) => {
  await app.open('/expenses/expense-meal?category=Meals');
  await screen.getByLabel('Description', { exact: true }).fill('Unsaved description');
  await screen.getByLabel('Amount', { exact: true }).fill('12.345');
  await screen.getByLabel('Category', { exact: true }).selectOption({ value: 'Travel' });
  await screen.getByRole('button', 'Save expense', { exact: true }).tap();
  await expect(screen.getByRole('alert')).toHaveText('Invalid amount');
  await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('12.345');
  await screen.getByRole('link', 'Cancel', { exact: true }).tap();
  await expect(screen.getByLabel('Category filter')).toHaveValue('Meals');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$12.00');
  await screen.getByRole('link', 'Edit expense-meal').tap();
  await browser.reload();
  await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Lunch');
  await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('12.00');
  await expect(screen.getByLabel('Category', { exact: true })).toHaveValue('Meals');
});

test('create and confirmed delete retain the list filter and exact overview', async ({ app, screen }) => {
  await app.open('/expenses?category=Meals');
  await screen.getByRole('link', 'Add expense').tap();
  await screen.getByLabel('Description', { exact: true }).fill('Pencil');
  await screen.getByLabel('Amount', { exact: true }).fill('0.01');
  await screen.getByLabel('Category', { exact: true }).selectOption({ value: 'Supplies' });
  await screen.getByRole('button', 'Save expense', { exact: true }).tap();
  await expect(screen.getByLabel('Category filter')).toHaveValue('Meals');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$12.00');
  await screen.getByLabel('Category filter').selectOption({ value: 'Supplies' });
  await screen.getByRole('button', 'Apply filter').tap();
  await expect(screen.getByRole('article', 'Expense expense-0000000000000001')).toContainText('Pencil');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$0.01');
  await screen.getByRole('button', 'Delete expense-0000000000000001', { exact: true }).tap();
  await screen.getByRole('button', 'Cancel', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$0.01');
  await screen.getByRole('button', 'Delete expense-0000000000000001', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(screen.getByRole('region', 'Expense list')).toContainText('No expenses');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$0.00');
  await screen.getByRole('link', 'Overview', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Overview total')).toHaveText('$32.00');
});
`;
