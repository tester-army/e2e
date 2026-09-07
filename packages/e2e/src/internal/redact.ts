/** Runner-side secret redaction. */

/**
 * Builds a redactor replacing every exact registered secret value with its
 * stable secret name.
 *
 * Longer values are substituted first, so a secret that contains another secret
 * is not left half-rewritten.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  const entries = [...secrets]
    .filter(([, value]) => value.length > 0)
    .toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`<secret:${name}>`);
    return out;
  };
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
  private redactor: ((text: string) => string) | undefined;

  constructor(initial: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of initial) this.register(name, value);
  }

  /** Registers one resolved value; earlier values for the name keep redacting. */
  register(name: string, value: string): void {
    if (this.values.some(([n, v]) => n === name && v === value)) return;
    this.values.push([name, value]);
    this.redactor = undefined;
  }

  /** Bound so it can be handed out as a plain function. */
  readonly redact = (text: string): string => {
    this.redactor ??= createRedactor(this.values);
    return this.redactor(text);
  };
}
