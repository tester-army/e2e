/** Runner-side secret redaction. */

import { StringDecoder } from 'node:string_decoder';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import { escapeRegexpChar } from './regexp.ts';

/**
 * Builds a redactor replacing every registered secret value, in each spelling
 * the value takes in text the runner writes or rewrites, with its stable
 * secret name.
 *
 * Occurrences are rewritten leftmost first, and where two values start at
 * one position the longer wins, so a secret that contains another secret is
 * rewritten whole, not half. A marker is never read again once written: the
 * text is cut at the markers of the names the redactor knows and those
 * pieces are left as they are, so redacting twice is redacting once and a
 * value that occurs inside a marker (`api` inside `<secret:apiKey>`, the word
 * `secret` itself) cannot rewrite it. Only known names are cut out: a
 * marker-shaped span of app text holding a raw value is not a marker and is
 * still redacted.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  return compile([...secrets]).redact;
}

interface Compiled {
  readonly redact: (text: string) => string;
  /** `redact` for text cut short at a length limit; see `SecretLedger.redactCut`. */
  readonly redactCut: (text: string) => string;
  /** `redact` that also rewrites fragments of values; see `SecretLedger.redactFragments`. */
  readonly redactFragments: (text: string) => string;
  /** Every occurrence of every value, leftmost first and never overlapping: the matches `redact` rewrites. Absent with no values. */
  readonly pattern: RegExp | undefined;
  /** The most text one occurrence can span; a piece shorter than this holds at most part of one. */
  readonly maxFormLength: number;
  /** The longest marker of a known name; a marker cut short at that length or beyond cannot complete into one. */
  readonly maxMarkerLength: number;
  /** Whether a value can match across a line break, holding one or inner whitespace one stands for: the one case an unfinished line cannot be cut from the line before it. */
  readonly spansLines: boolean;
}

const MARKER_OPEN = '<secret:';
/**
 * The fewest consecutive characters of a value that count as a fragment of
 * it. Fewer say next to nothing about a long value, and a shorter run
 * matches ordinary text often enough to mangle it and, by being masked,
 * tell the reader the value's characters.
 */
const FRAGMENT_LENGTH = 8;
/** What a secret name spells inside its marker; a `>` closes it. */
const MARKER_NAME = /^[A-Za-z0-9_.-]*$/;

/**
 * One pattern over every non-empty value, longest value first. A value
 * matches character by character, each in any case and in any spelling a
 * serializer gives it, so one pattern covers a JSON body, a serialized page, a
 * URL, the raw value, and the value as a text reader or a CSS `text-transform`
 * shows it alike, and a mixed or unusual spelling needs no form of its own.
 * The `i` flag matches hex digits in either case and folds what the
 * per-character case forms leave out: a sigma lower-cased at the end of a
 * word, a titlecase digraph.
 */
