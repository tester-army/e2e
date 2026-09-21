/**
 * The run-unique value marker for `agent.act` params. A timestamped company
 * name or a fresh email is different on every run so the record it creates
 * never collides with the last run's; recorded verbatim, it would also defeat
 * the trace cache on every run. `unique()` names such a value: the model sees
 * the string as given, and the cache keys and records a slot in its place
 * (`cache/template.ts`).
 */

import { randomInt } from 'node:crypto';
import { uniqueBrand } from './internal/brands.ts';
import { TestError } from './internal/errors.ts';

/** A string param that differs on every run; the model sees `value`, the trace cache a slot. */
export interface Unique {
  readonly value: string;
  readonly [uniqueBrand]: true;
}

/** What a `unique` template may interpolate: text, a finite number, or an earlier `Unique`, spliced as its value. */
export type UniquePart = string | number | Unique;

/**
 * Marks a value that is different on every run. Mark values the flow types
 * or looks for, not choices that steer it: two runs whose `unique()` values
 * differ replay the same recording.
 *
 * As a template tag, `unique\`${stamp} Company\`` marks the derivation where
 * it is written, so a `stamp` spelled into several names is wrapped once
 * each instead of at every `act` call.
 */
export function unique(value: string): Unique;
export function unique(strings: TemplateStringsArray, ...parts: readonly UniquePart[]): Unique;
export function unique(value: string | TemplateStringsArray, ...parts: readonly UniquePart[]): Unique {
  const text = isTemplateStrings(value) ? interpolate(value, parts) : value;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TestError('INVALID_ARGUMENT', 'unique() takes a non-empty string');
  }
  if (text.includes('{{param:')) {
    throw new TestError('INVALID_ARGUMENT', 'a unique() value cannot contain the placeholder text "{{param:"');
  }
  return Object.freeze({ value: text, [uniqueBrand]: true as const });
}

export function isUnique(value: unknown): value is Unique {
  return typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[uniqueBrand] === true;
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as { raw?: unknown }).raw);
}

function interpolate(strings: TemplateStringsArray, parts: readonly UniquePart[]): string {
  let text = strings[0] ?? '';
  parts.forEach((part, index) => {
    text += partText(part) + (strings[index + 1] ?? '');
  });
  return text;
}

function partText(part: UniquePart): string {
  if (typeof part === 'string') return part;
  if (typeof part === 'number' && Number.isFinite(part)) return String(part);
  if (isUnique(part)) return part.value;
  throw new TestError('INVALID_ARGUMENT', 'a unique template interpolates strings, finite numbers, or unique() values');
}

const STAMP_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const STAMP_RANDOM_CHARS = 4;

/**
 * The `stamp` fixture's value: a run-and-test-unique string an attempt spells
 * into the names, keys, and addresses of the data it creates. `e2e` in front
 * marks the record as test data to whoever finds it later and keeps the
 * string from starting with a digit, so it is a valid identifier start too.
 * Lowercase letters and digits only, one segment: it survives a slug field
 * that lowercases, a URL path, a file name, a database key, and a
 * case-insensitive lookup unchanged, so a heading or a route that echoes the
 * name still matches it. The start millisecond in base36 orders records by
 * run; the random tail separates tests that start in the same millisecond
 * on different workers.
 */
export function createStamp(now = Date.now()): string {
  let tail = '';
  for (let index = 0; index < STAMP_RANDOM_CHARS; index += 1) {
    tail += STAMP_ALPHABET[randomInt(STAMP_ALPHABET.length)];
  }
  return `e2e${now.toString(36)}${tail}`;
}
