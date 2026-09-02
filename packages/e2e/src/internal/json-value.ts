/**
 * The one JSON-safety walker. Anything crossing a boundary that demands plain
 * JSON — fixture evaluation arguments and results, `agent.act` params — validates
 * here, so cycle detection, plain-prototype checks, and secret rejection
 * cannot drift between call sites.
 */

import { isSecret } from '../locator/screen.ts';
import { ConfigurationError, TestError } from './errors.ts';

export interface JsonValueRules {
  /** Raised on a Secret value; the default denies with POLICY_DENIED. */
  readonly onSecret?: (label: string) => never;
  /** Maximum object/array nesting depth; unlimited when omitted. */
  readonly maxDepth?: number;
}

/** Validates that a value is JSON-safe, throwing a labeled TestError otherwise. */
export function validateJsonValue(value: unknown, label: string, rules: JsonValueRules = {}): void {
  if (value === undefined) return;
  const onSecret =
    rules.onSecret ??
    ((at: string): never => {
      throw new ConfigurationError('POLICY_DENIED', `${at} must not contain a Secret`);
    });
  // The ancestor path of the value being visited. Only an object that
  // contains itself is a cycle; the same object reachable twice by different
  // paths is an ordinary, serializable DAG.
  const ancestors = new Set<unknown>();
  const visit = (item: unknown, depth = 0): void => {
    if (rules.maxDepth !== undefined && depth > rules.maxDepth) {
      throw new TestError(
        'INVALID_ARGUMENT',
        `${label} exceeds ${rules.maxDepth} levels of nesting`,
      );
    }
    if (item === null) return;
    switch (typeof item) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(item)) {
          throw new TestError('INVALID_ARGUMENT', `${label} contains a non-finite number`);
        }
        return;
      case 'object': {
        if (isSecret(item)) {
          onSecret(label);
        }
        if (ancestors.has(item)) {
          throw new TestError('INVALID_ARGUMENT', `${label} contains a cycle`);
        }
        if (
          !Array.isArray(item) &&
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null
        ) {
          throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe`);
        }
        ancestors.add(item);
        const entries = Array.isArray(item) ? item : Object.values(item);
        for (const entry of entries) visit(entry, depth + 1);
        ancestors.delete(item);
        return;
      }
      default:
        throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe, found ${typeof item}`);
    }
  };
  visit(value);
}
