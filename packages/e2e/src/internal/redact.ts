/** Runner-side secret redaction. */

import { escapeRegexpChar } from './regexp.ts';

/**
 * Builds a redactor replacing every registered secret value, in each form the
 * value takes in text the runner writes or rewrites, with its stable secret
 * name.
 *
 * Longer forms are substituted first, so a secret that contains another secret
 * is not left half-rewritten. A marker is never read again once written: the
 * text is cut at the markers of the names the redactor knows, and each marker
 * it writes is frozen against the forms that follow, so redacting twice is
 * redacting once and a value that occurs inside a marker (`api` inside
 * `<secret:apiKey>`, the word `secret` itself) cannot rewrite it. Only known
 * names are cut out: a marker-shaped span of app text holding a raw value is
 * not a marker and is still redacted.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  const entries = secretForms(secrets);
  if (entries.length === 0) return (text) => text;
  const markers = markerPattern(entries.map(([name]) => name));
  return (text) => {
    let pieces = splitMarkers(text, markers);
    for (const [name, form] of entries) {
      const marker = `<secret:${name}>`;
      pieces = pieces.flatMap((piece) => (piece.frozen ? [piece] : replaceForm(piece.text, form, marker)));
    }
    return pieces.map((piece) => piece.text).join('');
  };
}

/** A run of text: still open to rewriting, or a marker that is final. */
interface Piece {
  readonly text: string;
  readonly frozen: boolean;
}

/** Matches the marker of any known name, captured so `split` keeps the markers. */
function markerPattern(names: readonly string[]): RegExp {
  const alternatives = [...new Set(names)].map((name) => [...name].map(escapeRegexpChar).join('')).join('|');
  return new RegExp(`(<secret:(?:${alternatives})>)`);
}

/** Cuts text at existing markers; `split` returns the captured markers at the odd indexes. */
function splitMarkers(text: string, markers: RegExp): Piece[] {
  return text.split(markers).map((part, index) => ({ text: part, frozen: index % 2 === 1 }));
}

/** Replaces every occurrence of one form with its marker, frozen against the forms that follow. */
function replaceForm(text: string, form: string, marker: string): Piece[] {
  const parts = text.split(form);
  if (parts.length === 1) return [{ text, frozen: false }];
  return parts.flatMap((part, index) =>
    index === 0 ? [{ text: part, frozen: false }] : [{ text: marker, frozen: true }, { text: part, frozen: false }],
  );
}

/** Every (name, form) pair the secrets take in text, longest form first; empty values contribute none. */
function secretForms(secrets: Iterable<readonly [string, string]>): (readonly [string, string])[] {
  return [...secrets]
    .filter(([, value]) => value.length > 0)
    .flatMap(([name, value]) => encodedForms(value).map((form) => [name, form] as const))
    .toSorted((a, b) => b[1].length - a[1].length);
}

/**
 * The forms one value takes in captured text: as is; as the body of a JSON
 * string (a trace records action parameters and DOM snapshots as JSON) and
 * of a JSON string quoted inside another (a JSON request body inside a HAR
 * field); HTML-escaped (a serialized page); and URL-encoded the three ways a
 * path, a query component, or a form body spell it. Forms the value does not
 * change under collapse into one.
 */
function encodedForms(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  return [
    ...new Set([
      value,
      json,
      JSON.stringify(json).slice(1, -1),
      escapeHtml(value),
      encodeURIComponent(value),
      encodeURI(value),
      new URLSearchParams([['v', value]]).toString().slice(2),
    ]),
  ];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  private compiled: { redact: (text: string) => string; forms: Buffer[] } | undefined;

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

  /**
   * Whether any registered value, in any of its forms, occurs in `bytes`.
   * The check for content that is not text and so cannot be rewritten: what
   * holds a secret has to be withheld instead.
   */
  appearsIn(bytes: Uint8Array): boolean {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.compile().forms.some((form) => buffer.includes(form));
  }

  private compile(): { redact: (text: string) => string; forms: Buffer[] } {
    this.compiled ??= {
      redact: createRedactor(this.values),
      forms: secretForms(this.values).map(([, form]) => Buffer.from(form, 'utf8')),
    };
    return this.compiled;
  }
}

/**
 * `redact` over every string leaf of a document, keys and structure intact:
 * the pass for a JSON document about to be written, where replacing across
 * the serialized text would let a secret that is JSON punctuation or a
 * property name corrupt what a reader parses. Follows `JSON.stringify`: own
 * enumerable properties, a value with `toJSON` replaced by what it
 * serializes to, binary views left for the serializer. The input is not
 * mutated. Typed as the input for documents that are already JSON.
 */
export function redactLeaves<T>(value: T, redact: (text: string) => string): T {
  return walk(value, redact) as T;
}

function walk(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, redact));
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return walk((toJSON as () => unknown).call(value), redact);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = walk(item, redact);
  return out;
}
