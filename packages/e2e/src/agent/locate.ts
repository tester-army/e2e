/**
 * Located-action tier (spec 02-test-api.md, 10-determinism.md).
 *
 * The model selects exactly one node from one fresh observation. The runner
 * derives portable semantic queries for that node, resolves them itself, and
 * requires a query that identifies the same single node before dispatching any
 * action. The model never supplies a selector, coordinate, or action.
 */

import type { LocatorExpression, NodeRef, SemanticNode } from '../driver/index.ts';
import {
  describeExpression,
  filterExpression,
  frameExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from '../locator/expression.ts';
import { POLL_INTERVAL_MS, sleep } from '../internal/time.ts';
import type { Role } from '../types.ts';
import { AgentError } from './error.ts';
import { Invocation, toAgentError } from './invocation.ts';
import type { AgentObservation } from './observation.ts';
import {
  LOCATE_SCHEMA,
  validateLocateResponse,
  type LocateResponse,
  type ProtocolValidation,
} from './protocol.ts';
import { LOCATE_REQUEST } from './prompts.ts';

export interface LocatedNode {
  readonly ref: NodeRef;
  readonly expression: LocatorExpression;
  /** Freshly read node behind the derived query. */
  readonly node: SemanticNode;
  readonly observation: AgentObservation;
  /** Model-reported reason for the selection. Untrusted prose. */
  readonly explanation: string;
}

export interface Selection {
  readonly observation: AgentObservation;
  /** Null when the model declined or named a node absent from this observation. */
  readonly selected: SemanticNode | null;
  /** Why the node was selected, or why no node matches. Untrusted prose. */
  readonly explanation: string;
  /** True when the model explicitly reported that no node matches. */
  readonly declined: boolean;
}

/**
 * Takes one fresh observation and asks the model to select one node. Uses
 * exactly one model call.
 */
export async function observeAndSelect(
  invocation: Invocation,
  target: string,
): Promise<Selection> {
  const observation = await invocation.observe();
  const response = await invocation.ask({
    schemaName: 'agent-locate-1',
    schema: LOCATE_SCHEMA,
    validate: (value) => validateAgainstObservation(value, observation),
    prompt: { request: LOCATE_REQUEST, instruction: target, observation },
  });
  const explanation = response.explanation;
  if (response.target === null) {
    return { observation, selected: null, explanation, declined: true };
  }
  const selected = observation.nodes.get(response.target.id) ?? null;
  if (selected === null) invocation.recordPolicy('locate.node', 'denied', 'POLICY_DENIED');
  return { observation, selected, explanation, declined: false };
}

/**
 * Protocol validation plus observation grounding. A response naming a node id
 * or revision outside the current observation violates "never invent node
 * identifiers" and is invalid output, so the ask() repair loop can correct one
 * hallucinated identifier while the model-call budget allows.
 */
function validateAgainstObservation(
  value: unknown,
  observation: AgentObservation,
): ProtocolValidation<LocateResponse> {
  const validation = validateLocateResponse(value);
  if (!validation.ok || validation.value.target === null) return validation;
  const { id, revision } = validation.value.target;
  if (revision !== observation.revision) {
    return {
      ok: false,
      issue: `target.revision "${revision}" is stale; answer for the current observation revision "${observation.revision}"`,
    };
  }
  if (!observation.nodes.has(id)) {
    return {
      ok: false,
      issue: `target.id "${id}" is not in the current observation; use only node ids it contains`,
    };
  }
  return validation;
}

/** Selects one node and resolves it to a deterministic, unique locator. */
export async function locateOne(
  invocation: Invocation,
  target: string,
  options: { testIdAttribute: string },
): Promise<LocatedNode> {
  const selection = await observeAndSelect(invocation, target);
  if (selection.declined) {
    invocation.note({ explanation: selection.explanation });
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      `the model found no node matching ${JSON.stringify(target)}: ${selection.explanation}`,
    );
  }
  if (selection.selected === null) {
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      `the observation contains no node matching ${JSON.stringify(target)}`,
    );
  }
  return resolveSelected(
    invocation,
    { observation: selection.observation, selected: selection.selected, explanation: selection.explanation },
    options,
  );
}

/**
 * Resolves a selected observation node through the first derived query that
 * matches exactly one node with the same semantics.
 */
