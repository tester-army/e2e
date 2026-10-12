/** @jsxRuntime automatic @jsxImportSource react */

/**
 * Renders one Open Graph card per docs page with `@vercel/og` and points the
 * page's `og:image` and `twitter:image` frontmatter at it.
 *
 * The card is `images/og.png` with its text swapped for the page's: the same
 * dotted backdrop (`og/background.png`, the brand card with the
 * wordmark, tagline, and mascot painted out) with the mascot (`og/mascot.png`)
 * drawn back in a little larger, the e2e logo in the top-right corner, and the
 * page's navigation section, title, and description in the bottom left, all
 * in Stack Sans Notch.
 *
 * Mintlify builds the site from the repository and runs nothing of ours, so
 * the cards are rendered here and committed. Each card's digest covers
 * everything it is drawn from: the page text, the layout code, the images,
 * the fonts, and the `@vercel/og` version. It goes in the image URL (`?v=`), so
 * a changed card gets a URL social networks have not cached, and in a `tEXt`
 * chunk of the PNG. `--check` compares both against the expected digest
 * without rendering, so it is fast, does not depend on the platform's
 * rasterizer, and fails when a page or its PNG was committed without the
 * other.
 *
 * A page with no `og:image` (the home page, or a page nobody ran this script
 * for) falls back to the brand card set site-wide in `docs.json`. That is
 * also why this script removes the image lines from pages that left the
 * navigation instead of leaving them on a card it deletes.
 *
 * Usage, from `docs/` (`tsx` compiles the JSX, which Node's type stripping
 * does not):
 *   tsx og/generate.tsx           render stale cards, update frontmatter
 *   tsx og/generate.tsx --force   render every card
 *   tsx og/generate.tsx --check   exit 1 listing pages whose card is stale
 */

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageResponse } from '@vercel/og';
import type { ReactElement } from 'react';

const DOCS = fileURLToPath(new URL('..', import.meta.url));
const OG = join(DOCS, 'og');
const OUT = join(DOCS, 'images', 'og');
const SITE = 'https://e2e.tester.army/docs';
const BACKGROUND = join(OG, 'background.png');
const WIDTH = 2400;
const HEIGHT = 1260;
/** Pages that keep the brand card (`images/og.png`, set site-wide in `docs.json`). */
const BRAND_PAGES = new Set(['index']);
/** Where the mascot's pixels start in `og/mascot.png`, as in `images/og.png`. */
const MASCOT_LEFT = 65;
const MASCOT_TOP = 62;
/** How much larger than in `images/og.png` the mascot is drawn. */
const MASCOT_SCALE = 1.3;
/** The e2e logo in the top-right corner, set in Stack Sans Notch. */
const LOGO = { size: 132, top: 84, right: 96 };
const META_KEYS = ['og:image', 'twitter:image'] as const;
/** The faces the cards use, each from a file in `og/fonts/`. */
const FONTS = [
  { name: 'Stack Sans Notch', weight: 400, file: 'StackSansNotch-400.ttf' },
  { name: 'Stack Sans Notch', weight: 500, file: 'StackSansNotch-500.ttf' },
  { name: 'DM Mono', weight: 500, file: 'DMMono-500.ttf' },
] as const;
/** The PNG `tEXt` keyword that holds a card's digest. */
const DIGEST_KEY = 'e2e-og-digest';

interface Page {
  slug: string;
  file: string;
  eyebrow: string;
  title: string;
  description: string;
}

/** Every page in `docs.json` navigation, with the tab and group it sits under. */
function navigation(): { slug: string; eyebrow: string }[] {
  const config = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8')) as {
    navigation: { tabs: { tab: string; groups?: Group[]; pages?: Entry[] }[] };
  };
  type Entry = string | Group;
  type Group = { group: string; pages: Entry[] };
  const found: { slug: string; eyebrow: string }[] = [];
  const walk = (entries: Entry[], trail: string[]): void => {
    for (const entry of entries) {
      if (typeof entry === 'string') found.push({ slug: entry, eyebrow: trail.join(' / ') });
      else walk(entry.pages, [...trail, entry.group]);
    }
  };
  for (const tab of config.navigation.tabs) {
    walk(tab.pages ?? [], [tab.tab]);
    for (const group of tab.groups ?? []) walk(group.pages, [tab.tab, group.group]);
  }
  return found;
}

/** The frontmatter block of a page: its lines, where it ends, and the file's line ending. */
function frontmatter(source: string, file: string): { lines: string[]; end: number; eol: string } {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(eol);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) throw new Error(`${file}: no frontmatter`);
  return { lines, end, eol };
}

