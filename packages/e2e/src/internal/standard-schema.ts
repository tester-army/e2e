/** Reading a caller's Standard Schema v1: the shape check and how an issue reads. */

import type { StandardSchemaV1 } from '../types.ts';
import { TestError } from './errors.ts';

/** Refuses anything that is not a Standard Schema v1 (Zod, Valibot, ArkType, ...), naming `label` in the error. */
export function requireStandardSchema(schema: unknown, label: string): asserts schema is StandardSchemaV1 {
  const props = (schema as StandardSchemaV1 | undefined)?.['~standard'];
  if (typeof props !== 'object' || props === null || props.version !== 1 || typeof props.validate !== 'function') {
    throw new TestError('INVALID_ARGUMENT', `${label} must implement Standard Schema v1`);
  }
}

/** One issue as `users.0.email: Invalid email`, or the bare message for an issue at the root. */
export function describeIssue(issue: StandardSchemaV1.Issue): string {
  const fieldPath = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
    .join('.');
  return fieldPath === '' ? issue.message : `${fieldPath}: ${issue.message}`;
}
