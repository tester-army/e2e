/**
 * Fails when a docs link points at a page that does not exist, or at an
 * `#anchor` that no heading, tab, accordion, or `id` on the target page
 * produces; and when a `docs.json` navigation page or redirect destination
 * has no page.
 *
 * A broken anchor still opens the page on the site, but a coding agent
 * reading the docs offline from the `e2e` package can't find the section it
 * was sent to. Slugs follow the docs site:
 * `@sindresorhus/slugify` with a per-page counter for repeated titles. Only
 * site-relative (`/page#anchor`) and same-page (`#anchor`) links are checked;
 * links to files (`/images/a.png`) are not.
 *
 * Usage: `node scripts/check-docs-anchors.ts`, part of `pnpm docs:check`.
 * Exits 1 listing every broken link.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify, { slugifyWithCounter } from '@sindresorhus/slugify';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,4})\s+(.+?)\s*#*\s*$/;
const CUSTOM_ID = /\s*\{#([^}]+)\}$/;
const COMPONENT = /<(Tab|Accordion|[a-z][\w-]*|ShowMore)\b([^>]*)>/g;
const ATTRIBUTE = (name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`);
const LINK = /\]\(((?:\/[^)\s#?]*)?)(?:\?[^)\s#]*)?#([^)\s]+)\)|href="((?:\/[^"#?]*)?)(?:\?[^"#]*)?#([^"]+)"/g;
const PAGE_LINK = /\]\((\/[^)\s#?]*)[^)\s]*\)|href="(\/[^"#?]*)[^"]*"/g;
const FILE = /\.[a-z0-9]+$/i;

interface DocsJson {
  navigation: { tabs: { pages?: string[]; groups?: { pages: string[] }[] }[] };
  redirects?: { source: string; destination: string }[];
}

/** Every `.mdx` page under `dir`, skipping `node_modules`. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/**
 * The page's lines outside code fences, with their line numbers, so code
 * samples add no headings or links. A fence closes only on the same character
 * at least as long, as in CommonMark, so a four-backtick block can hold a
 * three-backtick one.
 */
function prose(source: string): [number, string][] {
  const lines: [number, string][] = [];
  let open: string | undefined;
  source.split('\n').forEach((line, i) => {
    const fence = FENCE.exec(line)?.[1];
    if (open) {
      if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = undefined;
    } else if (fence) {
      open = fence;
    } else {
      lines.push([i + 1, line]);
    }
  });
  return lines;
}

/** Decodes a percent-encoded anchor, keeping a malformed one as written. */
function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The docs site's id for a heading or tab title, from its plain text. */
function headingSlug(text: string, counter: ReturnType<typeof slugifyWithCounter>): string {
  const plain = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1');
  const id = encodeURIComponent(plain.toLowerCase().trim().replace(/\s+/g, '-'));
  const slug = /%[0-9A-F]{2}/.test(id)
    ? counter(id, { decamelize: false, preserveCharacters: ['%', '_'], lowercase: false })
    : counter(id, { decamelize: false, preserveCharacters: ['_'] });
  return decode(slug).replace(/[?,;:!'"()[\]{}]/g, '');
}

/**
 * Every anchor a page answers to: headings, tab and accordion titles, and the
 * `id` of an HTML element, a tab, an accordion, or a `ShowMore`. The site
 * drops the `id` of other components, such as `Card` or `Steps`.
 */
function anchors(source: string): Set<string> {
  const lines = prose(source);
  const ids = new Set<string>();
  const headings = slugifyWithCounter();
  for (const [, line] of lines) {
    const heading = HEADING.exec(line);
    if (!heading) continue;
    const custom = CUSTOM_ID.exec(heading[2]!);
    ids.add(custom ? custom[1]! : headingSlug(heading[2]!, headings));
  }
  const tabs = slugifyWithCounter();
  const accordions = new Map<string, number>();
  for (const [, component, attributes] of lines.map(([, line]) => line).join('\n').matchAll(COMPONENT)) {
    const id = ATTRIBUTE('id').exec(attributes!)?.[1];
    if (id) {
      ids.add(id);
      continue;
    }
    const title = ATTRIBUTE('title').exec(attributes!)?.[1];
    if (!title) continue;
    if (component === 'Tab') ids.add(headingSlug(title, tabs));
    if (component === 'Accordion') {
      const base = slugify(title.replace(':', '-'), { decamelize: false });
      const count = accordions.get(base) ?? 0;
      accordions.set(base, count + 1);
      ids.add(count > 0 ? `${base}-${count}` : base);
    }
  }
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
  for (const [line, text] of prose(readFileSync(page, 'utf8'))) {
    for (const match of text.matchAll(PAGE_LINK)) {
      const path = match[1] ?? match[2]!;
      if (!FILE.test(path) && !pageFor(path)) {
        problems.push(`${relative(ROOT, page)}:${line}: no page for ${path}`);
      }
    }
    for (const match of text.matchAll(LINK)) {
      const path = match[1] ?? match[3] ?? '';
      const anchor = decode(match[2] ?? match[4] ?? '');
      const target = path === '' ? page : pageFor(path);
      if (!target) continue;
      checked++;
      if (!anchorsOf(target).has(anchor)) {
        problems.push(`${relative(ROOT, page)}:${line}: no #${anchor} in ${relative(ROOT, target)}`);
      }
    }
  }
}

const config = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')) as DocsJson;
for (const tab of config.navigation.tabs) {
  for (const file of [...(tab.pages ?? []), ...(tab.groups ?? []).flatMap((group) => group.pages)]) {
    if (!existsSync(join(DOCS, `${file}.mdx`))) problems.push(`docs/docs.json: navigation page ${file} has no file`);
  }
}
for (const { source, destination } of config.redirects ?? []) {
  const [path = '', anchor] = destination.split('#');
  const target = pageFor(path);
  if (!target) problems.push(`docs/docs.json: redirect ${source} goes to ${destination}, which has no page`);
  else if (anchor && !anchorsOf(target).has(decode(anchor))) {
    problems.push(`docs/docs.json: redirect ${source} goes to ${destination}, but ${relative(ROOT, target)} has no #${anchor}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs anchors: ${checked} anchor links across ${all.length} pages resolve\n`);
}
