/** Runner-side secret redaction. */

import { escapeRegexpChar } from './regexp.ts';

/**
 * Builds a redactor replacing every registered secret value, in each spelling
 * the value takes in text the runner writes or rewrites, with its stable
 * secret name.
 *
 * Longer values are substituted first, so a secret that contains another
 * secret is not left half-rewritten.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  return compile([...secrets]).redact;
}

/** One value's matcher: `replace` rewrites every occurrence, `find` reports every start, overlapping ones included. */
interface Matcher {
  readonly marker: string;
  readonly replace: RegExp;
  readonly find: RegExp;
}

interface Compiled {
  readonly redact: (text: string) => string;
  readonly matchers: readonly Matcher[];
  /** The most text one value can match; a piece shorter than this holds at most part of one occurrence. */
  readonly maxFormLength: number;
  /** Whether a value contains a line break: the one spelling of a value an unfinished line cannot be cut from. */
  readonly spansLines: boolean;
}

/**
 * One matcher per non-empty value, longest value first. A value matches
 * character by character, each in any spelling a serializer gives it, so one
 * pattern covers a JSON body, a serialized page, a URL, and the raw value
 * alike, and a mixed or unusual spelling needs no form of its own.
 */
function compile(values: readonly (readonly [string, string])[]): Compiled {
  let maxFormLength = 0;
  let spansLines = false;
  const matchers = values
    .filter(([, value]) => value.length > 0)
    .toSorted((a, b) => b[1].length - a[1].length)
    .map(([name, value]): Matcher => {
      let source = '';
      let length = 0;
      for (const ch of value) {
        const options = spellings(ch);
        source += `(?:${options.map(literal).join('|')})`;
        length += Math.max(...options.map((option) => option.length));
      }
      maxFormLength = Math.max(maxFormLength, length);
      spansLines ||= value.includes('\n');
      return { marker: `<secret:${name}>`, replace: new RegExp(source, 'g'), find: new RegExp(`(?=(${source}))`, 'g') };
    });
  const redact =
    matchers.length === 0
      ? (text: string): string => text
      : (text: string): string => {
          let out = text;
          for (const { replace, marker } of matchers) out = out.replace(replace, () => marker);
          return out;
        };
  return { redact, matchers, maxFormLength, spansLines };
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
 * percent-encoded in either hex case, with `+` for a space. A letter or digit
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
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    return this.compile().matchers.some(({ replace }) => text.search(replace) !== -1);
  }

  /**
   * Where `text` must be held back while more may follow: the index from
   * which a later piece could complete an occurrence. That is the last
   * `maxFormLength - 1` characters, or only the unfinished last line when no
   * value spans lines, moved back over any occurrence the cut would split so
   * that each side redacts whole on its own.
   */
  holdFrom(text: string): number {
    const { matchers, spansLines } = this.compile();
    if (matchers.length === 0) return text.length;
    const reach = this.maxFormLength - 1;
    let cut = Math.max(0, text.length - reach);
    if (!spansLines) cut = Math.max(cut, text.lastIndexOf('\n') + 1);
    for (let moved = true; moved && cut > 0; ) {
      moved = false;
      const from = Math.max(0, cut - reach);
      const window = text.slice(from, Math.min(text.length, cut + reach));
      for (const { find } of matchers) {
        for (const match of window.matchAll(find)) {
          const start = from + match.index;
          if (start < cut && start + (match[1]?.length ?? 0) > cut) {
            cut = start;
            moved = true;
          }
        }
      }
    }
    return cut;
  }

  private compile(): Compiled {
    this.compiled ??= compile(this.values);
    return this.compiled;
  }
}

/**
 * Held text past which a stream stops waiting for a clean cut: occurrences
 * overlapping one another all the way back to the start (a value that repeats
 * its own prefix, written over and over) would otherwise hold everything.
 */
const MAX_HELD = 64 * 1024;

/**
 * Redaction for text that arrives in pieces, so a value split across two
 * writes is still caught. Each `push` returns what is safe to pass on and
 * holds back the rest: the tail a later piece could complete, as the ledger
 * measures it. `flush` releases the tail, redacted, when the stream ends.
 */
export class StreamRedactor {
  private held = '';

  constructor(private readonly ledger: SecretLedger) {}

  /** Redacts and returns what `chunk` completes; the rest waits for the next piece or `flush`. */
  push(chunk: string): string {
    const text = this.held + chunk;
    let cut = this.ledger.holdFrom(text);
    if (cut === 0 && text.length >= MAX_HELD) cut = text.length;
    this.held = text.slice(cut);
    return this.ledger.redact(text.slice(0, cut));
  }

  /** Redacts and returns whatever is held; nothing more will follow. */
  flush(): string {
    const text = this.held;
    this.held = '';
    return this.ledger.redact(text);
  }
}
