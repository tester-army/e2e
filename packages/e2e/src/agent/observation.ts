/** Observation capture, redaction, and model serialization (spec 09-drivers.md, 14-security.md). */

import type { Observation, SemanticNode } from '../driver/index.ts';
import { sanitizeText } from '../internal/errors.ts';
import { AgentError } from './error.ts';

/** Appended when the node walk stopped at the observation byte budget. */
const TRUNCATION_MARKER = '[observation truncated at the resolved observation byte limit]';

export interface AgentObservation {
  readonly revision: string;
  /** Redacted, size-bounded serialization sent to the model. */
  readonly text: string;
  readonly bytes: number;
  readonly nodes: ReadonlyMap<string, SemanticNode>;
  readonly viewport: { readonly width: number; readonly height: number; readonly scale: number };
  readonly truncated: boolean;
}

/**
 * Turns one raw driver observation into redacted model input.
 *
 * An observation whose masking the driver cannot prove is rejected before it
 * reaches a model or disk. Registered secret values are additionally replaced
 * by their stable secret name.
 */
export function prepareObservation(
  observation: Observation,
  options: {
    secrets: ReadonlyMap<string, string>;
    maxBytes: number;
    testIdAttribute: string;
  },
): AgentObservation {
  if (!observation.redaction.complete) {
    throw new AgentError(
      'POLICY_DENIED',
      'the driver could not prove observation masking is complete; the observation was discarded',
    );
  }

  const nodes = new Map<string, SemanticNode>();
  indexNodes(observation.tree, nodes);

  const redact = createRedactor(options.secrets);
  const lines: string[] = [];
  const encoder = new TextEncoder();
  // The marker is reserved up front so a truncated observation still fits the
  // budget; the budget is what keeps the request under the token ceiling.
  const markerBytes = encoder.encode(`${TRUNCATION_MARKER}\n`).byteLength;
  const budget = Math.max(0, options.maxBytes - markerBytes);
  let bytes = 0;
  let truncated = false;

  const emit = (node: SemanticNode, depth: number): void => {
    if (truncated) return;
    const line = formatNode(node, depth, redact, options.testIdAttribute);
    const size = encoder.encode(`${line}\n`).byteLength;
    if (lines.length > 0 && bytes + size > budget) {
      truncated = true;
      return;
    }
    bytes += size;
    lines.push(line);
    for (const child of node.children ?? []) emit(child, depth + 1);
  };
  emit(observation.tree, 0);
  if (truncated) lines.push(TRUNCATION_MARKER);

  const text = lines.join('\n');
  return {
    revision: observation.revision,
    text,
    bytes: encoder.encode(text).byteLength,
    nodes,
    viewport: observation.viewport,
    truncated,
  };
}

/** Depth beyond this renders flat; deep chrome must not buy tokens with spaces. */
const MAX_INDENT_DEPTH = 10;

/**
 * Renders one node as `#id role "name" text="..." [states]`. Role-less text
 * holders omit the role token entirely: on a large page they are half the
 * lines, and the model needs their text, not a filler word.
 */
function formatNode(
  node: SemanticNode,
  depth: number,
  redact: (text: string) => string,
  testIdAttribute: string,
): string {
  const parts: string[] = [`#${node.ref.id}`];
  if (node.role !== undefined && node.role !== '') parts.push(node.role);
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(redact(node.name)));
  const text = node.text === undefined ? '' : collapse(node.text);
  if (text !== '' && text !== node.name) parts.push(`text=${JSON.stringify(redact(text))}`);
  // Disambiguators the model needs when role and name repeat. The driver has
  // already reduced href to origin and path.
  const testId = node.attributes?.[testIdAttribute];
  if (testId !== undefined && testId !== '') parts.push(`testid=${JSON.stringify(testId)}`);
  const href = node.attributes?.['href'];
  if (href !== undefined && href !== '') parts.push(`href=${JSON.stringify(redact(href))}`);
  const placeholder = node.attributes?.['placeholder'];
  if (placeholder !== undefined && placeholder !== '' && (node.name ?? '') === '') {
    parts.push(`placeholder=${JSON.stringify(redact(placeholder))}`);
  }
  if (node.states?.secure === true) {
    parts.push('value=<secure>');
  } else if (node.value !== undefined && node.value !== '') {
    parts.push(`value=${JSON.stringify(redact(node.value))}`);
  }
  if (node.inputPurpose !== undefined && node.inputPurpose !== 'none') {
    parts.push(`purpose=${node.inputPurpose}`);
  }
  const states = Object.entries(node.states ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (states.length > 0) parts.push(`[${states.join(' ')}]`);
  return `${' '.repeat(Math.min(depth, MAX_INDENT_DEPTH))}${parts.join(' ')}`;
}

function collapse(text: string): string {
  return sanitizeText(text).replace(/\s+/g, ' ').trim();
}

/** Replaces every exact registered secret value with its stable secret name. */
function createRedactor(secrets: ReadonlyMap<string, string>): (text: string) => string {
  const entries = [...secrets]
    .filter(([, value]) => value.length > 0)
    .toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [name, value] of entries) out = out.split(value).join(`<secret:${name}>`);
    return out;
  };
}

function indexNodes(node: SemanticNode, into: Map<string, SemanticNode>): void {
  into.set(node.ref.id, node);
  for (const child of node.children ?? []) indexNodes(child, into);
}
