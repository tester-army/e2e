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
  roleQuery,
  testIdQuery,
  textQuery,
} from '../locator/expression.ts';
import { POLL_INTERVAL_MS, sleep } from '../internal/time.ts';
import type { Role } from '../types.ts';
import { AgentError } from './error.ts';
import { Invocation, toAgentError } from './invocation.ts';
import type { AgentObservation } from './observation.ts';
import { LOCATE_SCHEMA, validateLocateResponse } from './protocol.ts';
import { LOCATE_REQUEST } from './prompts.ts';

export interface LocatedNode {
  readonly ref: NodeRef;
  readonly expression: LocatorExpression;
  /** Freshly read node behind the derived query. */
  readonly node: SemanticNode;
  readonly observation: AgentObservation;
}

export interface Selection {
  readonly observation: AgentObservation;
  /** Null when the response named a node absent from this observation. */
  readonly selected: SemanticNode | null;
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
    validate: validateLocateResponse,
    prompt: { request: LOCATE_REQUEST, instruction: target, observation },
  });
  if (response.target.revision !== observation.revision) {
    invocation.recordPolicy('locate.revision', 'denied', 'POLICY_DENIED');
    return { observation, selected: null };
  }
  const selected = observation.nodes.get(response.target.id) ?? null;
  if (selected === null) invocation.recordPolicy('locate.node', 'denied', 'POLICY_DENIED');
  return { observation, selected };
}

/** Selects one node and resolves it to a deterministic, unique locator. */
export async function locateOne(
  invocation: Invocation,
  target: string,
  options: { testIdAttribute: string },
): Promise<LocatedNode> {
  const { observation, selected } = await observeAndSelect(invocation, target);
  if (selected === null) {
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      `the observation contains no node matching ${JSON.stringify(target)}`,
    );
  }
  return resolveSelected(invocation, { observation, selected }, options);
}

/**
 * Resolves a selected observation node through the first derived query that
 * matches exactly one node with the same semantics.
 */
export async function resolveSelected(
  invocation: Invocation,
  selection: { observation: AgentObservation; selected: SemanticNode },
  options: { testIdAttribute: string },
): Promise<LocatedNode> {
  const candidates = deriveQueries(selection.selected, options.testIdAttribute);
  if (candidates.length === 0) {
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      'the selected node exposes no role, name, test ID, placeholder, or text to address it portably',
    );
  }
  const engine = invocation.engine;
  let ambiguous: LocatorExpression | undefined;

  for (;;) {
    for (const expression of candidates) {
      let refs: readonly NodeRef[];
      try {
        refs = await engine.resolveAll(expression);
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
      return { ref, expression, node, observation: selection.observation };
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
