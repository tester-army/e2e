/**
 * A received email as the runner holds it: the provider's message and one
 * text that the test, the filters, and the model all read, and nothing
 * inferred. Codes and links are not
 * read out of it: the patterns that find a code in one sender's template
 * return a footer's zip code in the next, so a test takes what it needs with
 * its own pattern and the agent reads the email the way a person does.
 *
 * An HTML part is rendered to text in one pass over the markup, linear in its
 * length whatever it holds: unterminated tags and hostile nesting cost what a
 * well-formed template does.
 */

import { describePattern, matchesText, toTextPattern } from '../internal/text.ts';
import type { TextMatch } from '../types.ts';
import type { EmailMessage, MailMessage } from './types.ts';

/**
 * The test's copy of a provider's message. Its text is the HTML part
 * rendered when there is one, since that is what a reader sees and it carries
 * the links a plain part may leave out, and the plain part otherwise: one
 * rendering for every provider, whatever plain part it derives on its own.
 */
export function toEmailMessage(message: MailMessage): EmailMessage {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    cc: message.cc ?? [],
    subject: message.subject,
    text: message.html !== undefined && message.html.trim() !== '' ? renderHtml(message.html) : (message.text ?? ''),
    html: message.html,
    receivedAt: message.receivedAt,
  };
}

/** Whether a field matches a filter value; an absent value matches everything. */
export function matchesField(actual: string, match: TextMatch | undefined): boolean {
  return match === undefined || matchesText(actual, toTextPattern(match, { exact: false }));
}

/** A filter value as a diagnostic spells it. */
export function describeMatch(match: TextMatch): string {
  return describePattern(toTextPattern(match, { exact: false }));
}

/** HTML beyond this is not rendered: a real template is a few hundred kilobytes. */
const MAX_HTML_CHARS = 2_000_000;

/** Elements whose content is never text. */
const RAW_TEXT = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);
/** Elements that start and end a line of their own. */
const BLOCK = new Set(['p', 'div', 'tr', 'li', 'ul', 'ol', 'table', 'tbody', 'thead', 'blockquote', 'section', 'article', 'header', 'footer', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'pre']);
/** Elements a boundary separates from their neighbours; inline ones (`b`, `span`) run together as a mail client draws them. */
const CELL = new Set(['td', 'th', 'img', 'button', 'input', 'select', 'textarea']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);

const TAG_START = /^[a-zA-Z/!?]$/u;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/iu;
const ATTRIBUTE = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/gu;

/**
 * Elements whose end tag may be left out, each with the start tags that end
 * it implicitly: `<p hidden>a<p>b` hides `a` and shows `b`. Any closing tag
 * other than an inline one's ends them too (`</ul>` ends an open `<li>`).
 */
const IMPLIED_END: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['p', BLOCK],
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])],
  ['dd', new Set(['dt', 'dd'])],
  ['td', new Set(['td', 'th', 'tr'])],
  ['th', new Set(['td', 'th', 'tr'])],
  ['tr', new Set(['tr'])],
  ['option', new Set(['option'])],
  ['thead', new Set(['tbody', 'tfoot'])],
  ['tbody', new Set(['tbody', 'tfoot'])],
]);
const INLINE = new Set(['a', 'abbr', 'b', 'i', 'em', 'strong', 'span', 'font', 'u', 's', 'small', 'sup', 'sub', 'code', 'label', 'img', 'br']);
/** Containers whose rows and items belong to them, not to a hidden element around them. */
const NESTING = new Set(['table', 'ul', 'ol', 'dl', 'select']);

/** One step of the scan: a run of text, a tag, or markup that says nothing (a comment, a declaration). */
type Token =
  | { readonly kind: 'text'; readonly text: string; readonly end: number }
  | { readonly kind: 'tag'; readonly tag: Tag; readonly start: number; readonly end: number }
  | { readonly kind: 'skip'; readonly end: number };

