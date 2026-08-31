/**
 * The one JSON-safety walker. Anything crossing a boundary that demands plain
 * JSON — `web.evaluate` arguments and results, `agent.act` params — validates
 * here, so cycle detection, plain-prototype checks, and secret rejection
 * cannot drift between call sites.
 */

import { isSecret } from '../locator/screen.ts';
import { ConfigurationError, TestError } from './errors.ts';

export interface JsonValueRules {
  /** Raised on a Secret value; the default denies with POLICY_DENIED. */
  readonly onSecret?: (label: string) => never;
}

/** Validates that a value is JSON-safe, throwing a labeled TestError otherwise. */
export function validateJsonValue(value: unknown, label: string, rules: JsonValueRules = {}): void {
  if (value === undefined) return;
  const onSecret =
    rules.onSecret ??
    ((at: string): never => {
      throw new ConfigurationError('POLICY_DENIED', `${at} must not contain a Secret`);
    });
  const seen = new Set<unknown>();
  const visit = (item: unknown): void => {
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
        if (seen.has(item)) {
          throw new TestError('INVALID_ARGUMENT', `${label} contains a cycle`);
        }
        seen.add(item);
        if (Array.isArray(item)) {
          for (const entry of item) visit(entry);
          return;
        }
        if (
          Object.getPrototypeOf(item) !== Object.prototype &&
          Object.getPrototypeOf(item) !== null
        ) {
          throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe`);
        }
        for (const entry of Object.values(item)) visit(entry);
        return;
      }
      default:
        throw new TestError('INVALID_ARGUMENT', `${label} must be JSON-safe, found ${typeof item}`);
    }
  };
  visit(value);
}
