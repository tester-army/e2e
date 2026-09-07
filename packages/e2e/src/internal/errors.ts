/** Runner-owned error taxonomy and exit-code mapping. */

import {
  ENGINE_ERROR_CODES,
  EngineError,
  RETRYABLE_ENGINE_ERROR_CODES,
  type EngineErrorCode,
} from '../engine/contract.ts';

/** Message of an arbitrary thrown value, for diagnostics that must not throw. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export type ErrorCategory =
  | 'test'
  | 'configuration'
  | 'infrastructure'
  | 'internal'
  | 'interrupted';

export type ErrorPhase =
  | 'config'
  | 'collection'
  | 'launch'
  | 'beforeAll'
  | 'beforeEach'
  | 'body'
  | 'afterEach'
  | 'afterAll'
  | 'cleanup'
  | 'report';

export interface SerializedError {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  phase?: ErrorPhase;
  scopeId?: string;
  stack?: string;
}

/** Marks classified errors so instances survive isolated module realms. */
const E2E_ERROR_MARKER = Symbol.for('e2e.error.v1');

/**
 * Normalizes an engine failure, including one thrown by another copy of the
 * engine module.
 *
 * An engine imported by a config file is loaded through a different module
 * registry than the runner, so its `EngineError` is a different class and
 * `instanceof` misses it. Detection is therefore structural, keyed on the
 * closed code set: without this, every out-of-tree engine's typed failures
 * silently degrade to a generic error and lose their taxonomy. A foreign
 * instance is held to the same retryability rule as the local class.
 */
export function asEngineError(
  value: unknown,
): { code: EngineErrorCode; message: string; retryable: boolean } | undefined {
  if (value instanceof EngineError) return value;
  if (!(value instanceof Error) || value.name !== 'EngineError') return undefined;
  const code = (value as unknown as { code?: unknown }).code;
  if (!isEngineErrorCode(code)) return undefined;
  const retryable = (value as unknown as { retryable?: unknown }).retryable === true;
  if (retryable && !RETRYABLE_ENGINE_ERROR_CODES.has(code)) {
    return { code: 'ENGINE_FAILURE', message: value.message, retryable: false };
  }
  return { code, message: value.message, retryable };
}

function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === 'string' && (ENGINE_ERROR_CODES as readonly string[]).includes(value);
}

/** Base class for every runner-classified error. */
export class E2EError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly [E2E_ERROR_MARKER] = true;

  constructor(
    category: ErrorCategory,
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'E2EError';
    this.category = category;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

const CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'test',
  'configuration',
  'infrastructure',
  'internal',
  'interrupted',
]);

/** Detects an E2EError created by another copy of this module. */
export function isForeignE2EError(value: unknown): value is Error & {
  category: ErrorCategory;
  code: string;
  retryable: boolean;
} {
  return (
    value instanceof Error &&
    (value as unknown as Record<PropertyKey, unknown>)[E2E_ERROR_MARKER] === true &&
    CATEGORIES.has((value as { category?: ErrorCategory }).category as ErrorCategory) &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export class ConfigurationError extends E2EError {
  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super('configuration', code, message, options);
    this.name = 'ConfigurationError';
  }
}

export class CollectionError extends ConfigurationError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('COLLECTION_ERROR', message, options);
    this.name = 'CollectionError';
  }
}

export class InfrastructureError extends E2EError {
  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super('infrastructure', code, message, options);
    this.name = 'InfrastructureError';
  }
}

export class TestError extends E2EError {
  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super('test', code, message, options);
    this.name = 'TestError';
  }
}

export class TestTimeoutError extends TestError {
  constructor(message: string) {
    super('TEST_TIMEOUT', message);
    this.name = 'TestTimeoutError';
  }
}

/** Maps a category to its process exit code. */
export function exitCodeForCategory(category: ErrorCategory): 0 | 1 | 2 | 3 | 4 | 130 {
  switch (category) {
    case 'test':
      return 1;
    case 'configuration':
      return 2;
    case 'infrastructure':
      return 3;
    case 'internal':
      return 4;
    case 'interrupted':
      return 130;
  }
}

/** Combines exit codes for mixed outcomes using precedence 130 > 4 > 3 > 2 > 1 > 0. */
export function combineExitCodes(codes: readonly number[]): 0 | 1 | 2 | 3 | 4 | 130 {
  const precedence: readonly (0 | 1 | 2 | 3 | 4 | 130)[] = [130, 4, 3, 2, 1, 0];
  for (const candidate of precedence) {
    if (codes.includes(candidate)) return candidate;
  }
  return 0;
}

