/** The docs page walker every `check-docs-*` script shares, so the checks cannot drift apart on what a page is. */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `.mdx` page under `dir`, nested folders included, `node_modules`
 * skipped: the file set the docs checks read. The order is the directory
 * order.
 */
export function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}
