export const task = `Read REQUIREMENT.md and write deterministic browser E2E coverage for its current user-visible behavior.
Use the installed e2e skill and public e2e APIs. Run your test locally.
Return exactly tests/requirement.e2e.ts. Keep every provided project file unchanged.
The test must be self-contained and import only test from @e2e-dev/web and expect from e2e.
Exercise the real UI. Do not import app code, inspect the filesystem, use network APIs, runtime AI, mocks, browser scripts, skips, or environment-dependent branches.
The fixed config starts the app. Use app.open('/') and semantic screen locators.
Use a fresh authoring session with only this project and the declared tools and budget.
`;

export const treatment = `\n## Inspect relevant lower-level tests\n\nBefore authoring E2E coverage, inspect the relevant existing unit or integration tests. Identify the behavior they already cover and the user-visible wiring or UI gaps they leave. Treat the current requirement as authoritative when an existing test contradicts it. If no relevant lower-level tests exist, continue from the requirement and the UI.\n`;

export const fixtures = [
  {
    id: 'cart', name: 'cedar-market', lowerExit: 0,
    requirement: 'Changing Quantity from 1 to 3 must immediately update the displayed order total from $12 to $36. The visible quantity and total must agree.',
    rules: 'export const total = quantity => quantity * 12;\n',
    lower: "import { total } from '../rules.mjs';\ntest('line totals', () => { assert.equal(total(1), 12); assert.equal(total(3), 36); });\n",
    html: '<label>Quantity <input type="number" value="1" min="1"></label><p role="status" aria-label="Order total">$12</p>',
    script: "import { total } from './rules.mjs';\nconst quantity = document.querySelector('input');\nquantity.addEventListener('input', () => { document.querySelector('[role=status]').textContent = '$' + total(Number(quantity.value)); });\n",
    mutation: ['total(Number(quantity.value))', 'total(1)'],
    strong: "await screen.getByLabel('Quantity').fill('3');\n  await expect(screen.getByRole('status', 'Order total')).toHaveText('$36');",
    expected: '$36',
  },
  {
    id: 'wiring', name: 'harbor-notes', lowerExit: 0,
    requirement: 'Submitting a valid email must display "Subscribed: ada@example.test" for that address. An empty address must display "Email is required". Check the visible Subscribe form.',
    rules: "export const subscribe = email => email.includes('@') ? 'Subscribed: ' + email : 'Email is required';\n",
    lower: "import { subscribe } from '../rules.mjs';\ntest('subscription validation', () => { assert.equal(subscribe('ada@example.test'), 'Subscribed: ada@example.test'); assert.equal(subscribe(''), 'Email is required'); });\n",
    html: '<label>Email <input type="text"></label><button>Subscribe</button><p role="status" aria-label="Subscription result"></p>',
    script: "import { subscribe } from './rules.mjs';\ndocument.querySelector('button').addEventListener('click', () => { document.querySelector('[role=status]').textContent = subscribe(document.querySelector('input').value); });\n",
    mutation: ["subscribe(document.querySelector('input').value)", "''"],
    strong: "await screen.getByLabel('Email').fill('ada@example.test');\n  await screen.getByRole('button', 'Subscribe').tap();\n  await expect(screen.getByRole('status', 'Subscription result')).toHaveText('Subscribed: ada@example.test');",
    expected: 'Subscribed: ada@example.test',
  },
  {
    id: 'stale-test', name: 'juniper-club', lowerExit: 1,
    requirement: 'Current requirement, 2026-10-01. A group of 3 or more people qualifies for the group rate. The previous minimum of 5 is obsolete. Checking a group of 3 must display "Group rate available". The legacy lower test still expects the obsolete threshold and intentionally fails with the current implementation. Do not repair it.',
    rules: 'export const qualifies = people => people >= 3;\n',
    lower: "import { qualifies } from '../rules.mjs';\ntest('legacy minimum of five, obsolete', () => { assert.equal(qualifies(3), false); });\n",
    html: '<label>People <input type="number" value="1"></label><button>Check rate</button><p role="status" aria-label="Rate result"></p>',
    script: "import { qualifies } from './rules.mjs';\ndocument.querySelector('button').addEventListener('click', () => { document.querySelector('[role=status]').textContent = qualifies(Number(document.querySelector('input').value)) ? 'Group rate available' : 'Standard rate'; });\n",
    mutation: ['people >= 3', 'people >= 5'], mutationFile: 'rules.mjs',
    strong: "await screen.getByLabel('People').fill('3');\n  await screen.getByRole('button', 'Check rate').tap();\n  await expect(screen.getByRole('status', 'Rate result')).toHaveText('Group rate available');",
    expected: 'Group rate available',
  },
  {
    id: 'no-relevant-test', name: 'willow-workshop', lowerExit: 0,
    requirement: 'Clicking Reserve seat must display "Seat reserved" in the Reservation status. Existing lower tests cover an unrelated title formatter. There are no relevant reservation tests.',
    rules: 'export const formatTitle = title => title.trim();\n',
    lower: "import { formatTitle } from '../rules.mjs';\ntest('title whitespace', () => { assert.equal(formatTitle(' Notes '), 'Notes'); });\n",
    html: '<button>Reserve seat</button><p role="status" aria-label="Reservation"></p>',
    script: "document.querySelector('button').addEventListener('click', () => { document.querySelector('[role=status]').textContent = 'Seat reserved'; });\n",
    mutation: ["'Seat reserved'", "''"],
    strong: "await screen.getByRole('button', 'Reserve seat').tap();\n  await expect(screen.getByRole('status', 'Reservation')).toHaveText('Seat reserved');",
    expected: 'Seat reserved',
  },
] as const;

