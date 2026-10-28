/**
 * Fails when a vendor page in the docs is missing its logo.
 *
 * Every page under `docs/integrations/`, `docs/ci/`, and `docs/migrate/`
 * (except an `index.mdx`) is about one vendor, so it needs both logos:
 *
 * - a sidebar icon: `icon:` in the frontmatter names a file under
 *   `/images/icons/`, the black silhouette the docs site greys out;
 * - a card logo: every `<Card>` on any page that links to it names a file
 *   under `/images/integrations/`, the brand-colored mark.
 *
 * Pages under `docs/integrations/` and `docs/ci/` must also have a card on
 * their overview (`docs/integrations/index.mdx`, `docs/ci.mdx`), so a new
 * page cannot ship without the card that shows its logo.
 *
 * Usage: `node scripts/check-docs-logos.ts`, part of `pnpm docs:check`.
 * Exits 1 listing every problem.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const SITE = 'https://e2e.tester.army/docs';
const SIDEBAR_DIR = '/images/icons/';
const CARD_DIR = '/images/integrations/';

/** Vendor sections, and the overview page that must hold a card for each of their pages. */
const SECTIONS: { dir: string; overview?: string }[] = [
  { dir: 'integrations', overview: 'integrations/index.mdx' },
  { dir: 'ci', overview: 'ci.mdx' },
  { dir: 'migrate' },
];

const CARD = /<Card\b[^>]*>/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const JSX_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;

/** Every `.mdx` page under `dir`, skipping `node_modules`. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(path);
    return entry.name.endsWith('.mdx') ? [path] : [];
  });
}

/** A docs path relative to `docs/`, with `/` separators on every OS. */
function docsPath(path: string): string {
  return relative(DOCS, path).split(sep).join('/');
}

/** A page's source with LF line endings, so the patterns match a CRLF checkout too. */
function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** The source with code fences and JSX comments blanked, keeping line numbers, so only rendered cards count. */
function rendered(source: string): string {
  let open: string | undefined;
  const lines = source.split('\n').map((line) => {
    const fence = FENCE.exec(line)?.[1];
    if (open) {
      if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = undefined;
      return '';
    }
    if (fence) {
      open = fence;
      return '';
    }
    return line;
  });
  return lines.join('\n').replace(JSX_COMMENT, (comment) => comment.replace(/[^\n]/g, ''));
}

/** The `icon:` value in a page's frontmatter, without quotes. */
function frontmatterIcon(source: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  return /^icon:\s*"?([^"\n]*)"?\s*$/m.exec(frontmatter)?.[1];
}

/** One attribute of a JSX tag. */
function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** A card `href` as a page route: no site prefix, query, hash, or trailing slash. */
function route(href: string): string {
  const path = href.startsWith(SITE) ? href.slice(SITE.length) : href;
  return path.replace(/[#?].*$/, '').replace(/(.)\/$/, '$1');
}

/** Problems with a logo path: wrong directory, or no such file. */
function checkLogo(where: string, what: string, icon: string | undefined, dir: string): string[] {
  if (!icon) return [`${where}: no ${what}; add a logo under docs${dir}`];
  if (!posix.normalize(icon).startsWith(dir)) return [`${where}: ${what} is "${icon}"; use the vendor's logo under docs${dir}`];
  if (!existsSync(join(DOCS, icon))) return [`${where}: ${what} "${icon}" does not exist`];
  return [];
}

const problems: string[] = [];
const vendorPages = new Map<string, string>();

for (const { dir } of SECTIONS) {
  for (const path of pages(join(DOCS, dir))) {
    if (basename(path) === 'index.mdx') continue;
    const file = relative(ROOT, path);
    vendorPages.set(`/${docsPath(path).replace(/\.mdx$/, '')}`, file);
    problems.push(...checkLogo(file, 'sidebar icon', frontmatterIcon(read(path)), SIDEBAR_DIR));
  }
}

const carded = new Map<string, Set<string>>();
for (const path of pages(DOCS)) {
  const source = rendered(read(path));
  const page = docsPath(path);
  for (const match of source.matchAll(CARD)) {
    const href = attribute(match[0], 'href');
    const target = href === undefined ? undefined : route(href);
    if (!target || !vendorPages.has(target)) continue;
    let targets = carded.get(page);
    if (!targets) carded.set(page, (targets = new Set()));
    targets.add(target);
    const line = source.slice(0, match.index).split('\n').length;
    const where = `${relative(ROOT, path)}:${line}`;
    problems.push(...checkLogo(where, `card icon for ${target}`, attribute(match[0], 'icon'), CARD_DIR));
  }
}

for (const { dir, overview } of SECTIONS) {
  if (!overview) continue;
  for (const [target, file] of vendorPages) {
    if (!target.startsWith(`/${dir}/`) || carded.get(overview)?.has(target)) continue;
    problems.push(`${file}: no <Card href="${target}"> on docs/${overview}; add one with its logo under docs${CARD_DIR}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs logos: ${vendorPages.size} vendor pages have a sidebar icon and card logos\n`);
}