/** The token that starts at `from`; `end` is where the next one starts. */
function nextToken(source: string, from: number): Token {
  const open = source.indexOf('<', from);
  if (open === -1) return { kind: 'text', text: source.slice(from), end: source.length };
  if (open > from) return { kind: 'text', text: source.slice(from, open), end: open };
  if (source.startsWith('<!--', open)) {
    const close = source.indexOf('-->', open + 4);
    return { kind: 'skip', end: close === -1 ? source.length : close + 3 };
  }
  // A `<` no tag name follows is text (`a < b`).
  if (!TAG_START.test(source[open + 1] ?? '')) return { kind: 'text', text: '<', end: open + 1 };
  const close = tagEnd(source, open + 1);
  if (close === -1) return { kind: 'skip', end: source.length };
  const tag = parseTag(source.slice(open + 1, close));
  // A declaration (`<!DOCTYPE>`, `<?xml ?>`) is skipped.
  return tag === undefined ? { kind: 'skip', end: close + 1 } : { kind: 'tag', tag, start: open, end: close + 1 };
}

/**
 * The visible text of an HTML part: hidden elements, comments, styles, and
 * scripts left out, each link's URL after its label. Every character is read
 * a fixed number of times, so the cost is linear in the length.
 */
export function renderHtml(html: string): string {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const parts: string[] = [];
  /** The open anchor: where its label starts in `parts`, its URL, and the alt text of images inside it. Anchors do not nest. */
  let anchor: { readonly start: number; readonly href: string | undefined; alt: string } | undefined;
  const closeAnchor = (): void => {
    if (anchor === undefined) return;
    const { start, href, alt } = anchor;
    anchor = undefined;
    if (href === undefined || !/^https?:\/\//iu.test(href)) return;
    const label = collapse(parts.slice(start).join(''));
    if (label === '' && alt.trim() !== '') parts.push(alt.trim());
    if (label !== href) parts.push(` <${href}>`);
  };
  let index = 0;
  while (index < source.length) {
    const token = nextToken(source, index);
    index = token.end;
    if (token.kind === 'text') parts.push(decodeEntities(token.text));
    if (token.kind !== 'tag') continue;
    const { tag } = token;
    if (!tag.closing && RAW_TEXT.has(tag.name)) {
      index = skipRawText(source, tag.name, index);
      continue;
    }
    if (!tag.closing && isHidden(tag.attributes)) {
      if (!VOID.has(tag.name) && !tag.selfClosing) index = skipHidden(source, tag.name, index);
      continue;
    }
    if (tag.name === 'br' || BLOCK.has(tag.name)) parts.push('\n');
    else if (CELL.has(tag.name)) parts.push(' ');
    if (tag.name === 'img' && anchor !== undefined) {
      const alt = tag.attributes.get('alt');
      if (alt !== undefined) anchor.alt += ` ${decodeEntities(alt)}`;
    }
    if (tag.name !== 'a') continue;
    closeAnchor();
    if (!tag.closing) {
      const href = tag.attributes.get('href')?.replace(/\s+/gu, '');
      anchor = { start: parts.length, href: href === undefined ? undefined : decodeEntities(href), alt: '' };
    }
  }
  closeAnchor();
  return parts
    .join('')
    .split('\n')
    .map(collapse)
    .filter((line) => line !== '')
    .join('\n');
}

/** Where a tag that opened before `from` ends: its `>` outside a quoted attribute value, or -1 when it never does. */
function tagEnd(source: string, from: number): number {
  let quote: string | undefined;
  let afterEquals = false;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '>') return index;
    if ((char === '"' || char === "'") && afterEquals) {
      quote = char;
      continue;
    }
    if (char === '=') afterEquals = true;
    else if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r' && char !== '\f') afterEquals = false;
  }
  return -1;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
}

