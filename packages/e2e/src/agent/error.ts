/** Runner-owned agent error classification (spec 02-test-api.md, 06-cli.md). */

import { classifyError, E2EError, type ErrorCategory } from '../internal/errors.ts';
import type { AgentErrorCode } from '../types.ts';

/**
 * What a `blocked` verdict names as the obstacle. Mirrors the platform's
 * categories exactly: the first four have external owners (fix the
 * credential, the environment, the seed data, the setup); `automation` means
 * the agent itself ran out of room and says nothing about the product.
 */
export type BlockedCategory =
  | 'credentials'
  | 'environment'
  | 'seed_data'
  | 'test_setup'
  | 'automation';

/**
 * The single source of truth for the closed agent code set: exit/result class
 * per 06-cli.md, plus the blocked category for codes a `blocked` verdict may
 * carry. The model never selects a code, a category, or a blocked category —
 * everything derives from this table.
 */
export const AGENT_CODE_TABLE: Readonly<
  Record<AgentErrorCode, { category: ErrorCategory; blockedCategory?: BlockedCategory }>
> = {
  AUTH_CREDENTIAL_UNAVAILABLE: { category: 'configuration', blockedCategory: 'credentials' },
  AUTH_CREDENTIAL_INVALID: { category: 'configuration', blockedCategory: 'credentials' },
  ENVIRONMENT_UNAVAILABLE: { category: 'infrastructure', blockedCategory: 'environment' },
  APP_UNREACHABLE: { category: 'infrastructure', blockedCategory: 'environment' },
  APP_ALREADY_RUNNING: { category: 'infrastructure', blockedCategory: 'environment' },
  SEED_DATA_MISSING: { category: 'configuration', blockedCategory: 'seed_data' },
  TEST_SETUP_FAILED: { category: 'configuration', blockedCategory: 'test_setup' },
  APP_NOT_OPEN: { category: 'test', blockedCategory: 'test_setup' },
  POLICY_DENIED: { category: 'configuration', blockedCategory: 'test_setup' },
  MODEL_UNAVAILABLE: { category: 'configuration', blockedCategory: 'automation' },
  AUTOMATION_UNSUPPORTED: { category: 'test', blockedCategory: 'automation' },
  STEP_BUDGET_EXHAUSTED: { category: 'test', blockedCategory: 'automation' },
  STEP_TIMEOUT: { category: 'test', blockedCategory: 'automation' },
  MODEL_PROVIDER_FAILED: { category: 'infrastructure' },
  CANCELLED: { category: 'infrastructure' },
  AUTHENTICATION_FAILED: { category: 'test' },
  MODEL_OUTPUT_INVALID: { category: 'test' },
  LOCATOR_NOT_FOUND: { category: 'test' },
  LOCATOR_AMBIGUOUS: { category: 'test' },
  ACTION_FAILED: { category: 'test' },
  STEP_NO_CONCLUSION: { category: 'test' },
  ASSERTION_FAILED: { category: 'test' },
};

/** Exit/result class per code; derived from the one table. */
export const CATEGORY_BY_CODE: Readonly<Record<AgentErrorCode, ErrorCategory>> =
  Object.fromEntries(
    Object.entries(AGENT_CODE_TABLE).map(([code, entry]) => [code, entry.category]),
  ) as Record<AgentErrorCode, ErrorCategory>;

/** The blocked category a code names, or undefined when it is not blockable. */
export function blockedCategoryOf(code: AgentErrorCode): BlockedCategory | undefined {
  return AGENT_CODE_TABLE[code]?.blockedCategory;
}

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
