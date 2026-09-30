/** `config.email` validation: checked once, at config load. */

import { ConfigurationError } from '../internal/errors.ts';
import type { MailProvider } from './types.ts';

/** Narrows `config.email` to a provider, or names what it is missing. */
export function asMailProvider(value: unknown): MailProvider {
  const candidate = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof MailProvider, unknown>>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'email must be a mail provider with a non-empty name, such as maildev() from e2e');
  }
  for (const member of ['acquire', 'release', 'list', 'read'] as const) {
    if (typeof candidate[member] !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `email: mail provider "${candidate.name}" must implement ${member}()`);
    }
  }
  return value as MailProvider;
}
