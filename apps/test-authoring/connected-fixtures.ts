import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { controls } from './connected/control-suites.ts';

export type ConnectedVariant = {
  id: string;
  mutationFile: string;
  mutation: [string, string];
  ruleIds: string[];
  weight: 1;
  expected: string;
};

export type ConnectedFixture = {
  id: string;
  name: string;
  classification: 'informative' | 'safeguard';
  files: Record<string, string>;
  lowerTests: string[];
  lowerCount: number;
  variants: [ConnectedVariant, ConnectedVariant];
  controls: { strong: string; weak: string; wrong: string; unrelated: string };
};

const ids = ['addresses', 'promotions', 'expenses', 'catalog', 'orders', 'wishlist'] as const;
const read = (path: string): string => readFileSync(new URL('./connected/' + path, import.meta.url), 'utf8');
const publicNames = ['index.html', 'style.css', 'money.mjs', 'catalog.mjs', 'shop-domain.mjs', 'expenses-domain.mjs', 'store.mjs', 'server.mjs', 'app.js'];
const shopRuntime = Object.fromEntries(publicNames.map(name => [name, read('public/' + name)]));
const request = 'Add deterministic browser UI regression coverage for the change below. Add the checks you would retain for this change. Current product rules and available data are in PRODUCT.md. Use the installed e2e skill and its public test APIs. Follow the browser test constraints in README.md. Drive the user interface and assert visible results. Do not use runtime agent steps. Run the tests locally and return tests/requirement.e2e.ts. Keep the supplied app and project configuration unchanged.';
const tickets = {
  addresses: 'The account address book now supports default shipping addresses in an existing checkout draft. Add regression coverage for the rollout, including default selection and explicit checkout choices.',
  promotions: 'Promotion codes now work across the basket and checkout review. Add regression coverage for the connected purchase flow and basket editing.',
  expenses: 'Customers can edit an expense on its detail page and return to the active list filter. Add regression coverage for the editor and the overview.',
  catalog: 'Catalog searches are shareable, and products now have detail pages with return navigation. Add regression coverage for search and product navigation.',
  orders: 'Customers can cancel orders from their account list and order details under the policy version stored on each order. Add regression coverage for self-service order management.',
  wishlist: 'Customers can save products and manage their saved list from the account area. Add regression coverage for the connected saved-list rollout.',
};
const config = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
export default {
  tests: 'tests/requirement.e2e.ts', workers: 1, retries: 0, cache: 'off',
  timeout: 60000, actionTimeout: 5000, assertionTimeout: 3000, launchTimeout: 20000,
  trace: 'on', reporters: ['json'],
  targets: [{ name: 'web', engine: web(), app: {
    url: 'http://127.0.0.1:0', command: { executable: 'node', args: ['server.mjs'], env: { PORT: '{port}' }, startupTimeout: 10000, log: '.e2e/app.log' },
  } }],
} satisfies E2EConfig;
`;
const variants: Record<typeof ids[number], [ConnectedVariant, ConnectedVariant]> = {
  addresses: [
    { id: 'A1', mutationFile: 'app.js', mutation: ['  if (returningFromAccount) draftDestination = null;', ''], ruleIds: ['ADDR3', 'ADDR5'], weight: 1, expected: 'a checkout draft follows an account default change' },
    { id: 'A2', mutationFile: 'app.js', mutation: ['  const restoredManualId = state.draft?.manualAddressId ?? null;', '  const restoredManualId = returningFromAccount ? null : state.draft?.manualAddressId ?? null;'], ruleIds: ['ADDR3', 'ADDR5'], weight: 1, expected: 'manual checkout selection survives a later default change' },
  ],
  promotions: [
    { id: 'P1', mutationFile: 'app.js', mutation: ["{ type: 'basket.remove', id: button.dataset.remove }, () => { basketChanged(); render(); }", "{ type: 'basket.remove', id: button.dataset.remove }, () => { render(); }"], ruleIds: ['PROMO3', 'PROMO4'], weight: 1, expected: 'removing qualifying merchandise refreshes basket review and receipt' },
    { id: 'P2', mutationFile: 'app.js', mutation: ['eligibleMerchandise: product.eligibleMerchandise', 'eligibleMerchandise: true'], ruleIds: ['PROMO3', 'PROMO4'], weight: 1, expected: 'restored review excludes gift-card merchandise eligibility' },
  ],
  expenses: [
    { id: 'E1', mutationFile: 'app.js', mutation: ['    invalidateExpenseLists();', ''], ruleIds: ['EXP1', 'EXP2'], weight: 1, expected: 'a category-changing edit refreshes both lists and overview' },
    { id: 'E2', mutationFile: 'app.js', mutation: ["  const submittedCategory = fields.get('category');", "  const submittedCategory = expense?.category ?? fields.get('category');"], ruleIds: ['EXP2'], weight: 1, expected: 'a category-changing edit refreshes both lists and overview' },
  ],
  catalog: [
    { id: 'C1', mutationFile: 'app.js', mutation: ['async function restoreHistory() {\n  await refresh();\n  restoreCatalog();', 'async function restoreHistory() {\n  await refresh();'], ruleIds: ['CAT1', 'CAT4'], weight: 1, expected: 'search survives browser history and product return links' },
    { id: 'C2', mutationFile: 'app.js', mutation: ['    const returnQuery = parseQuery(location.search);', "    const returnQuery = '';"], ruleIds: ['CAT4'], weight: 1, expected: 'search survives browser history and product return links' },
  ],
  orders: [
    { id: 'O1', mutationFile: 'app.js', mutation: ["function detailEligibility(order) {\n  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');\n  return order.policyVersion === 2 ? canCancelV2(order) : canCancelV1(order);", "function detailEligibility(order) {\n  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');\n  return order.policyVersion === 2 ? canCancelV1(order) : canCancelV1(order);"], ruleIds: ['ORDER1', 'ORDER2'], weight: 1, expected: 'an old version 2 order can be cancelled through details' },
    { id: 'O2', mutationFile: 'app.js', mutation: ["function listEligibility(order) {\n  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');\n  return order.policyVersion === 2 ? canCancelV2(order) : canCancelV1(order);", "function listEligibility(order) {\n  if (![1, 2].includes(order.policyVersion) || !['placed', 'processing', 'packed', 'shipped', 'cancelled'].includes(order.status)) throw new Error('Unsupported policy');\n  return order.policyVersion === 2 ? canCancelV1(order) : canCancelV1(order);"], ruleIds: ['ORDER1', 'ORDER2'], weight: 1, expected: 'an old version 2 order can be cancelled through the list' },
  ],
  wishlist: [
    { id: 'W1', mutationFile: 'app.js', mutation: ["  await submit({ type: 'wishlist.save', id });", "  state.wishlist = state.wishlist.includes(id) ? state.wishlist : [...state.wishlist, id]; render();"], ruleIds: ['G4', 'WISH1', 'WISH2'], weight: 1, expected: 'saved membership survives addition and removal reloads' },
    { id: 'W2', mutationFile: 'app.js', mutation: ["  await submit({ type: 'wishlist.unsave', id });", "  state.wishlist = state.wishlist.filter(savedId => savedId !== id); render();"], ruleIds: ['G4', 'WISH1', 'WISH2'], weight: 1, expected: 'saved membership survives addition and removal reloads' },
  ],
};

const variantSchema = z.object({ id: z.string().min(1), mutationFile: z.string().min(1), mutation: z.tuple([z.string().min(1), z.string()]), ruleIds: z.array(z.string()).min(1), weight: z.literal(1), expected: z.string().min(1) }).strict();
const fixtureSchema = z.object({ id: z.enum(ids), name: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/), classification: z.enum(['informative', 'safeguard']), files: z.record(z.string(), z.string()), lowerTests: z.array(z.string()).min(1), lowerCount: z.number().int().positive(), variants: z.tuple([variantSchema, variantSchema]), controls: z.object({ strong: z.string().min(1), weak: z.string().min(1), wrong: z.string().min(1), unrelated: z.string().min(1) }).strict() }).strict();

/** Builds a complete public project without copying private fixture metadata. */
function fixture(id: typeof ids[number]): ConnectedFixture {
  const expense = id === 'expenses';
  const lowerPath = 'lower/rules.test.mjs';
  const lower = read('public/lower/' + id + '.test.mjs');
  return {
    id, name: expense ? 'ada-expenses' : 'ada-shop', classification: id === 'orders' || id === 'wishlist' ? 'safeguard' : 'informative',
    files: {
      ...shopRuntime,
      ...(expense ? { 'app.js': read('public/expense-app.js'), 'server.mjs': shopRuntime['server.mjs']!.replace("const appKind = 'shop';", "const appKind = 'expenses';") } : {}),
      'PRODUCT.md': read(expense ? 'expense-product.md' : 'shop-product.md') + '\nRead the [request](TASK.md), [browser source](app.js), [lower tests](lower/rules.test.mjs), and [command help](README.md).\n',
      'TASK.md': '# Regression request\n\n' + request + '\n\n' + tickets[id] + '\n\nThere is no limit on tests, journeys, steps, or assertions.\n',
      'README.md': '# Local demo\n\nRead [PRODUCT.md](PRODUCT.md) and [TASK.md](TASK.md). The browser app is in [app.js](app.js). The server owns saved data in its local .data directory. Domain rules are in [shop-domain.mjs](shop-domain.mjs), [catalog.mjs](catalog.mjs), [expenses-domain.mjs](expenses-domain.mjs), and [money.mjs](money.mjs). The supplied lower tests are in [' + lowerPath + '](' + lowerPath + ').\n\nRun `npm start` to open the app on port 3000. Run `npm run test:unit` for the lower tests. Run `npm run test:e2e` for browser tests. The supplied browser configuration starts its own local app process. Its test timeout is 60 seconds, and its action and assertion timeouts are 5 and 3 seconds.\n\n' + read('browser-authoring.md'),
      'package.json': JSON.stringify({ name: expense ? 'ada-expenses' : 'ada-shop', private: true, type: 'module', scripts: { start: 'node server.mjs', 'test:unit': 'node --test lower/*.test.mjs', 'test:e2e': 'node node_modules/e2e/dist/cli/bin.js run' } }, null, 2) + '\n',
      'e2e.config.ts': config,
      '.gitignore': '.data/\n.e2e/\n',
      [lowerPath]: lower,
    },
    lowerTests: [lowerPath], lowerCount: [...lower.matchAll(/^test\(/gm)].length,
    variants: variants[id], controls: controls[id],
  };
}

/** Rejects malformed private registry entries before a study can freeze them. */
function validate(fixtures: ConnectedFixture[]): ConnectedFixture[] {
  const parsed = z.array(fixtureSchema).length(6).parse(fixtures);
  if (new Set(parsed.map(entry => entry.id)).size !== 6) throw new Error('Connected fixtures must have distinct identities');
  if (new Set(parsed.flatMap(entry => entry.variants.map(variant => variant.id))).size !== 12) throw new Error('Connected variants must have twelve distinct identities');
  for (const entry of parsed) {
    if (entry.classification !== (entry.id === 'orders' || entry.id === 'wishlist' ? 'safeguard' : 'informative')) throw new Error('Connected fixture classification changed');
    for (const path of Object.keys(entry.files)) {
      if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || /^(?:node_modules|\.agents|\.data|\.home|\.e2e|tests)(?:\/|$)/.test(path)) throw new Error('Unsafe public project path ' + path);
    }
    for (const path of ['PRODUCT.md', 'TASK.md', 'README.md', 'package.json', 'server.mjs', 'e2e.config.ts', 'index.html', 'app.js', ...entry.lowerTests]) if (!(path in entry.files)) throw new Error('Missing public file ' + path);
    for (const variant of entry.variants) {
      const source = entry.files[variant.mutationFile];
      if (!source || source.split(variant.mutation[0]).length !== 2 || variant.mutation[0] === variant.mutation[1]) throw new Error('Mutation must replace exactly one source location ' + variant.id);
    }
  }
  return parsed;
}

export const connectedFixtures: ConnectedFixture[] = validate(ids.map(fixture));
