/**
 * Asserts that every code block the quickstart shows from `docs/examples/`
 * matches the file it came from.
 *
 * The examples are typechecked against the built packages (`pnpm --filter
 * @e2edev/docs typecheck`); Mintlify cannot import a file into a page, so the
 * quickstart carries a copy of each and this script keeps the copies honest.
 *
 * Usage: `node scripts/check-docs-examples.ts`. Exits 1 listing every block
 * that drifted from its example.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = 'docs/quickstart.mdx';
const EXAMPLES = [
  'docs/examples/quickstart/e2e.config.ts',
  'docs/examples/quickstart/e2e.command.config.ts',
  'docs/examples/quickstart/tests/example.e2e.ts',
  'docs/examples/quickstart/tests/agent.e2e.ts',
];

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The bodies of every fenced code block on the page, with the fence's indentation removed. */
function codeBlocks(text: string): string[] {
  return [...text.matchAll(/^( *)```[^\n]*\n([\s\S]*?)^\1```$/gm)].map(([, indent, body]) =>
    body!
      .split('\n')
      .map((line) => (line.startsWith(indent!) ? line.slice(indent!.length) : line))
      .join('\n')
      .trimEnd(),
  );
}

function main(): number {
  const blocks = codeBlocks(read(PAGE));
  const missing = EXAMPLES.filter((example) => !blocks.includes(read(example).trimEnd()));
  if (missing.length > 0) {
    process.stderr.write(
      `${missing.map((example) => `${PAGE}: no code block matches ${example}`).join('\n')}\n`,
    );
    return 1;
  }
  process.stdout.write(`docs examples: ${EXAMPLES.length} files shown verbatim in ${PAGE}\n`);
  return 0;
}

process.exitCode = main();
