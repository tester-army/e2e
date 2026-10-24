/** Wraps literal UI journeys in the installed public runner API. */
function suite(journeys: [string, string][]): string {
  return `import { test } from '@e2e-dev/web';\nimport { expect } from 'e2e';\n\n` + journeys.map(([name, body]) => `test(${JSON.stringify(name)}, async ({ app, screen, browser }) => {\n${body}\n});\n`).join('\n');
}

const addBackpack = `  await app.open('/catalog');
  await screen.getByRole('button', 'Add Trail Backpack to basket').tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();`;
const checkout = `  await screen.getByRole('button', 'Checkout', { exact: true }).tap();`;
const place = `  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await screen.getByRole('button', /^Place order /).tap();
  await expect(screen.getByRole('status', 'Order status')).toHaveText('Order placed');`;
const freshPurchase = `${addBackpack}\n${checkout}\n${place}`;
const mugResults = `  await expect(screen.getByLabel('Search products')).toHaveValue('mug');
  await expect(screen.getByRole('region', 'Search results').getByRole('article')).toHaveCount(2);
  await expect(screen.getByRole('region', 'Search results').getByRole('article').getByRole('heading')).toHaveText(['Café Mug', 'Titanium Mug']);
  await expect(browser).toHaveURL('/catalog?q=mug');`;

