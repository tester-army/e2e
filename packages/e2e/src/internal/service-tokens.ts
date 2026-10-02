/**
 * The text of a service address placeholder: what `svc.url` and `svc.port`
 * read as, and how the config resolution and the navigation guard find one
 * in a string. Also the names a placeholder may hold and the keys a worker's
 * bootstrap carries the assigned ports under.
 */

/** ASCII letters, digits, `_`, and `-`: a service name that reads unambiguously inside a placeholder. */
export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A port name is a lowercase URL scheme, so `svc.urlOf('smtp')` reads `smtp://host:port`. */
export const PORT_NAME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/**
 * One placeholder: `{service:<name>.url}`, `{service:<name>.port}`, or either
 * with `:<port name>`. The name also admits `app:<target>`, the process a
 * target's `app.command` is, which no `defineService` name can spell.
 * Deterministic, so a worker re-evaluating the config reads the same digest,
 * and made of characters no URL host accepts, so an unresolved one cannot
 * pass for an address.
 */
const TOKEN_PATTERN = /\{service:([A-Za-z0-9_.:-]+?)\.(url|port)(?::([a-z][a-z0-9+.-]*))?\}/g;

/** One placeholder a string holds, parsed. */
export interface ServiceToken {
  readonly token: string;
  readonly service: string;
  readonly kind: 'url' | 'port';
  /** The named port it reads; undefined for the primary address. */
  readonly port: string | undefined;
}

/** The placeholder text for one address of `service`. */
export function tokenOf(service: string, kind: 'url' | 'port', port?: string): string {
  return `{service:${service}.${kind}${port === undefined ? '' : `:${port}`}}`;
}

/** Every placeholder `value` holds, in order. */
export function serviceTokens(value: string): readonly ServiceToken[] {
  return [...value.matchAll(TOKEN_PATTERN)].map((match) => ({
    token: match[0],
    service: match[1]!,
    kind: match[2] as 'url' | 'port',
    port: match[3],
  }));
}

/** `value` with every placeholder replaced by what `resolve` returns for it. */
export function replaceServiceTokens(value: string, resolve: (token: ServiceToken) => string): string {
  return value.replace(TOKEN_PATTERN, (token: string, service: string, kind: 'url' | 'port', port: string | undefined) =>
    resolve({ token, service, kind, port }),
  );
}

/**
 * Where a worker's bootstrap carries one assigned port: `service:<name>` for
 * a service's primary port, `service:<name>/<port>` for a named one. `/`
 * appears in no service, target, or port name, so no two keys collide.
 */
export function portKey(service: string, port: string | undefined): string {
  return port === undefined ? `service:${service}` : `service:${service}/${port}`;
}
