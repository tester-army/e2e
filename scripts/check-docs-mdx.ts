/**
 * Fails when a docs page does not compile as standard MDX.
 *
 * Some markup that reads fine in the source fails the standard compiler,
 * such as a bullet list at column 0 inside an indented `<Accordion>`: the
 * indented closing tag joins the last list item, so the component never
 * closes. Any tool that builds these docs with `@mdx-js/mdx` fails on such a
 * page. Every page compiles here with
 * `@mdx-js/mdx` and `remark-gfm`, after its frontmatter, so the reported line
 * and column point into the file.
 *
 * Usage: `node scripts/check-docs-mdx.ts`, part of `pnpm docs:check`.
 * Exits 1 listing every page that fails, with the compiler's reason.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/** Every `.mdx` page under `dir`, skipping `node_modules`. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** The page body with its frontmatter blanked line for line, so positions match the file. */
function body(path: string): string {
  const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  return source.replace(FRONTMATTER, (frontmatter) => frontmatter.replace(/[^\n]/g, ''));
}

const problems: string[] = [];
const all = pages(DOCS);

for (const path of all) {
  const file = relative(DOCS, path).split(sep).join('/');
  try {
    await compile(body(path), { remarkPlugins: [remarkGfm] });
  } catch (error) {
    const { line, column, reason, message } = error as {
      line?: number;
      column?: number;
      reason?: string;
      message: string;
    };
    const where = line === undefined ? file : `${file}:${line}:${column ?? 1}`;
    problems.push(`docs/${where}: ${reason ?? message}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n\nSee authoring-docs, "Showing less at one time".\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs mdx: ${all.length} pages compile as standard MDX\n`);
}