export const controls = {
  addresses: {
    strong: suite([
      ['a checkout draft follows an account default change', `${addBackpack}
${checkout}
  await screen.getByRole('link', 'Manage shipping addresses').tap();
  await screen.getByRole('button', 'Set default address-office', { exact: true }).tap();
  await screen.getByRole('link', 'Return to checkout').tap();
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await screen.getByRole('button', 'Place order $85.00').tap();
  await expect(screen.getByRole('heading', 'Receipt', { exact: true })).toBeVisible();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await browser.reload();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');`],
      ['manual checkout selection survives a later default change', `${addBackpack}
${checkout}
  await screen.getByLabel('Shipping address').selectOption({ value: 'address-office' });
  await screen.getByRole('button', 'Use selected address').tap();
  await screen.getByRole('link', 'Manage shipping addresses').tap();
  await screen.getByRole('button', 'Set default address-studio', { exact: true }).tap();
  await screen.getByRole('link', 'Return to checkout').tap();
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await screen.getByRole('button', 'Place order $85.00').tap();
  await expect(screen.getByRole('heading', 'Receipt', { exact: true })).toBeVisible();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');
  await browser.reload();
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('20 Pine Street');`],
    ]),
    weak: suite([['fresh checkout uses the initial default', `${freshPurchase}
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('10 Oak Street');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$85.00');`]]),
    wrong: suite([['fresh checkout uses the wrong initial street', `${freshPurchase}
  await expect(screen.getByRole('region', 'Shipping destination')).toContainText('30 Elm Street');`]]),
    unrelated: suite([['a separate catalog price expectation fails', `  await app.open('/products/trail-pack');
  await expect(screen.getByRole('article', 'Product trail-pack')).toContainText('$81.00');`]]),
  },
  promotions: {
    strong: suite([
      ['removing qualifying merchandise refreshes basket review and receipt', `${addBackpack}
  await screen.getByRole('link', 'Catalog', { exact: true }).tap();
  await screen.getByRole('button', 'Add $25 Gift Card to basket').tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await screen.getByLabel('Promotion code').fill('SAVE10');
  await screen.getByRole('button', 'Apply code').tap();
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$100.00');
  await screen.getByRole('link', 'Edit basket').tap();
  await screen.getByRole('button', 'Remove Trail Backpack', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Line amount gift-card-25')).toHaveText('$25.00');
  await expect(screen.getByRole('status', 'Promotion discount')).toHaveText('$0.00');
  await expect(screen.getByRole('status', 'Delivery')).toHaveText('$5.00');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$30.00');
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$30.00');
  await screen.getByRole('button', 'Place order $30.00').tap();
  await expect(screen.getByRole('heading', 'Receipt', { exact: true })).toBeVisible();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$30.00');
  await expect(screen.getByRole('status', 'Promotion discount')).toHaveText('$0.00');`],
      ['restored review excludes gift-card merchandise eligibility', `  await app.open('/catalog');
  await screen.getByRole('button', 'Add Camp Jacket to basket').tap();
  await screen.getByRole('button', 'Add $25 Gift Card to basket').tap();
  await screen.getByRole('link', 'Basket', { exact: true }).tap();
  await screen.getByLabel('Promotion code').fill('SAVE10');
  await screen.getByRole('button', 'Apply code').tap();
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await screen.getByRole('link', 'Edit basket').tap();
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Promotion eligibility')).toHaveText('Not eligible');
  await expect(screen.getByRole('status', 'Promotion discount')).toHaveText('$0.00');
  await expect(screen.getByRole('status', 'Total')).toHaveText('$80.00');
  await screen.getByRole('button', 'Place order $80.00').tap();
  await expect(screen.getByRole('heading', 'Receipt', { exact: true })).toBeVisible();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$80.00');`],
    ]),
    weak: suite([['one qualifying backpack has the advertised promotion', `${addBackpack}
  await screen.getByLabel('Promotion code').fill('SAVE10');
  await screen.getByRole('button', 'Apply code').tap();
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$75.00');
  await screen.getByRole('button', 'Place order $75.00').tap();
  await expect(screen.getByRole('heading', 'Receipt', { exact: true })).toBeVisible();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$75.00');`]]),
    wrong: suite([['a qualifying backpack has the wrong total', `${addBackpack}
  await screen.getByLabel('Promotion code').fill('SAVE10');
  await screen.getByRole('button', 'Apply code').tap();
${checkout}
  await screen.getByRole('link', 'Review order', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Total')).toHaveText('$85.00');`]]),
    unrelated: suite([['a separate saved count expectation fails', `  await app.open('/account/wishlist');
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('4');`]]),
  },
  expenses: {
    strong: suite([['a category-changing edit refreshes both lists and overview', `  await app.open('/expenses');
  await screen.getByLabel('Category filter').selectOption({ value: 'Meals' });
  await screen.getByRole('button', 'Apply filter').tap();
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$12.00');
  await screen.getByRole('link', 'Edit expense-meal').tap();
  await screen.getByLabel('Description', { exact: true }).fill('Team lunch');
  await screen.getByLabel('Amount', { exact: true }).fill('15.00');
  await screen.getByLabel('Category', { exact: true }).selectOption({ value: 'Travel' });
  await screen.getByRole('button', 'Save expense').tap();
  await expect(screen.getByLabel('Category filter')).toHaveValue('Meals');
  await expect(screen.getByRole('region', 'Expense list')).toContainText('No expenses');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$0.00');
  await screen.getByLabel('Category filter').selectOption({ value: 'Travel' });
  await screen.getByRole('button', 'Apply filter').tap();
  await expect(screen.getByRole('region', 'Expense list').getByRole('article')).toHaveCount(2);
  await expect(screen.getByRole('region', 'Expense list').getByRole('article').getByRole('heading')).toHaveText(['Team lunch', 'Train']);
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$35.00');
  await screen.getByRole('link', 'Overview', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Overview total')).toHaveText('$35.00');
  await browser.goto('/expenses/expense-meal?category=Travel');
  await browser.reload();
  await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('15.00');
  await expect(screen.getByLabel('Category', { exact: true })).toHaveValue('Travel');
  await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Team lunch');`]]),
    weak: suite([['a description edit persists through reload', `  await app.open('/expenses/expense-meal');
  await screen.getByLabel('Description', { exact: true }).fill('Team lunch');
  await screen.getByRole('button', 'Save expense').tap();
  await screen.getByRole('link', 'Edit expense-meal').tap();
  await browser.reload();
  await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Team lunch');
  await expect(screen.getByLabel('Amount', { exact: true })).toHaveValue('12.00');
  await expect(screen.getByLabel('Category', { exact: true })).toHaveValue('Meals');`]]),
    wrong: suite([['the Meals filter has the wrong all-record total', `  await app.open('/expenses?category=Meals');
  await expect(screen.getByRole('status', 'Expense total')).toHaveText('$32.00');`]]),
    unrelated: suite([['a separate initial description expectation fails', `  await app.open('/expenses/expense-travel');
  await expect(screen.getByLabel('Description', { exact: true })).toHaveValue('Taxi');`]]),
  },
  catalog: {
    strong: suite([['search survives browser history and product return links', `  await app.open('/catalog');
  await screen.getByLabel('Search products').fill('mug');
  await screen.getByRole('button', 'Search', { exact: true }).tap();
${mugResults}
  await screen.getByRole('link', 'View Titanium Mug').tap();
  await expect(screen.getByRole('article', 'Product titanium-mug')).toContainText('$25.00');
  await browser.back();
${mugResults}
  await screen.getByRole('link', 'View Titanium Mug').tap();
  await screen.getByRole('link', 'Back to catalog').tap();
${mugResults}`]]),
    weak: suite([['a shared search opens with its exact products', `  await app.open('/catalog?q=mug');
${mugResults}`]]),
    wrong: suite([['a mug search contains the wrong backpack', `  await app.open('/catalog?q=mug');
  await expect(screen.getByRole('region', 'Search results').getByRole('article', 'Product trail-pack')).toBeVisible();`]]),
    unrelated: suite([['a separate initial address expectation fails', `  await app.open('/account/addresses');
  await expect(screen.getByRole('article', 'Address address-office')).toContainText('99 Wrong Street');`]]),
  },
  orders: {
    strong: suite([
      ['an old version 2 order can be cancelled through details', `  await app.open('/account/orders/order-v2-old-detail');
  await expect(screen.getByRole('button', 'Cancel order-v2-old-detail', { exact: true })).toBeEnabled();
  await screen.getByRole('button', 'Cancel order-v2-old-detail', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Status order-v2-old-detail')).toHaveText('cancelled');
  await screen.getByRole('link', 'Back to orders').tap();
  await expect(screen.getByRole('status', 'Status order-v2-old-detail')).toHaveText('cancelled');
  await screen.getByRole('link', 'View order-v2-old-detail', { exact: true }).tap();
  await browser.reload();
  await expect(screen.getByRole('status', 'Status order-v2-old-detail')).toHaveText('cancelled');`],
      ['an old version 2 order can be cancelled through the list', `  await app.open('/account/orders');
  await expect(screen.getByRole('button', 'Cancel order-v2-old-list', { exact: true })).toBeEnabled();
  await screen.getByRole('button', 'Cancel order-v2-old-list', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Status order-v2-old-list')).toHaveText('cancelled');
  await screen.getByRole('link', 'View order-v2-old-list', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Status order-v2-old-list')).toHaveText('cancelled');
  await browser.reload();
  await expect(screen.getByRole('status', 'Status order-v2-old-list')).toHaveText('cancelled');`],
    ]),
    weak: suite([['a recent order cancellation persists in both views', `  await app.open('/account/orders/order-v2-recent');
  await screen.getByRole('button', 'Cancel order-v2-recent', { exact: true }).tap();
  await screen.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('cancelled');
  await screen.getByRole('link', 'Back to orders').tap();
  await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('cancelled');
  await screen.getByRole('link', 'View order-v2-recent', { exact: true }).tap();
  await browser.reload();
  await expect(screen.getByRole('status', 'Status order-v2-recent')).toHaveText('cancelled');`]]),
    wrong: suite([['an old processing order is wrongly expected ineligible', `  await app.open('/account/orders/order-v2-old-detail');
  await expect(screen.getByRole('button', 'Cancel order-v2-old-detail', { exact: true })).toBeDisabled();`]]),
    unrelated: suite([['a separate catalog price expectation fails', `  await app.open('/products/steel-bottle');
  await expect(screen.getByRole('article', 'Product steel-bottle')).toContainText('$25.02');`]]),
  },
  wishlist: {
    strong: suite([['saved membership survives addition and removal reloads', `  await app.open('/products/cafe-mug');
  await screen.getByRole('button', 'Save Café Mug', { exact: true }).tap();
  await browser.reload();
  await screen.getByRole('link', /^Saved products /).tap();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('2');
  await expect(screen.getByRole('region', 'Saved products').getByRole('article')).toHaveCount(2);
  await expect(screen.getByRole('region', 'Saved products').getByRole('article').getByRole('heading')).toHaveText(['Titanium Mug', 'Café Mug']);
  await screen.getByRole('button', 'Unsave Titanium Mug', { exact: true }).tap();
  await browser.reload();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('1');
  await expect(screen.getByRole('region', 'Saved products').getByRole('article')).toHaveCount(1);
  await expect(screen.getByRole('region', 'Saved products').getByRole('article').getByRole('heading')).toHaveText(['Café Mug']);`]]),
    weak: suite([['saved-list maintenance works across connected routes', `  await app.open('/products/cafe-mug');
  await screen.getByRole('button', 'Save Café Mug', { exact: true }).tap();
  await screen.getByRole('link', /^Saved products /).tap();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('2');
  await expect(screen.getByRole('region', 'Saved products').getByRole('article').getByRole('heading')).toHaveText(['Titanium Mug', 'Café Mug']);
  await screen.getByRole('button', 'Unsave Café Mug', { exact: true }).tap();
  await expect(screen.getByRole('status', 'Saved count')).toHaveText('1');
  await expect(screen.getByRole('region', 'Saved products').getByRole('article').getByRole('heading')).toHaveText(['Titanium Mug']);`]]),
    wrong: suite([['the pristine saved list contains the wrong backpack', `  await app.open('/account/wishlist');
  await expect(screen.getByRole('region', 'Saved products').getByRole('article', 'Product trail-pack')).toBeVisible();`]]),
    unrelated: suite([['a separate shipping address expectation fails', `  await app.open('/account/addresses');
  await expect(screen.getByRole('article', 'Address address-home')).toContainText('11 Oak Street');`]]),
  },
};
