/** PKCE (RFC 7636) verifier and S256 challenge, plus an opaque state, over Web Crypto. */

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');
}

export async function generatePkce(): Promise<Pkce> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** The payload of a JWT, or undefined when the token is not one. Signatures are not checked: the values only steer requests. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
