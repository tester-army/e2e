/**
 * Asserts that every code block a docs page or the consumer skill shows from
 * `docs/examples/` matches the file it came from.
 *
 * The examples are typechecked against the built packages (`pnpm --filter
 * @e2e-dev/docs typecheck`); Mintlify cannot import a file into a page and a
 * skill is plain markdown, so the page carries a copy of each and this script
 * keeps the copies honest.
 *
 * Usage: `node scripts/check-docs-examples.ts`. Exits 1 listing every block
 * that drifted from its example.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Example file to the page that shows it verbatim. */
const EXAMPLES: Record<string, string> = {
  'docs/examples/quickstart/e2e.config.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/tests/example.e2e.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/tests/agent.e2e.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/mobile/e2e.config.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/mobile/tests/example.e2e.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/mobile/tests/agent.e2e.ts': 'docs/quickstart.mdx',
  'docs/examples/quickstart/e2e.command.config.ts': 'docs/web.mdx',
  'docs/examples/mobile/device-provider.ts': 'docs/mobile.mdx',
  'docs/examples/mobile/device-cloud-provider.ts': 'docs/mobile.mdx',
  'docs/examples/web/browser-provider.ts': 'docs/browser.mdx',
  'docs/examples/models/e2e.decision.config.ts': 'docs/decision-models.mdx',
  'docs/examples/models/tests/decision.e2e.ts': 'docs/decision-models.mdx',
  'docs/examples/skill/e2e.config.ts': 'skills/e2e/SKILL.md',
  'docs/examples/skill/e2e.setup.config.ts': 'skills/e2e/references/setup.md',
  'docs/examples/tern/engine.ts': 'docs/tern.mdx',
  'docs/examples/sway/engine.ts': 'docs/sway.mdx',
};

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
  const blocks = new Map<string, string[]>();
  const missing = Object.entries(EXAMPLES).filter(([example, page]) => {
    const pageBlocks = blocks.get(page) ?? codeBlocks(read(page));
    blocks.set(page, pageBlocks);
    return !pageBlocks.includes(read(example).trimEnd());
  });
  if (missing.length > 0) {
    process.stderr.write(
      `${missing.map(([example, page]) => `${page}: no code block matches ${example}`).join('\n')}\n`,
    );
    return 1;
  }
  const pages = new Set(Object.values(EXAMPLES));
  process.stdout.write(
    `docs examples: ${Object.keys(EXAMPLES).length} files shown verbatim in ${[...pages].join(', ')}\n`,
  );
  return 0;
}

process.exitCode = main();
