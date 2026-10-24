import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { connectedFixtures } from './connected-fixtures.ts';
import type { ConnectedFixture, ConnectedVariant } from './connected-fixtures.ts';
import { bundle, command } from './files.ts';
import { shopFailureSuite, expenseFailureSuite } from './connected/private-suites.ts';

const moduleAt = (name: string): string => new URL('./connected/public/' + name, import.meta.url).href;
const shop = await import(moduleAt('shop-domain.mjs'));
const expenses = await import(moduleAt('expenses-domain.mjs'));
const catalog = await import(moduleAt('catalog.mjs'));
const { ProfileStore } = await import(moduleAt('store.mjs'));
const evidence = process.env.CONNECTED_FIXTURE_EVIDENCE;

/** Creates a private verification directory, retaining it when evidence output is requested. */
function scratch(): string {
  if (evidence) mkdirSync(evidence, { recursive: true });
  return mkdtempSync(join(evidence ?? tmpdir(), 'connected-fixture-'));
}

/** Materializes the exact public image and applies one declared replacement if requested. */
function materialize(root: string, fixture: ConnectedFixture, variant?: ConnectedVariant): void {
  for (const [path, source] of Object.entries(fixture.files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), variant?.mutationFile === path ? source.replace(...variant.mutation) : source);
  }
}

/** Preserves test evidence or removes an ordinary temporary verification copy. */
function release(root: string): void {
  if (!evidence) rmSync(root, { recursive: true, force: true });
}