function parseTag(body: string): Tag | undefined {
  const match = /^(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/u.exec(body);
  if (match === null) return undefined;
  const attributes = new Map<string, string>();
  const rest = body.slice(match[0].length);
  for (const attribute of rest.matchAll(ATTRIBUTE)) {
    const name = attribute[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
  }
  return { name: match[2]!.toLowerCase(), closing: match[1] === '/', selfClosing: rest.trimEnd().endsWith('/'), attributes };
}

function isHidden(attributes: ReadonlyMap<string, string>): boolean {
  return attributes.has('hidden') || HIDDEN_STYLE.test(attributes.get('style') ?? '');
}

/** Where a raw-text element (`style`, `script`) that opened just before `from` ends: after its first closing tag. */
function skipRawText(source: string, name: string, from: number): number {
  let index = from;
  while (index < source.length) {
    const token = nextToken(source, index);
    index = token.end;
    if (token.kind === 'tag' && token.tag.closing && token.tag.name === name) return index;
  }
  return source.length;
}

/**
 * Where a hidden element that opened just before `from` ends. One with a
 * required end tag ends at the closing tag that balances the same-name tags
 * opened inside it; one whose end tag may be left out also ends, unread, at
 * the tag that ends it implicitly. Comments inside are skipped whole. An
 * element that never ends runs to the end.
 */
function skipHidden(source: string, name: string, from: number): number {
  const implied = IMPLIED_END.get(name);
  let depth = 1;
  /** Tables and lists opened inside: their cells and items are theirs, and end nothing. */
  let nested = 0;
  let index = from;
  while (index < source.length) {
    const token = nextToken(source, index);
    if (token.kind !== 'tag') {
      index = token.end;
      continue;
    }
    const { tag } = token;
    if (implied !== undefined && depth === 1 && nested === 0) {
      if (!tag.closing && implied.has(tag.name)) return token.start;
      if (tag.closing && tag.name !== name && !INLINE.has(tag.name)) return token.start;
    }
    index = token.end;
    if (NESTING.has(tag.name) && tag.name !== name) nested = Math.max(0, nested + (tag.closing ? -1 : 1));
    if (nested > 0) continue;
    if (tag.name !== name) continue;
    if (tag.closing) depth -= 1;
    else if (!tag.selfClosing && implied === undefined) depth += 1;
    if (depth === 0) return index;
  }
  return source.length;
}

/** Characters that take no space: joiners, marks, and the soft hyphen templates pad preheaders with. */
const INVISIBLE = /\u00AD|\u034F|[\u200B-\u200D]|\u2060|\uFEFF/gu;

function collapse(line: string): string {
  return line.replace(INVISIBLE, '').replace(/[^\S\n]+/gu, ' ').trim();
}

/** The Latin-1 entities by name, in code point order from U+00A0: what European templates spell accents and symbols with. */
const LATIN1_ENTITIES = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(' ');

/** Named entities as HTML spells them (case matters: `Eacute` is not `eacute`), the Latin-1 set plus the typography templates use. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ...LATIN1_ENTITIES.map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]),
  ['nbsp', ' '],
  ['shy', ''],
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['AMP', '&'], ['LT', '<'], ['GT', '>'], ['QUOT', '"'], ['COPY', '\u00A9'], ['REG', '\u00AE'],
  ['rsquo', '\u2019'], ['lsquo', '\u2018'], ['sbquo', '\u201A'], ['rdquo', '\u201D'], ['ldquo', '\u201C'], ['bdquo', '\u201E'],
  ['mdash', '\u2014'], ['ndash', '\u2013'], ['hellip', '\u2026'], ['bull', '\u2022'], ['prime', '\u2032'],
  ['lsaquo', '\u2039'], ['rsaquo', '\u203A'], ['dagger', '\u2020'], ['Dagger', '\u2021'], ['permil', '\u2030'],
  ['trade', '\u2122'], ['euro', '\u20AC'], ['OElig', '\u0152'], ['oelig', '\u0153'], ['Scaron', '\u0160'], ['scaron', '\u0161'],
  ['Yuml', '\u0178'], ['fnof', '\u0192'], ['circ', '\u02C6'], ['tilde', '\u02DC'],
  ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', ''], ['zwj', ''], ['lrm', ''], ['rlm', ''],
]);

/** An entity: a numeric one, a named one with its `;`, or one of the five a browser also reads without it (`&amp` in an old template), never before `=` so a query string's `&lt=4` stays. */
const ENTITY = /&(?:#[xX]([\da-fA-F]+);?|#(\d+);?|([a-zA-Z][a-zA-Z0-9]*);|(amp|lt|gt|quot|nbsp)(?![a-zA-Z0-9;=]))/gu;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity, hex: string | undefined, decimal: string | undefined, name: string | undefined, bare: string | undefined) => {
    if (hex !== undefined || decimal !== undefined) {
      const point = hex === undefined ? Number.parseInt(decimal!, 10) : Number.parseInt(hex, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return NAMED_ENTITIES.get(name ?? bare!) ?? entity;
  });
}
