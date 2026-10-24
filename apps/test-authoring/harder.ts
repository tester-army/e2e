import { z } from 'zod';
import { checkout } from './fixtures/checkout.ts';
import { adjacency } from './fixtures/adjacency.ts';
import { capacity } from './fixtures/capacity.ts';
import { address } from './fixtures/address.ts';
import { policy } from './fixtures/policy.ts';
import { persistence } from './fixtures/persistence.ts';

export interface HardFixture {
  id: string;
  name: string;
  kind: 'informative' | 'safeguard';
  requirement: string;
  files: Record<string, string>;
  lowerExit: 0;
  mutationFile: string;
  mutation: readonly [string, string];
  strong: string;
  weak: string;
  expected: string;
}

export const harderFixtures: readonly HardFixture[] = [checkout, adjacency, capacity, address, policy, persistence];
export const harderStudy = 'harder-baseline-feasibility';
export const harderFixtureIds = ['checkout', 'adjacency', 'capacity', 'address', 'policy', 'persistence'] as const;
export const harderTask = `Add deterministic browser E2E coverage for the important user journeys described in PRODUCT.md.
Choose a compact set of regression cases, use the installed e2e skill and public APIs, and run the coverage locally.
Keep the supplied project files unchanged and return exactly tests/requirement.e2e.ts.
The test must be self-contained and import only test from @e2e-dev/web and expect from e2e.
Exercise the real UI. Do not import app code, inspect the filesystem, use network APIs, runtime AI, mocks, browser scripts, skips, or environment-dependent branches.
The supplied configuration starts the app. Use app.open('/') and semantic screen locators.
`;

const fixtureSchema = z.object({
  id: z.enum(harderFixtureIds),
  name: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/), kind: z.enum(['informative', 'safeguard']),
  requirement: z.string().min(1), files: z.record(z.string(), z.string()), lowerExit: z.literal(0),
  mutationFile: z.string().min(1), mutation: z.tuple([z.string().min(1), z.string()]),
  strong: z.string().min(1), weak: z.string().min(1), expected: z.string().min(1),
}).strict();

/** Parses the fixed six-product corpus before it enters a frozen study. */
export function parseHarderFixtures(value: unknown): HardFixture[] {
  const entries = z.array(fixtureSchema).length(6).parse(value);
  if (new Set(entries.map(entry => entry.id)).size !== 6 || new Set(entries.map(entry => entry.name)).size !== 6) throw new Error('Harder fixtures must have six distinct identities');
  const reserved = /^(?:package\.json|TASK\.md|server\.mjs|e2e\.config\.ts|node_modules|\.agents|\.home|\.e2e|tests)(?:\/|$)/;
  for (const entry of entries) {
    if (entry.kind !== (['policy', 'persistence'].includes(entry.id) ? 'safeguard' : 'informative')) throw new Error('Harder fixture family changed');
    for (const path of Object.keys(entry.files)) if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split('/').some(part => part === '.' || part === '..') || reserved.test(path)) throw new Error(`Unsafe or reserved fixture path ${path}`);
    for (const path of ['PRODUCT.md', 'index.html', 'app.js', 'lower/rules.test.mjs']) if (!(path in entry.files)) throw new Error(`Missing public fixture file ${path}`);
    if (entry.files['PRODUCT.md'] !== entry.requirement) throw new Error('Product contract differs from packet requirement');
    if (!entry.files[entry.mutationFile] || entry.files[entry.mutationFile]!.split(entry.mutation[0]).length !== 2 || entry.mutation[0] === entry.mutation[1]) throw new Error('Mutation must have exactly one public source target');
  }
  return entries;
}

/** Adds the common local runtime without exposing private fixture metadata. */
export function harderProjectFiles(fixture: HardFixture): Record<string, string> {
  const urls = Object.fromEntries(Object.keys(fixture.files).filter(path => /\.(?:html|m?js|json|css)$/.test(path)).map(path => ['/' + (path === 'index.html' ? '' : path), [path, path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'text/javascript']]));
  return {
    ...fixture.files,
    'package.json': JSON.stringify({ name: fixture.name, private: true, type: 'module', scripts: { start: 'node server.mjs', 'test:unit': 'node --test lower/*.test.mjs', 'test:e2e': 'node node_modules/e2e/dist/cli/bin.js run' } }, null, 2) + '\n',
    'TASK.md': harderTask,
    'server.mjs': `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files = ${JSON.stringify(urls)};
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
