/** Shared helpers for the conversation backend: error constructors and slugs. */

import { BackendError } from '@e2edev/e2e/backend';

export function invalidState(text: string): BackendError {
  return new BackendError('INVALID_STATE', text, { retryable: false });
}

export function notActionable(text: string): BackendError {
  return new BackendError('NOT_ACTIONABLE', text, { retryable: false });
}

export function unsupported(text: string): BackendError {
  return new BackendError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

export function failure(text: string, cause?: unknown): BackendError {
  return new BackendError('BACKEND_FAILURE', text, { retryable: false, ...(cause === undefined ? {} : { cause }) });
}

/** Lower-cased `[a-z0-9.-]` form of a name, for the path anchor. */
function slug(value: string): string {
  return (
    value
      .replaceAll(/[^A-Za-z0-9.-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .toLowerCase() || 'agent'
  );
}

/**
 * The location a conversation surface reports through `url`. A conversation
 * has no address bar, but the trace cache anchors every recorded step on a
 * path and refuses to write a trace for a surface without one, so the backend
 * mints one: `app://conversation/<agent>/<status>`. Two agents whose turn
 * both end `ready` must not share an anchor, so the agent identity is in the
 * path, not the host.
 */
export function conversationUrl(agent: string, status: string): string {
  return `app://conversation/${slug(agent)}/${status}`;
}
