/** Comma-separated flag values, shared by the commands that take them. */

import { InvalidArgumentError } from 'commander';

/** The non-empty items of a comma-separated value, trimmed. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Names, comma-separated or repeated, each once. An empty value is a usage
 * error rather than an empty list: `--tag "$TAGS"` with the variable unset
 * must not select every test, and `--target ''` must not select every target.
 */
export function parseNames(noun: string): (value: string, previous?: string[]) => string[] {
  return (value, previous = []) => {
    const names = parseList(value);
    if (names.length === 0) throw new InvalidArgumentError(`must name at least one ${noun}`);
    return [...new Set([...previous, ...names])];
  };
}