/** One scalar frontmatter value, unquoted. */
function field(lines: string[], end: number, key: string): string | undefined {
  const line = lines.slice(1, end).find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  const value = line.slice(key.length + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** The pages that get a card, read from navigation and frontmatter. */
function pages(nav: { slug: string; eyebrow: string }[]): Page[] {
  return nav
    .filter(({ slug }) => !BRAND_PAGES.has(slug))
    .map(({ slug, eyebrow }) => {
      const file = join(DOCS, `${slug}.mdx`);
      const { lines, end } = frontmatter(readFileSync(file, 'utf8'), relative(DOCS, file));
      const title = field(lines, end, 'title');
      if (!title) throw new Error(`${relative(DOCS, file)}: no title`);
      return { slug, file, eyebrow, title, description: field(lines, end, 'description') ?? '' };
    });
}

/**
 * Everything every card is drawn from, besides the page text. The layout
 * functions count by their source, not this whole file, so editing the rest
 * of the script does not re-render and re-commit every card.
 */
function assets(): Buffer[] {
  const og = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@vercel/og/package.json')), 'utf8')) as { version: string };
  return [
    Buffer.from(
      JSON.stringify([og.version, WIDTH, HEIGHT, MASCOT_LEFT, MASCOT_TOP, MASCOT_SCALE, LOGO, FONTS, Card.toString(), titleSize.toString(), render.toString()]),
    ),
    readFileSync(BACKGROUND),
    readFileSync(join(OG, 'mascot.png')),
    ...FONTS.map((f) => readFileSync(join(OG, 'fonts', f.file))),
  ];
}

/** `png` with a `tEXt` chunk holding `version` after its header chunk. */
function withDigest(png: Buffer, version: string): Buffer {
  const body = Buffer.from(`${DIGEST_KEY}\0${version}`, 'latin1');
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write('tEXt', 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.length)), 8 + body.length);
  const afterHeader = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, afterHeader), chunk, png.subarray(afterHeader)]);
}

/** The digest a card was rendered for, or undefined when the file is missing or has none. */
function digestOf(image: string): string | undefined {
  if (!existsSync(image)) return undefined;
  const png = readFileSync(image);
  for (let at = 8; at + 12 <= png.length; at += 12 + png.readUInt32BE(at)) {
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') return undefined;
    if (type !== 'tEXt') continue;
    const [key, value] = png.toString('latin1', at + 8, at + 8 + png.readUInt32BE(at)).split('\0');
    if (key === DIGEST_KEY) return value;
  }
  return undefined;
}

/** A short digest of what one card is drawn from. */
function digest(shared: string, page: Page): string {
  return createHash('sha256')
    .update(shared)
    .update(JSON.stringify([page.eyebrow, page.title, page.description]))
    .digest('hex')
    .slice(0, 10);
}

/** Title size by length, so long titles wrap to at most two lines. */
function titleSize(title: string): number {
  if (title.length <= 14) return 260;
  if (title.length <= 20) return 230;
  return 190;
}

/** Every `.mdx` page under `dir` as a slug, skipping `node_modules` and snippets. */
function slugs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'snippets', 'og'].includes(entry.name) ? [] : slugs(path);
    return entry.name.endsWith('.mdx') ? [relative(DOCS, path).slice(0, -'.mdx'.length).split(sep).join('/')] : [];
  });
}

/** A PNG file as a data URL satori can draw. */
function dataUrl(path: string): string {
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
}

interface CardProps {
  page: Page;
  background: string;
  mascot: string;
}

/** The card for one page. */
function Card({ page, background, mascot }: CardProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        position: 'relative',
        width: WIDTH,
        height: HEIGHT,
        backgroundColor: '#161616',
        color: '#ffffff',
        fontFamily: 'Stack Sans Notch',
      }}
    >
      <img src={background} width={WIDTH} height={HEIGHT} style={{ position: 'absolute', left: 0, top: 0 }} />
      <img
        src={mascot}
        width={280 * MASCOT_SCALE}
        height={230 * MASCOT_SCALE}
        style={{ position: 'absolute', left: MASCOT_LEFT * (1 - MASCOT_SCALE), top: MASCOT_TOP * (1 - MASCOT_SCALE) }}
      />
      <div
        style={{
          display: 'flex',
          position: 'absolute',
          top: LOGO.top,
          right: LOGO.right,
          fontSize: LOGO.size,
          fontWeight: 500,
          lineHeight: 1,
        }}
      >
        e2e
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-end',
          width: '100%',
          height: '100%',
          padding: `0 ${MASCOT_LEFT}px ${MASCOT_TOP + 20}px ${MASCOT_LEFT}px`,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontFamily: 'DM Mono',
            fontWeight: 500,
            fontSize: 46,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#a3a3a3',
          }}
        >
          {page.eyebrow}
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 28,
            fontSize: titleSize(page.title),
            fontWeight: 500,
            lineHeight: 1.05,
            letterSpacing: '-0.01em',
          }}
        >
          {page.title}
        </div>
        {page.description && (
          <div
            style={{
              display: 'flex',
              marginTop: 32,
              maxWidth: 2100,
              fontSize: 62,
              fontWeight: 400,
              lineHeight: 1.3,
              textWrap: 'balance',
              color: '#a3a3a3',
            }}
          >
            {page.description}
          </div>
        )}
      </div>
    </div>
  );
}

