/** Runner-owned agent error classification (spec 02-test-api.md, 06-cli.md). */

import { E2EError, type ErrorCategory } from '../internal/errors.ts';
import type { AgentErrorCode } from '../types.ts';

/**
 * Exit/result class per the representative mappings in 06-cli.md. The model
 * never selects a code and never selects a category.
 */
const CATEGORY_BY_CODE: Readonly<Record<AgentErrorCode, ErrorCategory>> = {
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

/**
 * Runner-classified agent failure (spec api/e2e.d.ts). It extends the internal
 * error base so category, exit code, retry eligibility, and report
 * serialization stay consistent with every other runner error.
 */
export class AgentError extends E2EError {
  readonly code: AgentErrorCode;
  readonly explanation: string;
  readonly screenshot?: string;

  constructor(
    code: AgentErrorCode,
    explanation: string,
    options: { screenshot?: string; cause?: unknown } = {},
  ) {
    super(CATEGORY_BY_CODE[code], code, explanation, options);
    this.name = 'AgentError';
    this.code = code;
    this.explanation = explanation;
    if (options.screenshot !== undefined) this.screenshot = options.screenshot;
  }
}

/** True when a thrown value is an agent error from this or another realm. */
export function isAgentError(value: unknown): value is AgentError {
  return (
    value instanceof Error &&
    value.name === 'AgentError' &&
    typeof (value as unknown as { code?: unknown }).code === 'string' &&
    (value as unknown as { code: string }).code in CATEGORY_BY_CODE
  );
}
