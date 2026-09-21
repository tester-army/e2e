/**
 * agent-device selector support for the `selector` locator expression:
 * `screen.locator('id=save role=button')` and the structural hint on every
 * observed node. The grammar is agent-device's own (`parseSelectorChain`), so a
 * selector that works on the agent-device CLI works here unchanged; matching
 * runs against the projected snapshot, one immediate pass, every match returned.
 */

import { parseSelectorChain } from 'agent-device/selectors';
import { EngineError } from 'e2e/engine';
import { normalizeKind, type ProjectedNode } from './nodes.ts';
import { message } from './errors.ts';

interface Term {
  readonly key: string;
  readonly value: string | boolean;
}

export type CompiledSelector = (entries: readonly ProjectedNode[]) => ProjectedNode[];

/**
 * Compiles one selector string. Alternatives (agent-device's fallback chain)
 * are tried in order and the first that matches anything wins, mirroring how
 * agent-device itself resolves a chain; a term's text compares exactly after
 * whitespace collapsing, like every other text rule in the runner.
 */
export function compileSelector(raw: string): CompiledSelector {
  let chain: ReturnType<typeof parseSelectorChain>;
  try {
    chain = parseSelectorChain(raw);
  } catch (cause) {
    throw new EngineError('ENGINE_FAILURE', `invalid agent-device selector ${JSON.stringify(raw)}: ${message(cause)}`, {
      retryable: false,
      cause,
    });
  }
  return (entries) => {
    for (const alternative of chain.selectors) {
      const matches = entries.filter((entry) => alternative.terms.every((term) => matchesTerm(entry, term)));
      if (matches.length > 0) return matches;
    }
    return [];
  };
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function textEquals(actual: string | undefined, expected: string | boolean): boolean {
  return actual !== undefined && normalize(actual) === normalize(String(expected));
}

function flag(value: string | boolean): boolean {
  return value === true || String(value).toLowerCase() === 'true';
}

function matchesTerm(entry: ProjectedNode, term: Term): boolean {
  const states = entry.node.states ?? {};
  switch (term.key) {
    case 'id':
      return textEquals(entry.raw.identifier, term.value);
    case 'role': {
      const wanted = normalizeKind(String(term.value));
      return entry.kind === wanted || entry.node.role === wanted;
    }
    case 'text':
      return textEquals(entry.raw.label, term.value) || textEquals(entry.raw.value, term.value);
    case 'label':
      return textEquals(entry.raw.label, term.value);
    case 'value':
      return textEquals(entry.raw.value, term.value);
    case 'appname':
      return textEquals(entry.raw.appName, term.value);
    case 'windowtitle':
      return textEquals(entry.raw.windowTitle, term.value);
    case 'visible':
      return (states.hidden !== true) === flag(term.value);
    case 'hidden':
      return (states.hidden === true) === flag(term.value);
    case 'editable':
      return (entry.node.role === 'textbox') === flag(term.value);
    case 'selected':
      return (states.selected === true) === flag(term.value);
    case 'focused':
      return (states.focused === true) === flag(term.value);
    case 'enabled':
      return (states.disabled !== true) === flag(term.value);
    case 'hittable':
      return (entry.raw.hittable !== false) === flag(term.value);
    default:
      return false;
  }
}