export async function resolveSelected(
  invocation: Invocation,
  selection: { observation: AgentObservation; selected: SemanticNode; explanation?: string },
  options: { testIdAttribute: string },
): Promise<LocatedNode> {
  const candidates = deriveQueries(selection.selected, options.testIdAttribute).map((query) =>
    scopeToFrames(query, selection.selected.framePath),
  );
  if (candidates.length === 0) {
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      'the selected node exposes no role, name, test ID, placeholder, or text to address it portably',
    );
  }
  const engine = invocation.engine;
  let ambiguous: LocatorExpression | undefined;

  for (;;) {
    // Ambiguity is judged per sweep: a query that stopped matching several
    // nodes must not keep reporting LOCATOR_AMBIGUOUS from an earlier round.
    ambiguous = undefined;
    for (const expression of candidates) {
      let refs: readonly NodeRef[];
      try {
        // The invocation deadline bounds the sweep, so a caller-supplied
        // timeout is honored even while a driver error stays retryable.
        refs = await engine.resolveAll(expression, invocation.deadline);
      } catch (cause) {
        throw toAgentError(cause);
      }
      if (refs.length === 0) continue;
      if (refs.length > 1) {
        ambiguous = expression;
        continue;
      }
      const ref = refs[0]!;
      let node: SemanticNode;
      try {
        node = await engine.session.screen.read(ref, invocation.operation());
      } catch {
        continue;
      }
      if (!matchesSignature(selection.selected, node)) continue;
      invocation.recordPolicy('locate.identity', 'allowed');
      return {
        ref,
        expression,
        node,
        observation: selection.observation,
        explanation: selection.explanation ?? '',
      };
    }

    if (invocation.deadline.expired()) break;
    await sleep(POLL_INTERVAL_MS, engine.signal);
  }

  invocation.recordPolicy('locate.identity', 'denied');
  if (ambiguous !== undefined) {
    throw new AgentError(
      'LOCATOR_AMBIGUOUS',
      `no derived query uniquely identifies the selected node; ${describeExpression(ambiguous)} matched several`,
    );
  }
  throw new AgentError(
    'LOCATOR_NOT_FOUND',
    `no derived query resolved the selected node (${describe(selection.selected)})`,
  );
}

/**
 * Scopes one derived query to the observed node's enclosing frame chain, so a
 * node inside an iframe re-resolves through the same frames deterministically.
 */
function scopeToFrames(
  query: LocatorExpression,
  framePath: readonly string[] | undefined,
): LocatorExpression {
  if (framePath === undefined || framePath.length === 0) return query;
  return framePath.reduceRight((source, selector) => frameExpression(selector, source), query);
}

/**
 * Derives candidate `screen` queries for one observed node, most portable
 * first. A candidate never contains a node reference, coordinate, or selector.
 */
export function deriveQueries(
  node: SemanticNode,
  testIdAttribute: string,
): readonly LocatorExpression[] {
  const candidates: LocatorExpression[] = [];
  const role = node.role;
  const name = normalize(node.name);
  const text = normalize(node.text);
  const testId = node.attributes?.[testIdAttribute];
  const placeholder = node.attributes?.['placeholder'];

  if (role !== undefined && role !== '' && name !== '') {
    candidates.push(roleQuery(role as Role, { name, exact: true }, undefined));
  }
  if (testId !== undefined && testId !== '') {
    const byTestId = testIdQuery(testId, undefined);
    const disambiguator = name !== '' ? name : text;
    if (disambiguator !== '') {
      candidates.push(filterExpression(byTestId, { hasText: disambiguator }));
    }
    candidates.push(byTestId);
  }
  if (placeholder !== undefined && placeholder !== '') {
    candidates.push(textQuery('placeholder', placeholder, { exact: true }, undefined));
  }
  if (name !== '') {
    candidates.push(textQuery('label', name, { exact: true }, undefined));
    candidates.push(textQuery('text', name, { exact: true }, undefined));
  }
  if (text !== '' && text !== name) {
    candidates.push(textQuery('text', text, { exact: true }, undefined));
  }
  if (role !== undefined && role !== '' && text !== '') {
    candidates.push(
      filterExpression(roleQuery(role as Role, undefined, undefined), { hasText: text }),
    );
  }
  return candidates;
}

/**
 * Compares the observed node with the node a derived query resolved to. Both
 * sides are produced by the same driver reader, so role, purpose, and name are
 * directly comparable.
 */
export function matchesSignature(observed: SemanticNode, resolved: SemanticNode): boolean {
  if (
    observed.role !== undefined &&
    observed.role !== 'document' &&
    resolved.role !== observed.role
  ) {
    return false;
  }
  if (
    observed.inputPurpose !== undefined &&
    resolved.inputPurpose !== undefined &&
    observed.inputPurpose !== resolved.inputPurpose
  ) {
    return false;
  }
  const observedName = normalize(observed.name);
  if (observedName !== '') return normalize(resolved.name) === observedName;
  const observedText = normalize(observed.text);
  if (observedText === '') return true;
  return normalize(resolved.text).includes(observedText);
}

function describe(node: SemanticNode): string {
  return `role=${node.role ?? 'none'} name=${JSON.stringify(normalize(node.name))}`;
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
