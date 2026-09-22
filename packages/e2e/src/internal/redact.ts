/** Runner-side secret redaction. */

/**
 * Builds a redactor replacing every registered secret value, in each form the
 * value takes in text the runner writes or rewrites, with its stable secret
 * name.
 *
 * Longer forms are substituted first, so a secret that contains another secret
 * is not left half-rewritten.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  const entries = secretForms(secrets);
  if (entries.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`<secret:${name}>`);
    return out;
  };
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

  /** Whether no value is registered: nothing to rewrite, and nothing a capture could hold. */
  get isEmpty(): boolean {
    return this.values.length === 0;
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
