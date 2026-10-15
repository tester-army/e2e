/**
 * Fails when a docs link points at an `#anchor` that no heading, tab,
 * accordion, or `id` on the target page produces.
 *
 * `mint broken-links` checks pages, not anchors. A broken anchor still opens
 * the page on the site, but a coding agent reading the docs offline from the
 * `e2e` package can't find the section it was sent to. Slugs follow Mintlify:
 * `@sindresorhus/slugify` with a per-page counter for repeated titles.
 *
 * Usage: `node scripts/check-docs-anchors.ts`, part of `pnpm docs:check`.
 * Exits 1 listing every broken anchor.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify, { slugifyWithCounter } from '@sindresorhus/slugify';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const FENCE = /^\s*```/;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const TITLED = /<(Tab|Accordion)\b[^>]*?\btitle="([^"]*)"/g;
const EXPLICIT_ID = /<[A-Z][A-Za-z]*\b[^>]*?\bid="([^"]+)"/g;
const LINK = /\]\(((?:\/[^)\s#]*)?)#([^)\s]+)\)|href="((?:\/[^"#]*)?)#([^"]+)"/g;

/** Every `.mdx` page under `dir`, skipping `node_modules`. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** The page's lines outside code fences, so code samples add no headings or links. */
function prose(source: string): string[] {
  let fenced = false;
  return source.split('\n').filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** Mintlify's id for a heading or tab title, from its plain text. */
function headingSlug(text: string, counter: ReturnType<typeof slugifyWithCounter>): string {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1');
  const id = encodeURIComponent(plain.toLowerCase().trim().replace(/\s+/g, '-'));
  const slug = /%[0-9A-F]{2}/.test(id)
    ? counter(id, { decamelize: false, preserveCharacters: ['%', '_'], lowercase: false })
    : counter(id, { decamelize: false, preserveCharacters: ['_'] });
  return decodeURIComponent(slug).replace(/[?,;:!'"()[\]{}]/g, '');
}

/** Every anchor a page answers to: headings, tab and accordion titles, and explicit ids. */
function anchors(source: string): Set<string> {
  const lines = prose(source);
  const ids = new Set<string>();
  const headings = slugifyWithCounter();
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) ids.add(headingSlug(heading[2]!, headings));
  }
  const text = lines.join('\n');
  const tabs = slugifyWithCounter();
  for (const [, component, title] of text.matchAll(TITLED)) {
    ids.add(component === 'Tab' ? headingSlug(title!, tabs) : slugify(title!.replace(':', '-'), { decamelize: false }));
  }
  for (const [, id] of text.matchAll(EXPLICIT_ID)) ids.add(id!);
  return ids;
}

/** The page file a site path such as `/reference/cli` or `/integrations` names. */
function pageFor(path: string): string | undefined {
  const base = join(DOCS, path === '/' ? 'index' : path);
  return [`${base}.mdx`, join(base, 'index.mdx')].find((candidate) => existsSync(candidate));
}

const all = pages(DOCS);
const cache = new Map<string, Set<string>>();
/** Anchors of one page, read once. */
function anchorsOf(page: string): Set<string> {
  let ids = cache.get(page);
  if (!ids) cache.set(page, (ids = anchors(readFileSync(page, 'utf8'))));
  return ids;
}

const problems: string[] = [];
let checked = 0;
for (const page of all) {
  const lines = readFileSync(page, 'utf8').split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const match of line.matchAll(LINK)) {
      const path = match[1] ?? match[3] ?? '';
      const anchor = decodeURIComponent(match[2] ?? match[4] ?? '');
      const target = path === '' ? page : pageFor(path);
      if (!target) continue;
      checked++;
      if (!anchorsOf(target).has(anchor)) {
        problems.push(`${relative(ROOT, page)}:${i + 1}: no #${anchor} in ${relative(ROOT, target)}`);
      }
    }
  });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs anchors: ${checked} anchor links across ${all.length} pages resolve\n`);
}