function compile(values: readonly (readonly [string, string])[]): Compiled {
  const entries = values.filter(([, value]) => value.length > 0).toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) {
    return {
      redact: (text) => text,
      redactCut: (text) => text,
      redactFragments: (text) => text,
      pattern: undefined,
      maxFormLength: 0,
      maxMarkerLength: 0,
      spansLines: false,
    };
  }
  const markers = entries.map(([name]) => `${MARKER_OPEN}${name}>`);
  const known = markerPattern(entries.map(([name]) => name));
  const patterns = entries.map(([, value]) => valuePattern(value));
  const pattern = new RegExp(patterns.map(({ source }) => `(${source})`).join('|'), 'gi');
  const rewrite = (text: string): string =>
    text.replace(pattern, (_occurrence: string, ...rest: unknown[]) => {
      const matched = rest.slice(0, markers.length).findIndex((group) => group !== undefined);
      return markers[matched] ?? '';
    });
  // `split` on a capturing pattern returns the markers at the odd indexes; those pass through untouched.
  const redact = (text: string): string =>
    text.split(known).map((piece, index) => (index % 2 === 1 ? piece : rewrite(piece))).join('');
  const valueKeys = entries.map(([, value]) => readingKey(value).key);
  // A reader trims a value's leading whitespace as it trims any text's, so a cut part may begin past it.
  const leadingForms = entries.map(([, value], index) => {
    const key = valueKeys[index] ?? '';
    return secretLength(value.trim()) >= MIN_SECRET_LENGTH && key.trimStart() !== key ? [key, key.trimStart()] : [key];
  });
  const redactCut = (text: string): string => {
    // Only what follows the last marker can end in a value cut short.
    const tail = text.split(known).at(-1) ?? '';
    const tailKey = readingKey(tail);
    let cut = 0;
    let marker = '';
    leadingForms.forEach((forms, index) => {
      for (const value of forms) {
        const length = leadingPartAtEnd(tailKey.key, value, Math.min(FRAGMENT_LENGTH, Math.ceil(value.length / 2)));
        if (length > cut) {
          cut = length;
          marker = markers[index] ?? '';
        }
      }
    });
    if (cut === 0) return redact(text);
    // An occurrence the whole-value pass would rewrite across the fragment's start joins the fragment.
    let start = tailKey.at[tailKey.key.length - cut] ?? 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(tail); match !== null && match.index < start; match = pattern.exec(tail)) {
      if (match.index + match[0].length > start) {
        start = match.index;
        break;
      }
    }
    return `${redact(text.slice(0, text.length - tail.length + start))}${marker}`;
  };
  const fragments = fragmentOwners(valueKeys);
  const redactPlainFragments = (text: string): string =>
    redact(text)
      .split(known)
      .map((piece, index) => (index % 2 === 1 ? piece : rewriteFragments(piece, fragments, markers)))
      .join('');
  const redactFragments = (text: string): string => rewriteEncoded(redactPlainFragments(text), redactPlainFragments, known);
  return {
    redact,
    redactCut,
    redactFragments,
    pattern,
    maxFormLength: Math.max(...patterns.map(({ maxLength }) => maxLength)),
    maxMarkerLength: Math.max(...markers.map((marker) => marker.length)),
    spansLines: entries.some(([, value]) => value.includes('\n') || /\s/.test(value.trim())),
  };
}

/** Matches the marker of any known name, captured so `split` keeps the markers. */
function markerPattern(names: readonly string[]): RegExp {
  const alternatives = [...new Set(names)].map(literal).join('|');
  return new RegExp(`(<secret:(?:${alternatives})>)`);
}

interface Pattern {
  readonly source: string;
  /** The most text one match can span. */
  readonly maxLength: number;
}

/**
 * The source matching `value` in every spelling, and the most text one match
 * of it can span. Each character matches in every case form and spelling
 * (`character`). A whitespace run between two other characters matches as a
 * text reader may leave it (`whitespaceRun`); one at either end matches as
 * written or not at all, as the reader trims it, unless trimming leaves the
 * value shorter than a secret may be.
 */
function valuePattern(value: string): Pattern {
  const trimmable = secretLength(value.trim()) >= MIN_SECRET_LENGTH;
  // `split` on a capturing pattern returns the whitespace runs at the odd indexes.
  const pieces = value.split(/(\s+)/);
  return concat(
    pieces.map((piece, index) => {
      const run = index % 2 === 1;
      if (run && pieces[index - 1] !== '' && pieces[index + 1] !== '') return whitespaceRun(piece);
      const written = concat([...piece].map(character));
      return run && trimmable ? { source: `(?:${written.source})?`, maxLength: written.maxLength } : written;
    }),
  );
}

/**
 * A whitespace run inside a value: one to as many whitespace characters as it
 * has, each any whitespace character or the spelling of a space or of one of
 * the run's own characters, so the run as written and the one space a reader
 * collapses it to (`normalizeText`) both match.
 */
function whitespaceRun(run: string): Pattern {
  const spelled = [...new Set([' ', ...run])].flatMap(spellings).filter((spelling) => !/^\s$/.test(spelling));
  const one = alternation([{ source: '\\s', maxLength: 1 }, ...distinct(spelled).map(exact)]);
  const count = [...run].length;
  return { source: `${one.source}{1,${count}}`, maxLength: one.maxLength * count };
}

/**
 * One character in every case form and every spelling of each. A spelling
 * the `i` flag already matches through another (`a` beside `A`, `é` beside
 * `É`) is left out, so no two alternatives match the same text: a near miss
 * then costs the pattern one try per alternative, not one per combination of
 * them across the value.
 */
function character(ch: string): Pattern {
  const forms = caseForms(ch);
  const single = forms.filter((form) => [...form].length === 1).flatMap(spellings);
  const expanded = forms
    .filter((form) => [...form].length > 1)
    .map((form) => concat([...form].map((part) => alternation(distinct(spellings(part)).map(exact)))));
  return alternation([...distinct(single).map(exact), ...expanded]);
}