/**
 * Canonical EngineError -> runner taxonomy mapping.
 * Applies to every engine surface: lifecycle, app, screen, artifacts,
 * state capture/restore, and observation. Non-EngineError causes become
 * non-retryable infrastructure ENGINE_FAILURE.
 */
export function translateEngineError(cause: unknown, suffix = ''): E2EError {
  if (cause instanceof E2EError) return cause;
  const engineError = asEngineError(cause);
  if (engineError !== undefined) {
    switch (engineError.code) {
      case 'NODE_STALE':
        return new TestError('LOCATOR_NOT_FOUND', `node became stale${suffix}`, { cause });
      case 'FRAME_NOT_FOUND':
        return new TestError('LOCATOR_NOT_FOUND', `${engineError.message}${suffix}`, { cause });
      case 'FRAME_AMBIGUOUS':
        return new TestError('LOCATOR_AMBIGUOUS', `${engineError.message}${suffix}`, { cause });
      case 'NOT_ACTIONABLE':
        return new TestError('ACTION_FAILED', `${engineError.message}${suffix}`, { cause });
      case 'ACTION_MAY_HAVE_COMMITTED':
        return new TestError('ACTION_FAILED', `${engineError.message}${suffix}`, { cause });
      case 'OPERATION_TIMEOUT':
        return new TestError('ACTION_FAILED', `operation timed out${suffix}`, { cause });
      case 'CANCELLED':
        return new E2EError('infrastructure', 'CANCELLED', 'operation cancelled', { cause });
      case 'UNSUPPORTED_CAPABILITY':
        return new E2EError('configuration', 'UNSUPPORTED_CAPABILITY', engineError.message, { cause });
      case 'INVALID_STATE':
        return new TestError('APP_NOT_OPEN', engineError.message, { cause });
      case 'ENGINE_FAILURE':
        return new E2EError('infrastructure', 'ENGINE_FAILURE', engineError.message, { cause });
    }
  }
  return new E2EError('infrastructure', 'ENGINE_FAILURE', errorMessage(cause), { cause });
}

/**
 * Classifies a failure of an engine's `prepare` hook. Provisioning runs before
 * any test exists, so nothing thrown there can be a test failure: a harness-
 * classified error keeps the category its author chose (a `ConfigurationError`
 * for an option the engine cannot honour), an engine cancellation stays a
 * cancellation, and everything else - an `EngineError` of any code, a plain
 * `Error` from an installer - is infrastructure.
 */
export function translateProvisioningError(cause: unknown, suffix = ''): E2EError {
  if (cause instanceof E2EError || isForeignE2EError(cause)) return classifyError(cause);
  if (asEngineError(cause)?.code === 'CANCELLED') return translateEngineError(cause);
  return new InfrastructureError('ENGINE_FAILURE', `${errorMessage(cause)}${suffix}`, { cause });
}

/** Classifies an arbitrary thrown value into an E2EError; unknown values become test failures. */
export function classifyError(value: unknown): E2EError {
  if (value instanceof E2EError) return value;
  if (isForeignE2EError(value)) {
    return new E2EError(value.category, value.code, value.message, {
      retryable: value.retryable,
      cause: value,
    });
  }
  if (asEngineError(value) !== undefined) {
    return translateEngineError(value);
  }
  if (value instanceof Error) {
    return new TestError('ERROR', value.message, { cause: value });
  }
  return new TestError('ERROR', String(value));
}

const MAX_MESSAGE_BYTES = 8192;

/** Serializes an error into the bounded report-1 error shape. */
export function serializeError(
  error: E2EError,
  extras: { phase?: ErrorPhase; scopeId?: string } = {},
): SerializedError {
  const serialized: SerializedError = {
    category: error.category,
    code: error.code,
    message: truncateUtf8(sanitizeText(error.message), MAX_MESSAGE_BYTES),
    retryable: error.retryable,
  };
  if (extras.phase !== undefined) serialized.phase = extras.phase;
  if (extras.scopeId !== undefined) serialized.scopeId = extras.scopeId;
  const stack = (error.cause instanceof Error ? error.cause.stack : undefined) ?? error.stack;
  if (stack !== undefined) serialized.stack = truncateUtf8(sanitizeText(stack), 65536);
  return serialized;
}

/** C0/C1 control characters except tab and newline. */
// oxlint-disable-next-line no-control-regex -- the control range is the point
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Strips C0/C1 control characters except tab and newline. */
export function sanitizeText(text: string): string {
  return text.replace(CONTROL_PATTERN, '\uFFFD');
}

/** Truncates a string so its UTF-8 encoding fits maxBytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = UTF8.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Back up off any UTF-8 continuation bytes (10xxxxxx) so the cut lands on a
  // code point boundary; the lead byte at the cut is excluded with its tail.
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return UTF8_DECODER.decode(bytes.subarray(0, end));
}
