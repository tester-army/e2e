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
