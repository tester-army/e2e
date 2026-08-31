/** Runner-owned agent error classification (spec 02-test-api.md, 06-cli.md). */

import { classifyError, E2EError, type ErrorCategory } from '../internal/errors.ts';
import type { AgentErrorCode } from '../types.ts';

/**
 * Exit/result class per the representative mappings in 06-cli.md. The model
 * never selects a code and never selects a category. This table is the single
 * source of truth for the closed agent code set.
 */
export const CATEGORY_BY_CODE: Readonly<Record<AgentErrorCode, ErrorCategory>> = {
  AUTH_CREDENTIAL_UNAVAILABLE: 'configuration',
  MODEL_UNAVAILABLE: 'configuration',
  POLICY_DENIED: 'configuration',
  APP_UNREACHABLE: 'infrastructure',
  MODEL_PROVIDER_FAILED: 'infrastructure',
  CANCELLED: 'infrastructure',
  AUTHENTICATION_FAILED: 'test',
  MODEL_OUTPUT_INVALID: 'test',
  APP_NOT_OPEN: 'test',
  LOCATOR_NOT_FOUND: 'test',
  LOCATOR_AMBIGUOUS: 'test',
  ACTION_FAILED: 'test',
  CACHE_REPLAY_DIVERGED: 'test',
  STEP_BUDGET_EXHAUSTED: 'test',
  STEP_TIMEOUT: 'test',
  STEP_NO_CONCLUSION: 'test',
  ASSERTION_FAILED: 'test',
};

/** Cross-realm identity marker, mirroring `internal/errors.ts`. */
const AGENT_ERROR_MARKER = Symbol.for('e2e.agent-error.v1');

/**
 * Runner-classified agent failure (spec api/e2e.d.ts). It extends the internal
 * error base so category, exit code, retry eligibility, and report
 * serialization stay consistent with every other runner error.
 */
export class AgentError extends E2EError {
  readonly code: AgentErrorCode;
  readonly explanation: string;
  readonly screenshot?: string;
  /** True when this failure reports a blocked step, not a product failure. */
  readonly blocked: boolean;

  constructor(
    code: AgentErrorCode,
    explanation: string,
    options: { screenshot?: string; cause?: unknown; blocked?: boolean } = {},
  ) {
    super(CATEGORY_BY_CODE[code], code, explanation, options);
    this.name = new.target.name;
    Object.defineProperty(this, AGENT_ERROR_MARKER, { value: true });
    this.code = code;
    this.explanation = explanation;
    this.blocked = options.blocked === true;
    if (options.screenshot !== undefined) this.screenshot = options.screenshot;
  }
}

/** The closed agent code set, derived from the one classification table. */
const AGENT_CODES = new Set<string>(Object.keys(CATEGORY_BY_CODE));

/**
 * Maps any runner error raised inside an invocation onto the closed agent code
 * set. Model prose can never select a code.
 */
export function toAgentError(cause: unknown): AgentError {
  if (isAgentError(cause)) return cause;
  const classified = cause instanceof E2EError ? cause : classifyError(cause);
  if (AGENT_CODES.has(classified.code)) {
    return new AgentError(classified.code as AgentErrorCode, classified.message, { cause });
  }
  if (classified.code === 'UNSUPPORTED_CAPABILITY' || classified.code === 'INVALID_CONFIG') {
    return new AgentError('POLICY_DENIED', classified.message, { cause });
  }
  if (classified.category === 'infrastructure') {
    return new AgentError('APP_UNREACHABLE', classified.message, { cause });
  }
  return new AgentError('ACTION_FAILED', classified.message, { cause });
}

/**
 * True when a thrown value is an agent error from this or another realm.
 * Identity rides on a global symbol marker, not the class name, so subclasses
 * keep honest names and `instanceof` never spans realms.
 */
export function isAgentError(value: unknown): value is AgentError {
  return (
    value instanceof Error &&
    AGENT_ERROR_MARKER in value &&
    typeof (value as unknown as { code?: unknown }).code === 'string' &&
    (value as unknown as { code: string }).code in CATEGORY_BY_CODE
  );
}
