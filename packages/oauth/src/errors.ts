export type OAuthErrorCode =
  /** No stored credentials for the provider. */
  | 'NOT_LOGGED_IN'
  /** The refresh token was rejected; the user signs in again. */
  | 'LOGIN_REQUIRED'
  /** The authorization server or the vendor API answered with an error during a flow. */
  | 'FLOW_FAILED'
  /** The user or the caller cancelled the flow. */
  | 'CANCELLED'
  /** The flow ran out of time waiting for the user. */
  | 'TIMEOUT'
  /** The flow needs an option the caller did not give (a client id, a CLI). */
  | 'MISCONFIGURED';

export class OAuthError extends Error {
  override readonly name = 'OAuthError';
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Reads an error body for a message without assuming JSON. */
export async function describeResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text === '') return `${response.status} ${response.statusText}`.trim();
  try {
    const json = JSON.parse(text) as { error?: unknown; error_description?: unknown; message?: unknown };
    const error = json.error;
    const detail =
      typeof json.error_description === 'string'
        ? json.error_description
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : typeof json.message === 'string'
            ? json.message
            : typeof error === 'string'
              ? error
              : undefined;
    return detail === undefined ? `${response.status}: ${text.slice(0, 200)}` : `${response.status}: ${detail}`;
  } catch {
    return `${response.status}: ${text.slice(0, 200)}`;
  }
}
