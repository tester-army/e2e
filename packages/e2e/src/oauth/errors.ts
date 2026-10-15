import { z } from 'zod';

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

/** The fields an error body names its failure with; a field of another type, or a body that is not an object, names nothing. */
const ErrorBodySchema = z
  .object({
    error: z.union([z.string(), z.object({ message: z.string() })]).optional().catch(undefined),
    error_description: z.string().optional().catch(undefined),
    message: z.string().optional().catch(undefined),
  })
  .catch({});

/** Reads an error body for a message without assuming JSON. */
export async function describeResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text === '') return `${response.status} ${response.statusText}`.trim();
  try {
    const { error, error_description, message } = ErrorBodySchema.parse(JSON.parse(text));
    const detail = error_description ?? (typeof error === 'object' ? error.message : undefined) ?? message ?? (typeof error === 'string' ? error : undefined);
    return detail === undefined ? `${response.status}: ${text.slice(0, 200)}` : `${response.status}: ${detail}`;
  } catch {
    return `${response.status}: ${text.slice(0, 200)}`;
  }
}

/** A response's or request's JSON body checked against `schema`; FLOW_FAILED as `<subject> is not JSON` or `<subject> <invalid>` otherwise. */
export async function readJsonBody<T>(source: Pick<Response, 'text'>, schema: z.ZodType<T>, subject: string, invalid = 'is malformed'): Promise<T> {
  const text = await source.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new OAuthError('FLOW_FAILED', `${subject} is not JSON`, { cause });
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new OAuthError('FLOW_FAILED', `${subject} ${invalid}`, { cause: result.error });
  return result.data;
}