/** Points the page's image metatags at `url`, or removes them, keeping the rest of the file. */
function withImage(source: string, file: string, url: string | undefined): string {
  const { lines, end, eol } = frontmatter(source, file);
  const kept = lines.slice(1, end).filter((l) => !META_KEYS.some((key) => l.startsWith(`"${key}":`)));
  const meta = url === undefined ? [] : META_KEYS.map((key) => `"${key}": ${JSON.stringify(url)}`);
  return ['---', ...kept, ...meta, ...lines.slice(end)].join(eol);
}

/** Renders one card to PNG bytes. */
async function render(element: ReactElement, fonts: ConstructorParameters<typeof ImageResponse>[1]): Promise<Buffer> {
  const response = new ImageResponse(element, { ...fonts, width: WIDTH, height: HEIGHT });
  return Buffer.from(await response.arrayBuffer());
}

const check = process.argv.includes('--check');
const force = process.argv.includes('--force');
const shared = createHash('sha256').update(Buffer.concat(assets())).digest('hex');
const nav = navigation();
const all = pages(nav);
const carded = new Map(all.map((page) => [page.slug, page]));

/** What each page's frontmatter should say: its card, the brand card, or nothing (Mintlify's card). */
const targets = slugs(DOCS).map((slug) => {
  const page = carded.get(slug);
  const version = page ? digest(shared, page) : undefined;
  const url = version ? `${SITE}/images/og/${slug}.png?v=${version}` : undefined;
  return { file: join(DOCS, `${slug}.mdx`), url, page, version, image: join(OUT, `${slug}.png`) };
});
const stale = targets.filter(({ file, url, version, image }) => {
  const source = readFileSync(file, 'utf8');
  if (withImage(source, file, url) !== source) return true;
  return version !== undefined && (force || digestOf(image) !== version);
});
const expected = new Set(all.map((page) => join(OUT, `${page.slug}.png`)));
const orphans = existsSync(OUT)
  ? readdirSync(OUT, { recursive: true, encoding: 'utf8' })
      .map((f) => join(OUT, f))
      .filter((f) => f.endsWith('.png') && !expected.has(f))
  : [];

if (check) {
  const problems = [
    ...stale.map(({ file, page }) =>
      page ? `${relative(DOCS, file)}: Open Graph card is stale` : `${relative(DOCS, file)}: og:image frontmatter should not be there`,
    ),
    ...orphans.map((f) => `${relative(DOCS, f)}: no page uses this card`),
  ];
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nRun \`pnpm docs:og\` and commit the result.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`og: ${all.length} cards up to date\n`);
  }
} else {
  const background = dataUrl(BACKGROUND);
  const mascot = dataUrl(join(OG, 'mascot.png'));
  const font = (file: string): ArrayBuffer => {
    const bytes = readFileSync(join(OG, 'fonts', file));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  const options = { fonts: FONTS.map(({ name, weight, file }) => ({ name, weight, style: 'normal' as const, data: font(file) })) };
  let rendered = 0;
  for (const { file, url, page, version, image } of stale) {
    if (page && version) {
      mkdirSync(dirname(image), { recursive: true });
      writeFileSync(image, withDigest(await render(<Card page={page} background={background} mascot={mascot} />, options), version));
      process.stdout.write(`og: ${relative(DOCS, image)}\n`);
      rendered++;
    }
    writeFileSync(file, withImage(readFileSync(file, 'utf8'), file, url));
  }
  for (const orphan of orphans) rmSync(orphan);
  process.stdout.write(`og: ${rendered} rendered, ${orphans.length} removed, ${stale.length - rendered} frontmatter fixed\n`);
}
