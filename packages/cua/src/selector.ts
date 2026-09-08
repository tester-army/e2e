/**
 * The platform selector for the `selector` locator expression:
 * `screen.locator('role=AXButton label="Save"')`, `desktop.locator('id=SaveButton')`,
 * and the structural hint on every observed node. Terms are `key=value`
 * pairs separated by whitespace; a value with spaces, quotes, or `=` is
 * JSON-quoted. Matching runs against the projected snapshot, one immediate
 * pass, every match returned; a term's text compares exactly after
 * whitespace collapsing, like every other text rule in the runner.
 */

import { EngineError } from '@e2edev/e2e/engine';
import { normalizeKind, type ProjectedNode } from './nodes.ts';

interface Term {
  readonly key: string;
  readonly value: string;
}

export type CompiledSelector = (entries: readonly ProjectedNode[]) => ProjectedNode[];

const TERM_KEYS = new Set(['id', 'role', 'label', 'text', 'value', 'token', 'index', 'enabled', 'selected', 'focused', 'checked']);
const TERM_PATTERN = /\s*([A-Za-z]+)=("(?:[^"\\]|\\.)*"|[^\s"]+)/y;

function invalid(raw: string, detail: string): EngineError {
  return new EngineError('ENGINE_FAILURE', `invalid selector ${JSON.stringify(raw)}: ${detail}`, { retryable: false });
}

/** Parses `key=value key="quoted value"` into terms; throws `ENGINE_FAILURE` for anything else. */
export function parseSelector(raw: string): readonly Term[] {
  const terms: Term[] = [];
  TERM_PATTERN.lastIndex = 0;
  let consumed = 0;
  for (;;) {
    const rest = raw.slice(consumed);
    if (rest.trim() === '') break;
    TERM_PATTERN.lastIndex = 0;
    const match = TERM_PATTERN.exec(rest);
    if (match === null) throw invalid(raw, `expected key=value near ${JSON.stringify(rest.trim().slice(0, 24))}`);
    const key = (match[1] as string).toLowerCase();
    if (!TERM_KEYS.has(key)) throw invalid(raw, `unknown term "${key}"; expected one of ${[...TERM_KEYS].join(', ')}`);
    const quoted = match[2] as string;
    let value: string;
    if (quoted.startsWith('"')) {
      try {
        value = JSON.parse(quoted) as string;
      } catch {
        throw invalid(raw, `unbalanced quotes in ${quoted}`);
      }
    } else {
      value = quoted;
    }
    terms.push({ key, value });
    consumed += match[0].length;
  }
  if (terms.length === 0) throw invalid(raw, 'a selector needs at least one key=value term');
  return terms;
}

export function compileSelector(raw: string): CompiledSelector {
  const terms = parseSelector(raw);
  return (entries) => entries.filter((entry) => terms.every((term) => matchesTerm(entry, term)));
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function textEquals(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && normalize(actual) === normalize(expected);
}

function flag(value: string): boolean {
  return value.toLowerCase() === 'true' || value === '1';
}

function matchesTerm(entry: ProjectedNode, term: Term): boolean {
  const states = entry.node.states ?? {};
  switch (term.key) {
    case 'id':
      return textEquals(entry.raw.identifier ?? entry.raw.automation_id, term.value);
    case 'role': {
      const wanted = normalizeKind(term.value);
      return entry.kind === wanted || entry.node.role === wanted;
    }
    case 'label':
      return textEquals(entry.node.name, term.value);
    case 'text':
      return textEquals(entry.node.name, term.value) || textEquals(entry.node.value, term.value);
    case 'value':
      return textEquals(entry.node.value, term.value);
    case 'token':
      return entry.token === term.value;
    case 'index':
      return entry.index !== undefined && String(entry.index) === term.value;
    case 'enabled':
      return (states.disabled !== true) === flag(term.value);
    case 'selected':
      return (states.selected === true) === flag(term.value);
    case 'focused':
      return (states.focused === true) === flag(term.value);
    case 'checked':
      return (states.checked === true) === flag(term.value);
    default:
      return false;
  }
}