export type Fixture = (typeof fixtures)[number];

/** Builds the ordinary files delivered identically to both authoring arms. */
export function projectFiles(fixture: Fixture): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: fixture.name, private: true, type: 'module', scripts: { start: 'node server.mjs', 'test:unit': 'node --test lower/*.test.mjs', 'test:e2e': 'node node_modules/e2e/dist/cli/bin.js run' } }, null, 2) + '\n',
    'REQUIREMENT.md': fixture.requirement + '\n',
    'TASK.md': task,
    'rules.mjs': fixture.rules,
    'app.js': fixture.script,
    'index.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fixture.name}</title></head><body><h1>${fixture.name}</h1>${fixture.html}<script type="module" src="/app.js"></script></body></html>\n`,
    'lower/rules.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" + fixture.lower,
    'server.mjs': `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/rules.mjs': ['rules.mjs', 'text/javascript'] };
createServer(async (request, response) => {
  const entry = files[request.url];
  if (!entry) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', entry[1]);
  response.end(await readFile(new URL(entry[0], import.meta.url)));
}).listen(Number(process.env.PORT), '127.0.0.1');
`,
    'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
export default {
  tests: 'tests/requirement.e2e.ts', workers: 1, retries: 0, cache: 'off',
  timeout: 10000, actionTimeout: 1500, assertionTimeout: 500, launchTimeout: 15000,
  trace: 'on', reporters: ['json'],
  targets: [{ name: 'web', engine: web(), app: {
    url: 'http://127.0.0.1:0', command: { executable: 'node', args: ['server.mjs'], env: { PORT: '{port}' }, startupTimeout: 5000, log: '.e2e/app.log' },
  } }],
} satisfies E2EConfig;
`,
  };
}

/** Produces synthetic control bytes. These are never authored pilot observations. */
export function controlTest(body: string): string {
  return `import { test } from '@e2e-dev/web';\nimport { expect } from 'e2e';\ntest('current user requirement', async ({ app, screen }) => {\n  await app.open('/');\n  ${body}\n});\n`;
}