test('the six complete public projects have fixed identities and a shared shop runtime', () => {
  assert.deepEqual(connectedFixtures.map(fixture => [fixture.id, fixture.classification, fixture.lowerCount, fixture.variants.map(variant => variant.id)]), [
    ['addresses', 'informative', 3, ['A1', 'A2']], ['promotions', 'informative', 3, ['P1', 'P2']],
    ['expenses', 'informative', 3, ['E1', 'E2']], ['catalog', 'informative', 3, ['C1', 'C2']],
    ['orders', 'safeguard', 2, ['O1', 'O2']], ['wishlist', 'safeguard', 1, ['W1', 'W2']],
  ]);
  const shops = connectedFixtures.filter(fixture => fixture.id !== 'expenses');
  const baseline = Object.fromEntries(Object.entries(shops[0]!.files).filter(([path]) => path !== 'TASK.md' && !path.startsWith('lower/')));
  for (const fixture of shops) {
    assert.equal(fixture.name, 'ada-shop');
    assert.deepEqual(Object.fromEntries(Object.entries(fixture.files).filter(([path]) => path !== 'TASK.md' && !path.startsWith('lower/'))), baseline);
  }
  for (const fixture of connectedFixtures) {
    assert.equal(JSON.parse(fixture.files['package.json']!).name, fixture.name);
    assert.deepEqual(fixture.lowerTests, ['lower/rules.test.mjs']);
    for (const variant of fixture.variants) {
      assert.equal(fixture.files[variant.mutationFile]!.split(variant.mutation[0]).length, 2);
      assert.equal(variant.weight, 1);
      assert.ok(fixture.controls.strong.includes(JSON.stringify(variant.expected)));
    }
    for (const bytes of Object.values(fixture.controls)) {
      assert.match(bytes, /^import \{ test \} from '@e2e-dev\/web';\nimport \{ expect \} from 'e2e';/);
      assert.doesNotMatch(bytes, /agent\.|fetch\(|evaluate\(|localStorage|indexedDB|\/api\//);
    }
    assert.doesNotMatch(Object.values(fixture.files).join('\n'), /connected-feasibility|mutationFile|ruleIds|strong control|weak control|baseline slot/);
  }
});

test('all eighteen exact images run their real lower tests with the declared nonzero counts', () => {
  const root = scratch();
  try {
    for (const fixture of connectedFixtures) {
      for (const variant of [undefined, ...fixture.variants]) {
        const project = join(root, fixture.id + '-' + (variant?.id ?? 'correct'));
        materialize(project, fixture, variant);
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...fixture.lowerTests], { cwd: project, env, encoding: 'utf8', timeout: 15000 });
        writeFileSync(join(project, 'lower-output.log'), result.stdout + result.stderr);
        assert.equal(result.status, 0, fixture.id + ' ' + variant?.id + '\n' + result.stdout + result.stderr);
        assert.equal(Number(result.stdout.match(/^# tests ([0-9]+)$/m)?.[1]), fixture.lowerCount);
        assert.match(result.stdout, /^# fail 0$/m);
        assert.match(result.stdout, /^# skipped 0$/m);
        for (const path of ['app.js', 'server.mjs']) {
          const checked = spawnSync(process.execPath, ['--check', path], { cwd: project, encoding: 'utf8', timeout: 10000 });
          assert.equal(checked.status, 0, checked.stderr);
        }
      }
    }
  } finally { release(root); }
});

test('address identity, normalization, deletion fallback and monotonic IDs follow the production reducer', () => {
  let state = shop.initialShop();
  state.draft = { manualAddressId: 'address-studio' };
  state = shop.changeShop(state, { type: 'address.delete', id: 'address-studio' }).state;
  assert.equal(state.draft.manualAddressId, null);
  assert.equal(shop.resolveShipping(state.addresses, state.defaultAddressId, state.draft.manualAddressId).id, 'address-home');
  const fields = { label: '\t Home \r', recipient: ' Ada Green ', street: ' 40 Å Street\n', city: 'Warsaw', postalCode: '00-004', country: 'Poland' };
  let update = shop.changeShop(state, { type: 'address.add', fields });
  assert.equal(update.result, 'address-0000000000000001');
  assert.equal(update.state.addresses[2].street, '40 Å Street');
  state = shop.changeShop(update.state, { type: 'address.delete', id: update.result }).state;
  update = shop.changeShop(state, { type: 'address.add', fields });
  assert.equal(update.result, 'address-0000000000000002');
  assert.equal(update.state.addresses[2].label, 'Home');
  assert.throws(() => shop.changeShop(state, { type: 'address.add', fields: { ...fields, street: '\t \n' } }), /street is required/);
  for (const address of state.addresses) state = shop.changeShop(state, { type: 'address.delete', id: address.id }).state;
  assert.equal(state.defaultAddressId, null);
  assert.equal(shop.resolveShipping(state.addresses, state.defaultAddressId, null), null);
  state.basket = [{ productId: 'cafe-mug', quantity: 1 }];
  state.draft = { manualAddressId: null };
  assert.throws(() => shop.changeShop(state, { type: 'order.place' }), /address is required/);
  assert.equal(shop.changeShop(state, { type: 'address.add', fields }).state.defaultAddressId, 'address-0000000000000002');
});

test('basket arithmetic, invalid quantities, line ordering and immutable order copies use production commands', () => {
  let state = shop.initialShop();
  for (const quantity of ['0', '10', '-1', '+1', '1.0', '1e0', ' 1', '١', '１', '']) assert.throws(() => shop.changeShop(state, { type: 'basket.add', id: 'trail-pack', quantity }), /Invalid quantity/);
  state = shop.changeShop(state, { type: 'basket.add', id: 'trail-pack', quantity: '8' }).state;
  assert.throws(() => shop.changeShop(state, { type: 'basket.add', id: 'trail-pack', quantity: '2' }), /Invalid quantity/);
  assert.equal(state.basket[0].quantity, 8);
  state = shop.changeShop(state, { type: 'basket.add', id: 'cafe-mug', quantity: '1' }).state;
  state = shop.changeShop(state, { type: 'basket.remove', id: 'trail-pack' }).state;
  state = shop.changeShop(state, { type: 'basket.add', id: 'trail-pack', quantity: '1' }).state;
  assert.deepEqual(state.basket.map((line: { productId: string }) => line.productId), ['cafe-mug', 'trail-pack']);
  state = shop.changeShop(state, { type: 'code.apply', code: '\tSaVe10\n' }).state;
  assert.throws(() => shop.changeShop(state, { type: 'code.apply', code: 'save11' }), /Invalid promotion/);
  assert.equal(state.code, 'SAVE10');
  state = shop.changeShop(state, { type: 'checkout.start' }).state;
  const placed = shop.changeShop(state, { type: 'order.place' });
  const order = placed.state.orders.find((entry: { id: string }) => entry.id === placed.result);
  assert.deepEqual(order.quote, { subtotal: 10000, eligible: 10000, discount: 1000, delivery: 500, payable: 9500 });
  assert.equal(order.createdAt, 1792324800000);
  assert.equal(order.destination.street, '10 Oak Street');
  assert.equal(order.policyVersion, 2);
  assert.equal(order.status, 'placed');
  assert.deepEqual(placed.state.basket, []);
  assert.equal(placed.state.draft, null);
  placed.state.addresses[0].street = 'Changed';
  assert.equal(order.destination.street, '10 Oak Street');
  const all = catalog.products.map((product: { id: string }) => ({ productId: product.id, quantity: 9 }));
  assert.deepEqual(shop.quoteBasket(all, null), { subtotal: 225000, eligible: 202500, discount: 0, delivery: 500, payable: 225500 });
  assert.equal(shop.quoteBasket([{ productId: 'enamel-cup', quantity: 1 }, { productId: 'steel-bottle', quantity: 1 }, { productId: 'titanium-mug', quantity: 1 }], 'SAVE10').discount, 1000);
  assert.equal(shop.quoteBasket([{ productId: 'gift-card-25', quantity: 9 }], 'SAVE10').discount, 0);
});

test('expense parsing, safe totals, stable ties and edit atomicity use the production helpers', () => {
  for (const amount of ['0', '0.00', '100000', '.01', '1.', '+1', '-1', '1e2', '1,00', '1 00', '１２', '١', '0.001', 'NaN']) assert.throws(() => expenses.parseAmount(amount), /Invalid amount/);
  assert.equal(expenses.parseAmount('\t00015.1\r'), 1510);
  let state = expenses.initialExpenses();
  assert.throws(() => expenses.changeExpenses(state, { type: 'expense.edit', id: 'expense-meal', description: '\t ', amount: '1.00', category: 'Travel' }), /Description is required/);
  assert.deepEqual(state.expenses.map((expense: { amountCents: number }) => expense.amountCents), [1200, 2000]);
  const maximum = { ...state, expenses: [{ ...state.expenses[0], amountCents: 9007199254740990 }] };
  assert.equal(expenses.expenseView([...maximum.expenses, { ...state.expenses[0], id: 'expense-final-cent', amountCents: 1 }]).total, 9007199254740991);
  assert.throws(() => expenses.changeExpenses(maximum, { type: 'expense.add', description: 'Overflow', amount: '0.02', category: 'Meals' }), /Invalid total/);
  assert.equal(maximum.expenses[0].amountCents, 9007199254740990);
  const added = [];
  for (let i = 0; i < 12; i++) {
    const update = expenses.changeExpenses(state, { type: 'expense.add', description: 'Equal description', amount: '0.01', category: 'Supplies' });
    state = update.state;
    added.push(update.result);
  }
  assert.deepEqual(expenses.expenseView(state.expenses, 'Supplies').records.map((expense: { id: string }) => expense.id), added);
  state = expenses.changeExpenses(state, { type: 'expense.delete', id: added[11] }).state;
  assert.equal(expenses.changeExpenses(state, { type: 'expense.add', description: 'New', amount: '1', category: 'Meals' }).result, 'expense-0000000000000013');
});

test('demo reset restores visible seeds while generated collection IDs remain monotonic', () => {
  const fields = { label: 'Home', recipient: 'Ada Green', street: '40 Birch Street', city: 'Warsaw', postalCode: '00-004', country: 'Poland' };
  let state = shop.changeShop(shop.initialShop(), { type: 'address.add', fields }).state;
  state = shop.changeShop(state, { type: 'address.delete', id: 'address-0000000000000001' }).state;
  state = shop.changeShop(state, { type: 'reset' }).state;
  assert.deepEqual(state.addresses.map((address: { id: string }) => address.id), ['address-home', 'address-office', 'address-studio']);
  assert.equal(shop.changeShop(state, { type: 'address.add', fields }).result, 'address-0000000000000002');
  let records = expenses.changeExpenses(expenses.initialExpenses(), { type: 'expense.add', description: 'New', amount: '1', category: 'Meals' }).state;
  records = expenses.changeExpenses(records, { type: 'expense.delete', id: 'expense-0000000000000001' }).state;
  records = expenses.changeExpenses(records, { type: 'reset' }).state;
  assert.equal(expenses.expenseView(records.expenses).total, 3200);
  assert.equal(expenses.changeExpenses(records, { type: 'expense.add', description: 'New', amount: '1', category: 'Meals' }).result, 'expense-0000000000000002');
});

test('catalog Unicode normalization, strict links and code-point ordering match the published contract', () => {
  const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  assert.equal(catalog.normalizeQuery(whitespace + 'Cafe\u0301' + whitespace), 'Café');
  assert.equal(catalog.normalizeQuery('\ufeffmug\ufeff'), '\ufeffmug\ufeff');
  assert.equal(catalog.parseQuery('?unknown=ok&q=%20Mug%2B%20&q=other'), 'Mug+');
  assert.equal(catalog.querySuffix(" +!'()*~ "), '?q=%2B%21%27%28%29%2A~');
  for (const raw of ['?q=%', '?q=%0', '?q=%GG', '?q=%c0%af', '?q=%ed%a0%80', '?q=%f4%90%80%80', '?q=ok&other=%FF', '?q=\ud800']) assert.throws(() => catalog.parseQuery(raw), /Invalid search link/);
  assert.deepEqual(catalog.searchProducts('cafe').map((product: { id: string }) => product.id), []);
  assert.deepEqual(catalog.searchProducts('CAFÉ').map((product: { id: string }) => product.id), ['cafe-mug']);
  assert.deepEqual(catalog.searchProducts('', [{ id: 'a', name: '\u{10000}' }, { id: 'b', name: '\ue000' }]).map((product: { id: string }) => product.id), ['b', 'a']);
});

test('versioned cancellation uses fixed integer time and preserves distinct equal-time orders', () => {
  const state = shop.initialShop();
  assert.deepEqual(shop.sortedOrders(state.orders).map((order: { id: string }) => order.id), ['order-v2-cancelled', 'order-v2-packed', 'order-v2-recent', 'order-v2-shipped', 'order-v1-edge', 'order-v1-expired', 'order-v2-old-detail', 'order-v2-old-list']);
  assert.equal(shop.changeShop(state, { type: 'order.cancel', id: 'order-v1-edge' }).state.orders.find((order: { id: string }) => order.id === 'order-v1-edge').status, 'cancelled');
  assert.throws(() => shop.changeShop(state, { type: 'order.cancel', id: 'order-v1-expired' }), /cannot be cancelled/);
  assert.equal(shop.changeShop(state, { type: 'order.cancel', id: 'order-v2-old-detail' }).state.orders.find((order: { id: string }) => order.id === 'order-v2-old-detail').status, 'cancelled');
  assert.throws(() => shop.changeShop(state, { type: 'order.cancel', id: 'order-v2-packed' }), /cannot be cancelled/);
  const unknownVersion = { ...state, orders: [{ ...state.orders[0], policyVersion: 3, status: 'placed' }] };
  assert.throws(() => shop.changeShop(unknownVersion, { type: 'order.cancel', id: unknownVersion.orders[0].id }), /Unsupported policy/);
  const unknownStatus = { ...state, orders: [{ ...state.orders[0], status: 'unknown' }] };
  assert.throws(() => shop.changeShop(unknownStatus, { type: 'order.cancel', id: unknownStatus.orders[0].id }), /Unsupported policy/);
  const cancelled = shop.changeShop(state, { type: 'order.cancel', id: 'order-v2-old-list' }).state;
  assert.equal(cancelled.orders.find((order: { id: string }) => order.id === 'order-v2-old-list').status, 'cancelled');
  assert.deepEqual(shop.changeShop(cancelled, { type: 'order.cancel', id: 'order-v2-old-list' }).state, cancelled);
});

test('the durable owner orders reads and writes, survives restart and deduplicates placement', async () => {
  const root = scratch();
  try {
    const store = new ProfileStore(root, shop.initialShop, shop.changeShop);
    const profile = randomUUID();
    await store.read(profile);
    let resolveSubmission!: (value: unknown) => void;
    const submitted = new Promise(resolve => { resolveSubmission = resolve; });
    const first = store.execute(profile, submitted);
    const second = store.execute(profile, { operationId: randomUUID(), command: { type: 'checkout.start' } });
    const read = store.read(profile);
    resolveSubmission({ operationId: randomUUID(), command: { type: 'basket.add', id: 'trail-pack', quantity: '1' } });
    await Promise.all([first, second]);
    assert.deepEqual((await read).basket, [{ productId: 'trail-pack', quantity: 1 }]);
    assert.deepEqual((await read).draft, { manualAddressId: null });
    const operation = randomUUID();
    const placed = await store.execute(profile, { operationId: operation, command: { type: 'order.place' } });
    assert.equal(placed.result, 'order-0000000000000001');
    const durable = JSON.parse(readFileSync(join(root, profile + '.json'), 'utf8'));
    assert.equal(durable.state.orders.length, 9);
    assert.equal(durable.operations[operation].result, 'order-0000000000000001');
    const restarted = new ProfileStore(root, shop.initialShop, shop.changeShop);
    const repeated = await restarted.execute(profile, { operationId: operation, command: { type: 'order.place' } });
    assert.equal(repeated.result, 'order-0000000000000001');
    assert.equal(repeated.state.orders.length, 9);
    await assert.rejects(restarted.execute(profile, { operationId: operation, command: { type: 'reset' } }), /different input/);
    assert.equal((await restarted.read(profile)).orders.length, 9);
    assert.equal((await restarted.read(randomUUID())).orders.length, 8);
  } finally { release(root); }
});

test('an interrupted ordinary persistence write retains prior bytes and permits the same operation retry', async () => {
  const root = scratch();
  try {
    const store = new ProfileStore(root, shop.initialShop, shop.changeShop);
    const profile = randomUUID();
    await store.read(profile);
    const before = readFileSync(join(root, profile + '.json'), 'utf8');
    const operation = randomUUID();
    chmodSync(root, 0o500);
    try { await assert.rejects(store.execute(profile, { operationId: operation, command: { type: 'wishlist.save', id: 'cafe-mug' } }), /EACCES|EPERM/); }
    finally { chmodSync(root, 0o700); }
    assert.equal(readFileSync(join(root, profile + '.json'), 'utf8'), before);
    assert.deepEqual((await store.read(profile)).wishlist, ['titanium-mug']);
    const saved = await store.execute(profile, { operationId: operation, command: { type: 'wishlist.save', id: 'cafe-mug' } });
    assert.deepEqual(saved.state.wishlist, ['titanium-mug', 'cafe-mug']);
    assert.deepEqual((await store.execute(profile, { operationId: operation, command: { type: 'wishlist.save', id: 'cafe-mug' } })).state.wishlist, ['titanium-mug', 'cafe-mug']);
    assert.equal(readdirSync(root).filter(path => path.endsWith('.tmp')).length, 0);
  } finally { chmodSync(root, 0o700); release(root); }
});

test('a synchronization failure after replacement rolls the ordinary store back before returning an error', async () => {
  const root = scratch();
  const originalOpen = fs.promises.open;
  try {
    const store = new ProfileStore(root, shop.initialShop, shop.changeShop);
    const profile = randomUUID();
    await store.read(profile);
    const before = readFileSync(join(root, profile + '.json'), 'utf8');
    let directorySyncs = 0;
    fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[0] === root && args[1] === 'r') {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (++directorySyncs === 2) throw Object.assign(new Error('Injected directory synchronization failure'), { code: 'EIO' });
          await sync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const operation = randomUUID();
    await assert.rejects(store.execute(profile, { operationId: operation, command: { type: 'wishlist.save', id: 'cafe-mug' } }), /Injected directory synchronization failure/);
    assert.equal(directorySyncs, 3);
    assert.equal(readFileSync(join(root, profile + '.json'), 'utf8'), before);
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    assert.deepEqual((await store.execute(profile, { operationId: operation, command: { type: 'wishlist.save', id: 'cafe-mug' } })).state.wishlist, ['titanium-mug', 'cafe-mug']);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    release(root);
  }
});

test('the real server serves only declared routes and assets while retaining a profile across reads', async () => {
  const directory = scratch();
  const root = join(directory, 'project with spaces');
  const fixture = connectedFixtures.find(entry => entry.id === 'catalog')!;
  materialize(root, fixture);
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const process = spawn(globalThis.process.execPath, ['server.mjs'], { cwd: root, env: { ...globalThis.process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', data => { output += data; });
  process.stderr.on('data', data => { output += data; });
  const base = 'http://127.0.0.1:' + port;
  try {
    let initial: Response | undefined;
    for (let count = 0; count < 100; count++) {
      try { initial = await fetch(base + '/api/state'); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.ok(initial, output);
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(cookie, /^demo_profile=[0-9a-f-]{36}$/);
    assert.equal((await initial.json() as { account: { id: string } }).account.id, 'account-ada');
    for (const path of ['/catalog?q=mug', '/products/titanium-mug?q=mug', '/products/unknown-%C3%85', '/checkout/review', '/account/orders/order-v2-recent', '/orders/order-v2-recent/receipt']) assert.equal((await fetch(base + path)).status, 200);
    for (const path of ['/lower/rules.test.mjs', '/PRODUCT.md', '/TASK.md', '/store.mjs', '/server.mjs', '/.data/', '/package.json', '/unknown', '/%2e%2e/AGENTS.md']) assert.equal((await fetch(base + path)).status, 404, path);
    const largeStreet = 'Å'.repeat(35000);
    const added = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ operationId: randomUUID(), command: { type: 'address.add', fields: { label: 'Home', recipient: 'Ada Green', street: largeStreet, city: 'Warsaw', postalCode: '00-004', country: 'Poland' } } }) });
    assert.equal(added.status, 200);
    assert.equal((await added.json() as { state: { addresses: { street: string }[] } }).state.addresses[3]!.street, largeStreet);
    const operationId = randomUUID();
    const response = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ operationId, command: { type: 'wishlist.save', id: 'cafe-mug' } }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { state: { wishlist: string[] } }).state.wishlist, ['titanium-mug', 'cafe-mug']);
    assert.deepEqual((await (await fetch(base + '/api/state', { headers: { Cookie: cookie } })).json() as { wishlist: string[] }).wishlist, ['titanium-mug', 'cafe-mug']);
    const denied = await fetch(base + '/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://outside.invalid' }, body: '{}' });
    assert.equal(denied.status, 403);
  } finally {
    process.kill('SIGTERM');
    await once(process, 'exit');
    writeFileSync(join(root, 'server-output.log'), output);
    release(directory);
  }
});

test('ordinary failed writes preserve saved browser views, editable fields and policy-disabled actions', () => {
  const root = scratch();
  try {
    bundle(join(root, 'runtime'));
    for (const [id, source, count] of [['addresses', shopFailureSuite, 7], ['expenses', expenseFailureSuite, 3]] as const) {
      const project = join(root, id);
      const fixture = connectedFixtures.find(entry => entry.id === id)!;
      materialize(project, fixture);
      cpSync(join(root, 'runtime'), join(project, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      mkdirSync(join(project, '.agents/skills'), { recursive: true });
      cpSync(join(project, 'node_modules/e2e/skills/e2e'), join(project, '.agents/skills/e2e'), { recursive: true, mode: constants.COPYFILE_FICLONE });
      mkdirSync(join(project, 'tests'), { recursive: true });
      writeFileSync(join(project, 'tests/requirement.e2e.ts'), source);
      const result = command(project, process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run'], 180000);
      writeFileSync(join(project, 'cli-output.log'), result.stdout + result.stderr);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(readFileSync(join(project, '.e2e/report.json'), 'utf8'));
      assert.deepEqual(report.run.summary, { discovered: count, selected: count, executed: count, passed: count, failed: 0, interrupted: 0, flaky: 0, skipped: 0 });
      assert.equal(report.run.exitCode, 0);
      assert.deepEqual(report.run.errors, []);
      assert.equal(report.run.usage.modelTokens, 0);
      for (const testResult of report.run.results) {
        assert.equal(testResult.attempts.length, 1);
        assert.equal(testResult.attempts[0].cleanup, 'complete');
        assert.deepEqual(testResult.attempts[0].secondaryErrors, []);
      }
    }
  } finally { release(root); }
});
