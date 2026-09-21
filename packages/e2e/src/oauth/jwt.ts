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