/** `options` as one alternation, longest first, so a spelling is never cut short by one it starts with. */
function alternation(options: readonly Pattern[]): Pattern {
  if (options.length === 1) return options[0]!;
  const sorted = options.toSorted((a, b) => b.maxLength - a.maxLength);
  return {
    source: `(?:${sorted.map(({ source }) => source).join('|')})`,
    maxLength: sorted[0]?.maxLength ?? 0,
  };
}

/** `parts` one after another. */
function concat(parts: readonly Pattern[]): Pattern {
  return {
    source: parts.map(({ source }) => source).join(''),
    maxLength: parts.reduce((sum, { maxLength }) => sum + maxLength, 0),
  };
}

/** `text` matched literally. */
function exact(text: string): Pattern {
  return { source: literal(text), maxLength: text.length };
}

/** `texts` without the ones an earlier one matches under the `i` flag. */
function distinct(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((spelling) => {
    const key = folded(spelling);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `text` as the `i` flag compares it outside Unicode mode (ECMA-262
 * Canonicalize): each UTF-16 unit upper-cased, unless that takes more than
 * one unit or maps a non-ASCII unit into ASCII. Two literals match the same
 * text exactly when these agree.
 */
function folded(text: string): string {
  return text
    .split('')
    .map((unit) => {
      const upper = unit.toUpperCase();
      return upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
    })
    .join('');
}

/**
 * `text` with every character in one case, for comparing a cut or a fragment
 * of a value as whole-value matching does: each code point lower-cased from
 * its upper case, the Turkish lower case standing in where the default one
 * takes more units (`İ` as `i`), so `ſ`, `S`, and `s` agree, and so do `İ`
 * and `i`. A mapping that changes the length (`ß` as `SS`) is left out, so
 * an index into the result is one into `text`.
 */
function caseKey(text: string): string {
  if (!/[^\p{ASCII}]/u.test(text)) return text.toLowerCase();
  let out = '';
  for (const ch of text) out += ch.charCodeAt(0) < 128 ? ch.toLowerCase() : caseKeyOf(ch);
  return out;
}

/** A text as a cut or a fragment of a value is compared, and where each of its units starts in the text. */
interface ReadingKey {
  readonly key: string;
  /** The index in the text of each unit of `key`, then the text's length, so a stretch of `key` maps back to one of the text. */
  readonly at: readonly number[];
}

/**
 * `text` as a cut or a fragment of a value is compared: `caseKey`, with each
 * whitespace run read as one space, as an engine that collapses whitespace
 * (`normalizeText`) shows it before cutting. A value holding a line break, a
 * tab, a CRLF, a no-break space, or a run of spaces then agrees with what a
 * collapsed text keeps of it, and a stretch of the key maps back to the text
 * through `at`.
 */
function readingKey(text: string): ReadingKey {
  const cased = caseKey(text);
  let key = '';
  const at: number[] = [];
  let inRun = false;
  for (let index = 0; index < cased.length; index += 1) {
    const unit = cased.charAt(index);
    const space = WHITESPACE.test(unit);
    if (space && inRun) continue;
    inRun = space;
    key += space ? ' ' : unit;
    at.push(index);
  }
  at.push(text.length);
  return { key, at };
}

/** One UTF-16 unit of whitespace, as `normalizeText` collapses it. */
const WHITESPACE = /^\s$/u;

/** One non-ASCII character's `caseKey`, the same length as `ch`. */
function caseKeyOf(ch: string): string {
  const upper = sameLength(ch.toUpperCase(), ch);
  const lower = upper.toLowerCase();
  if (lower.length === ch.length) return lower;
  return sameLength(upper.toLocaleLowerCase('tr'), upper);
}

/** `mapped` when it is as long as `original`, else `original`. */
function sameLength(mapped: string, original: string): string {
  return mapped.length === original.length ? mapped : original;
}

/** Locales whose case mappings differ from the default: the dotted and dotless i of Turkish and Azeri, Lithuanian's retained dot. */
const CASE_LOCALES = ['tr', 'az', 'lt'];

/**
 * The strings one character can become when text is upper- or lower-cased:
 * the character itself, the full mappings, so `ß` is also `SS`, and the
 * locale-specific ones a `lang` attribute selects, so `i` is also `İ`. Each
 * form is spelled on its own, so a case variant's character reference or
 * escape is covered too.
 */
function caseForms(ch: string): string[] {
  return [
    ...new Set([
      ch,
      ch.toUpperCase(),
      ch.toLowerCase(),
      ...CASE_LOCALES.flatMap((locale) => [ch.toLocaleUpperCase(locale), ch.toLocaleLowerCase(locale)]),
    ]),
  ];
}

const NAMED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  '&': ['&amp;'],
  '<': ['&lt;'],
  '>': ['&gt;'],
  '"': ['&quot;'],
  "'": ['&apos;'],
};

/**
 * The spellings one character has in captured text: as is; as JSON writes
 * it, escaped the short way (`\"`), as `\uXXXX`, and `\/` for a slash, each
 * of those once more inside a quoted JSON string (a JSON request body inside
 * a HAR field); as an HTML character reference, named, decimal, zero-padded
 * decimal, or hex; and percent-encoded, with `+` for a space; and a double
 * quote doubled, as CSV writes it inside a quoted field. Hex digits are
 * spelled in lower case; the pattern's `i` flag matches them in upper too. A
 * letter or digit has one spelling: no serializer rewrites those.
 */
function spellings(ch: string): string[] {
  if (/^[A-Za-z0-9]$/.test(ch)) return [ch];
  const inJson = [JSON.stringify(ch).slice(1, -1), unicodeEscape(ch), ...(ch === '/' ? ['\\/'] : [])];
  const codePoint = ch.codePointAt(0) ?? 0;
  const decimal = String(codePoint);
  return [
    ...new Set([
      ch,
      ...inJson,
      ...inJson.map((form) => JSON.stringify(form).slice(1, -1)),
      ...(NAMED_REFERENCES[ch] ?? []),
      `&#${decimal};`,
      `&#${decimal.padStart(3, '0')};`,
      `&#x${codePoint.toString(16)};`,
      [...Buffer.from(ch, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
      ...(ch === ' ' ? ['+'] : []),
      ...(ch === '"' ? ['""'] : []),
    ]),
  ];
}

/** `\uXXXX` per UTF-16 code unit. */
function unicodeEscape(ch: string): string {
  const units = Array.from({ length: ch.length }, (_, index) => ch.charCodeAt(index));
  return units.map((unit) => `\\u${unit.toString(16).padStart(4, '0')}`).join('');
}

/** The length of the longest leading part of `value`, short of the whole and at least `minimum` long, that `text` ends with; 0 when it ends with none. */
function leadingPartAtEnd(text: string, value: string, minimum: number): number {
  for (let length = Math.min(text.length, value.length - 1); length >= minimum; length -= 1) {
    if (text.endsWith(value.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Every run of `FRAGMENT_LENGTH` characters of every value, mapped to the
 * index of the first value holding it; values come longest first, so a run
 * two values share names the longer one. The values come as `readingKey`
 * reads them, so a run in any case or with its whitespace collapsed finds
 * its owner.
 */
function fragmentOwners(values: readonly string[]): Map<string, number> {
  const owners = new Map<string, number>();
  values.forEach((value, index) => {
    for (let start = 0; start + FRAGMENT_LENGTH <= value.length; start += 1) {
      const run = value.slice(start, start + FRAGMENT_LENGTH);
      if (!owners.has(run)) owners.set(run, index);
    }
  });
  return owners;
}

/**
 * `text` with every stretch whose windows of `FRAGMENT_LENGTH` characters
 * each occur in a value replaced by the marker of the value owning its first
 * window. Windows are looked up by `readingKey`, as `owners` is keyed, so a
 * fragment in another case or with another whitespace run is one too, and
 * the stretch is cut back out of `text` whole, its whitespace runs included.
 * The stretch grows one window at a time, so the scan is linear in the text
 * and a run spanning two values becomes one marker.
 */
function rewriteFragments(text: string, owners: ReadonlyMap<string, number>, markers: readonly string[]): string {
  if (owners.size === 0) return text;
  const { key, at } = readingKey(text);
  let out = '';
  let kept = 0;
  let start = 0;
  while (start + FRAGMENT_LENGTH <= key.length) {
    const owner = owners.get(key.slice(start, start + FRAGMENT_LENGTH));
    if (owner === undefined) {
      start += 1;
      continue;
    }
    let end = start + FRAGMENT_LENGTH;
    while (end < key.length && owners.has(key.slice(end + 1 - FRAGMENT_LENGTH, end + 1))) end += 1;
    out += `${text.slice(kept, at[start])}${markers[owner] ?? ''}`;
    kept = at[end] ?? text.length;
    start = end;
  }
  return out + text.slice(kept);
}

/**
 * A run of base64 or base64url text long enough to encode a fragment: a
 * basic-auth header, a cookie, a token segment. Padding is part of the run.
 */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;

/**
 * `text` with every base64 run whose decoded text holds a value, whole or a
 * fragment, replaced by that value's marker. An encoder spreads a value's
 * bytes over the characters around it, so no plain-text spelling of the value
 * matches the run: the run is decoded and read the way `redactDecoded` reads
 * text, and it is rewritten whole, so no character of the value survives.
 */
function rewriteEncoded(text: string, redactDecoded: (text: string) => string, known: RegExp): string {
  return text
    .split(known)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(ENCODED_RUN, (run) => encodedMarker(run, redactDecoded, known) ?? run),
    )
    .join('');
}

/**
 * The marker of the first value `run` decodes to text holding. The run can
 * start with text the encoding does not (a URL path, a cookie prefix), so it
 * is decoded from each of the four offsets a base64 group can start at. A
 * marker the decoded text already holds is page text, not a value, so only
 * the text between such markers is read.
 */
function encodedMarker(run: string, redactDecoded: (text: string) => string, known: RegExp): string | undefined {
  const base64 = run.replaceAll('-', '+').replaceAll('_', '/');
  for (const offset of [0, 1, 2, 3]) {
    const pieces = Buffer.from(base64.slice(offset), 'base64').toString('utf8').split(known);
    for (const piece of pieces.filter((_, index) => index % 2 === 0)) {
      const marker = known.exec(redactDecoded(piece))?.[1];
      if (marker !== undefined) return marker;
    }
  }
  return undefined;
}

function literal(text: string): string {
  return [...text].map(escapeRegexpChar).join('');
}

/**
 * `cut`, moved back to the `<` of a marker the text before it cuts short:
 * `<`, `<s`, ... `<secret:` and name characters with no `>` yet. A stretch
 * as long as the longest known marker or longer cannot complete into one and
 * is left where it is, so the move stays under `maxMarkerLength`.
 */
function unfinishedMarkerBefore(text: string, cut: number, maxMarkerLength: number): number {
  const open = text.lastIndexOf('<', cut - 1);
  if (open === -1 || cut - open >= maxMarkerLength) return cut;
  const head = text.slice(open + 1, Math.min(cut, open + MARKER_OPEN.length));
  if (!MARKER_OPEN.startsWith(`<${head}`)) return cut;
  return MARKER_NAME.test(text.slice(open + MARKER_OPEN.length, cut)) ? open : cut;
}

/**
 * The attempt's registered secret values and their redactor, in one owner.
 *
 * Static credential passwords are known up front; a provider-backed value
 * exists only once the resolver produces it at fill time. Registration
 * invalidates the memoized redactor, so every consumer holding `redact` sees
 * a value the moment it exists — liveness is structural, not a comment on a
 * shared map.
 */
export class SecretLedger {
  /**
   * Every value ever registered, not just the newest per name: a rotating
   * secret (a fresh TOTP per fill) leaves its earlier codes on screen and in
   * captures, and an earlier value that stopped redacting would leak there.
   */
  private readonly values: [string, string][] = [];
  private compiled: Compiled | undefined;

  constructor(initial: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of initial) this.register(name, value);
  }

  /** Registers one resolved value; earlier values for the name keep redacting. */
  register(name: string, value: string): void {
    if (this.values.some(([n, v]) => n === name && v === value)) return;
    this.values.push([name, value]);
    this.compiled = undefined;
  }

  /** Bound so it can be handed out as a plain function. */
  readonly redact = (text: string): string => this.compile().redact(text);

  /** Every registered name and value, in registration order. */
  entries(): readonly (readonly [string, string])[] {
    return this.values.map(([name, value]) => [name, value] as const);
  }

  /**
   * `redact` for text cut short at a length limit, as an engine cuts an
   * observed name or text: a value the cut stopped partway through leaves
   * its leading part at the end, which no whole-value match sees, so the
   * longest such part becomes that value's marker too, down to
   * `FRAGMENT_LENGTH` characters, or half of a value shorter than twice that.
   * A cut is one position, so a boundary this short seldom matches plain text
   * by chance. Matched as the value is written, in any case (`caseKey`), as
   * a CSS `text-transform` shows it, and with every whitespace run on both
   * sides read as one space (`readingKey`) and the value's leading whitespace
   * dropped where whole-value matching trims it (`valuePattern`), as an
   * engine that collapses text before cutting it shows it: the cut falls on
   * text as the engine read it, before any serializer spells it. A case
   * mapping that changes length (`ß` to `SS`) is not followed. The part is found before whole values are
   * rewritten, so a value that starts with another registered value is not
   * half rewritten as the shorter one, and an occurrence running into the
   * part joins its marker. Bound like `redact`.
   */
  readonly redactCut = (text: string): string => this.compile().redactCut(text);

  /**
   * `redact` that also rewrites every fragment of a value: a run of at least
   * `FRAGMENT_LENGTH` consecutive characters of one, anywhere in the text,
   * becomes its marker. For a recording that keeps what an engine read raw
   * (a Playwright trace holds the page's cut text and selections), where a
   * value cut or selected partway through survives whole-value matching.
   * Matched in any case and with whitespace runs collapsed, like `redactCut`. A
   * base64 or base64url run that decodes to text holding a value or a
   * fragment is rewritten whole (a basic-auth header the engine sent). Bound
   * like `redact`.
   */
  readonly redactFragments = (text: string): string => this.compile().redactFragments(text);

  /** The most text one registered value can match in any spelling; a piece shorter than this holds at most part of one occurrence. */
  get maxFormLength(): number {
    return this.compile().maxFormLength;
  }

  /**
   * Whether any registered value, in any of its forms, occurs in `bytes`.
   * The check for content that is not text and so cannot be rewritten: what
   * holds a secret has to be withheld instead.
   */
  appearsIn(bytes: Uint8Array): boolean {
    const { pattern } = this.compile();
    if (pattern === undefined) return false;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8').search(pattern) !== -1;
  }

  /**
   * Where `text` must be held back while more may follow: the index from
   * which a later piece could complete an occurrence or a marker. That is the
   * last `maxFormLength - 1` characters, or only the unfinished last line when
   * no value spans lines; moved back over a marker cut short at that point
   * (`<`, `<s`, ... `<secret:` and name characters with no `>` yet) when
   * one shorter than the longest known marker could still complete into it,
   * so a marker split across pieces is never rewritten inside; then moved
   * back to the start of the one occurrence the redactor would rewrite across
   * that point, so each side redacts on its own to what the whole does. The
   * marker move comes first: the other way round it could land inside an
   * occurrence holding a `<`. Occurrences never overlap, so each move is
   * one and what is held stays under twice `maxFormLength` plus a marker.
   */
  holdFrom(text: string): number {
    const { pattern, spansLines, maxFormLength, maxMarkerLength } = this.compile();
    if (pattern === undefined) return text.length;
    let cut = Math.max(0, text.length - (maxFormLength - 1));
    if (!spansLines) cut = Math.max(cut, text.lastIndexOf('\n') + 1);
    cut = unfinishedMarkerBefore(text, cut, maxMarkerLength);
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null && match.index < cut; match = pattern.exec(text)) {
      if (match.index + match[0].length > cut) return match.index;
    }
    return cut;
  }

  private compile(): Compiled {
    this.compiled ??= compile(this.values);
    return this.compiled;
  }
}

/**
 * Redaction for text that arrives in pieces, as a stream writes it, so a
 * value split across two writes is still caught. Each `push` returns what is
 * safe to pass on and holds back the rest: the tail a later piece could
 * complete into a value or a `<secret:name>` marker, as the ledger measures
 * it. Bytes are decoded as UTF-8 with a character split across pieces kept
 * whole. `flush` releases what is held, redacted, when the stream ends. The
 * pieces together redact to exactly what the whole text would.
 */
export class StreamRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private held = '';

  constructor(private readonly ledger: SecretLedger) {}

  /** Redacts and returns what `chunk` completes; the rest waits for the next piece or `flush`. */
  push(chunk: string | Uint8Array): string {
    const text = this.held + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const cut = this.ledger.holdFrom(text);
    this.held = text.slice(cut);
    return this.ledger.redact(text.slice(0, cut));
  }

  /** Redacts and returns whatever is held, an unfinished character included; nothing more will follow. */
  flush(): string {
    const text = this.held + this.decoder.end();
    this.held = '';
    return this.ledger.redact(text);
  }
}
