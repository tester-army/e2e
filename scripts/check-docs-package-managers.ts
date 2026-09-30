/**
 * Fails when a docs shell block runs a package manager command outside a
 * `<CodeGroup>` of `npm`, `pnpm`, and `bun` blocks.
 *
 * Mintlify syncs code group tabs by title across every page and remembers the
 * reader's pick, so one choice switches every command in the docs only when
 * each command block offers the same three titles.
 *
 * Usage: `node scripts/check-docs-package-managers.ts`, part of `pnpm docs:check`.
 * Exits 1 listing every offending block.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const TITLES = ['npm', 'pnpm', 'bun'];
const FENCE = /^( *)```(\S*)(?: (\S+))?\s*$/;
const RUNS_PACKAGE_MANAGER = /(^|[\s=]|-- )(npx |npm (install|ci)\b)/m;
const SHELL = new Set(['bash', 'sh', 'shell']);

/** Every `.mdx` page under `dir`, skipping `node_modules`. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** Problems on one page: a package manager block outside a group, or a group without the three titles. */
function check(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const file = relative(ROOT, path);
  const problems: string[] = [];
  let group: { line: number; titles: string[]; runs: boolean } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith('<CodeGroup')) group = { line: i + 1, titles: [], runs: false };
    if (line.trim().startsWith('</CodeGroup>') && group) {
      const complete = group.titles.join(',') === TITLES.join(',');
      if (group.runs && !complete) {
        problems.push(`${file}:${group.line}: code group titles are [${group.titles.join(', ')}], expected [${TITLES.join(', ')}]`);
      }
      group = undefined;
    }
    const fence = FENCE.exec(line);
    if (!fence) continue;
    const [, indent, lang = '', title] = fence;
    let end = i + 1;
    while (end < lines.length && lines[end] !== `${indent}\`\`\``) end++;
    const runs = SHELL.has(lang) && RUNS_PACKAGE_MANAGER.test(lines.slice(i + 1, end).join('\n'));
    if (group) {
      group.titles.push(title ?? '');
      group.runs ||= runs;
    } else if (runs) {
      problems.push(`${file}:${i + 1}: wrap this block in a <CodeGroup> with ${TITLES.map((t) => `\`\`\`${lang} ${t}`).join(', ')} blocks`);
    }
    i = end;
  }
  return problems;
}

const all = pages(DOCS);
const problems = all.flatMap(check);
if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs package managers: every command block in ${all.length} pages offers ${TITLES.join(', ')}\n`);
}
