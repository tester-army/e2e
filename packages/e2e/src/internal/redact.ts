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
  /** Every occurrence of every value, leftmost first and never overlapping: the matches `redact` rewrites. Absent with no values. */
  readonly pattern: RegExp | undefined;
  /** The most text one occurrence can span; a piece shorter than this holds at most part of one. */
  readonly maxFormLength: number;
  /** The longest marker of a known name; a marker cut short at that length or beyond cannot complete into one. */
  readonly maxMarkerLength: number;
  /** Whether a value contains a line break: the one case an unfinished line cannot be cut from the line before it. */
  readonly spansLines: boolean;
}

const MARKER_OPEN = '<secret:';
/** What a secret name spells inside its marker; a `>` closes it. */
const MARKER_NAME = /^[A-Za-z0-9_.-]*$/;

/**
 * One pattern over every non-empty value, longest value first. A value
 * matches character by character, each in any case and in any spelling a
 * serializer gives it, so one pattern covers a JSON body, a serialized page, a
 * URL, the raw value, and the value as a text reader or a CSS `text-transform`
 * shows it alike, and a mixed or unusual spelling needs no form of its own.
 * The `i` flag folds what the per-character case forms leave out: a sigma
 * lower-cased at the end of a word, a titlecase digraph.
 */
function compile(values: readonly (readonly [string, string])[]): Compiled {
  const entries = values.filter(([, value]) => value.length > 0).toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) {
    return { redact: (text) => text, pattern: undefined, maxFormLength: 0, maxMarkerLength: 0, spansLines: false };
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
  return {
    // `split` on a capturing pattern returns the markers at the odd indexes; those pass through untouched.
    redact: (text) => text.split(known).map((piece, index) => (index % 2 === 1 ? piece : rewrite(piece))).join(''),
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
 * of it can span. A whitespace run inside the value also matches the one
 * character a reader collapses it to (`normalizeText`), and a value with
 * whitespace at either end also matches trimmed, as the reader trims it,
 * unless trimming leaves it shorter than a secret may be.
 */
function valuePattern(value: string): Pattern {
  const whole = runsPattern(value);
  const trimmed = value.trim();
  if (trimmed === value || secretLength(trimmed) < MIN_SECRET_LENGTH) return whole;
  return { source: `${whole.source}|${runsPattern(trimmed).source}`, maxLength: whole.maxLength };
}

/** `text` character by character, each whitespace run between two other characters matching as `whitespaceRun` reads it. */
function runsPattern(text: string): Pattern {
  const pieces = text.split(/(\s+)/);
  let source = '';
  let maxLength = 0;
  pieces.forEach((piece, index) => {
    const inner = index % 2 === 1 && pieces[index - 1] !== '' && pieces[index + 1] !== '';
    const part = inner ? whitespaceRun(piece) : sequence(piece);
    source += part.source;
    maxLength += part.maxLength;
  });
  return { source, maxLength };
}

/**
 * A whitespace run: as written, or as the one character normalization leaves
 * of it, a space in any of its spellings or any other whitespace character.
 */
function whitespaceRun(run: string): Pattern {
  const written = sequence(run);
  const space = spellings(' ');
  return {
    source: `(?:${written.source}|${space.map(literal).join('|')}|\\s)`,
    maxLength: Math.max(written.maxLength, space[0]?.length ?? 1),
  };
}

/** `text` character by character, each in every case form and spelling. */
function sequence(text: string): Pattern {
  let source = '';
  let maxLength = 0;
  for (const ch of text) {
    const forms = caseForms(ch).map((form) => {
      const options = [...form].map(spellings);
      return {
        source: options.map((option) => `(?:${option.map(literal).join('|')})`).join(''),
        maxLength: options.reduce((sum, option) => sum + (option[0]?.length ?? 1), 0),
      };
    });
    source += forms.length === 1 ? forms[0]!.source : `(?:${forms.map((form) => form.source).join('|')})`;
    maxLength += Math.max(...forms.map((form) => form.maxLength));
  }
  return { source, maxLength };
}

/** Locales whose case mappings differ from the default: the dotted and dotless i of Turkish and Azeri, Lithuanian's retained dot. */
const CASE_LOCALES = ['tr', 'az', 'lt'];

/**
 * The strings one character can become when text is upper- or lower-cased,
 * longest first: the character itself, the full mappings, so `ß` is also
 * `SS`, and the locale-specific ones a `lang` attribute selects, so `i` is
 * also `İ`. Each form is spelled on its own, so a case variant's character
 * reference or escape is covered too.
 */
function caseForms(ch: string): string[] {
  return [
    ...new Set([
      ch,
      ch.toUpperCase(),
      ch.toLowerCase(),
      ...CASE_LOCALES.flatMap((locale) => [ch.toLocaleUpperCase(locale), ch.toLocaleLowerCase(locale)]),
    ]),
  ].toSorted((a, b) => b.length - a.length);
}

const NAMED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  '&': ['&amp;'],
  '<': ['&lt;'],
  '>': ['&gt;'],
  '"': ['&quot;'],
  "'": ['&apos;'],
};

/**
 * The spellings one character has in captured text, longest first: as is; as
 * JSON writes it, escaped the short way (`\"`), as `\uXXXX` in either hex
 * case, and `\/` for a slash, each of those once more inside a quoted JSON
 * string (a JSON request body inside a HAR field); as an HTML character
 * reference, named, decimal, zero-padded decimal, or hex in either case; and
 * percent-encoded in either hex case, with `+` for a space; and a double
 * quote doubled, as CSV writes it inside a quoted field. A letter or digit
 * has one spelling: no serializer rewrites those.
 */
function spellings(ch: string): string[] {
  if (/^[A-Za-z0-9]$/.test(ch)) return [ch];
  const inJson = [JSON.stringify(ch).slice(1, -1), ...unicodeEscapes(ch), ...(ch === '/' ? ['\\/'] : [])];
  const codePoint = ch.codePointAt(0) ?? 0;
  const decimal = String(codePoint);
  const hex = codePoint.toString(16);
  const percent = (digits: (byte: number) => string): string =>
    [...Buffer.from(ch, 'utf8')].map((byte) => `%${digits(byte)}`).join('');
  return [
    ...new Set([
      ch,
      ...inJson,
      ...inJson.map((form) => JSON.stringify(form).slice(1, -1)),
      ...(NAMED_REFERENCES[ch] ?? []),
      `&#${decimal};`,
      `&#${decimal.padStart(3, '0')};`,
      `&#x${hex};`,
      `&#x${hex.toUpperCase()};`,
      percent((byte) => byte.toString(16).padStart(2, '0')),
      percent((byte) => byte.toString(16).padStart(2, '0').toUpperCase()),
      ...(ch === ' ' ? ['+'] : []),
      ...(ch === '"' ? ['""'] : []),
    ]),
  ].toSorted((a, b) => b.length - a.length);
}

/** `\uXXXX` per UTF-16 code unit, hex digits in lower case and in upper. */
function unicodeEscapes(ch: string): string[] {
  const escape = (digits: (unit: number) => string): string =>
    Array.from({ length: ch.length }, (_, index) => `\\u${digits(ch.charCodeAt(index))}`).join('');
  const hex4 = (unit: number): string => unit.toString(16).padStart(4, '0');
  return [escape(hex4), escape((unit) => hex4(unit).toUpperCase())];
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
