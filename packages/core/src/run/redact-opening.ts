/** The one way an error leaves a host's opening: classified, redacted, and stripped of its cause. */

import { classifyError, ConfigurationError, E2EError, serializeError } from '../internal/errors.ts';
import { processSecrets } from './secrecy.ts';

/** Opening errors go straight to the caller (another test runner, an `e2e-core` program), never through a report writer. */
export async function redactOpening<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (cause) {
    const classified = classifyError(cause);
    const safe = serializeError(classified, { redact: processSecrets.redact });
    // Arbitrary engine causes can carry non-text secret data; only the sanitized record crosses out.
    const error = safe.category === 'configuration'
      ? new ConfigurationError(safe.code, safe.message, safe.details === undefined ? {} : { details: safe.details })
      : new E2EError(safe.category, safe.code, safe.message, {
        retryable: safe.retryable, ...(safe.details === undefined ? {} : { details: safe.details }),
      });
    error.name = processSecrets.redact(classified.name);
    if (safe.stack !== undefined) error.stack = safe.stack;
    throw error;
  }
}

