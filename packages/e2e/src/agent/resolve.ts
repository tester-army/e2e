/**
 * Resolving a model's selection to something the driver can act on.
 *
 * The model picks a node out of an observation; this turns that pick into a
 * reference the runner is willing to dispatch against. Every path here ends in a
 * re-read of the live node and a signature check, so a selection that has gone
 * stale is a miss rather than a blind dispatch.
 *
 * Two ways to address a node, in order of preference: a derived portable query,
 * which survives the observation and is therefore the only thing recordable, and
 * failing that the reference the observation itself handed out, which is exact
 * but dies with the observation.
 */

import type { LocatorExpression, NodeRef, SemanticNode } from '../driver/index.ts';
import { describeExpression } from '../locator/expression.ts';
import { POLL_INTERVAL_MS, sleep } from '../internal/time.ts';
import { agentTrace } from '../internal/trace.ts';
import { AgentError } from './error.ts';
import { Invocation, toAgentError } from './invocation.ts';
import type { LocatedNode, Selection } from './locate.ts';
import {
  deriveQueries,
  describeSignature,
  matchesSignature,
  scopeToFrames,
} from './queries.ts';

/**
 * Resolves a selected observation node through the first derived query that
 * addresses exactly one node with the same semantics, falling back to the
 * observation's own reference for a node no query can separate from its twins.
 *
 * `poll: false` runs a single sweep instead of retrying to the deadline. The
 * node was observed a moment ago, so a sweep that resolves nothing right now is
 * evidence about the derived queries, not about timing — which is enough for a
 * fallback caller to decide to escalate, and only ever worth spending the clock
 * on once there is no escalation left.
 */
export async function resolveSelected(
  invocation: Invocation,
  selection: Extract<Selection, { kind: 'node' }>,
  options: { testIdAttribute: string; poll?: boolean },
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

  for (;;) {
    // Outcomes are collected per sweep: a query that stopped matching several
    // nodes must not keep reporting LOCATOR_AMBIGUOUS from an earlier round.
    const outcomes: string[] = [];
    let ambiguous = false;
    for (const expression of candidates) {
      const candidate = await matchCandidate(invocation, selection.selected, expression);
      if (candidate.kind === 'rejected') {
        outcomes.push(candidate.outcome);
        ambiguous = ambiguous || candidate.ambiguous;
        continue;
      }
      invocation.recordPolicy('locate.identity', 'allowed');
      agentTrace(() => `locate: resolved via ${describeExpression(expression)}`);
      return {
        kind: 'node',
        ref: candidate.ref,
        expression,
        node: candidate.node,
        observation: selection.observation,
        explanation: selection.explanation,
        origin: 'model',
        targeting: selection.targeting,
      };
    }

    agentTrace(() => `locate: sweep failed\n  ${outcomes.join('\n  ')}`);
    // A caller that can still escalate to pixels gets the miss instead: an
    // unaddressable pick is that feature's signal, and pixels can tell twins
    // apart that a reference can only take on trust from a tree-only answer.
    if (options.poll !== false) {
      // Otherwise the observation's own reference still points at exactly the
      // node the model chose, and it is available now: a control the page
      // repeats will not become unique by waiting, so this does not queue
      // behind the poll loop.
      const byReference = await addressByReference(invocation, selection);
      if (byReference !== undefined) return byReference;
    }
    if (options.poll === false || invocation.deadline.expired()) {
      invocation.recordPolicy('locate.identity', 'denied');
      // Each candidate's outcome names the exact query and why it was
      // rejected, so a locate failure explains itself.
      const detail = outcomes.map((outcome) => `\n  ${outcome}`).join('');
      throw new AgentError(
        ambiguous ? 'LOCATOR_AMBIGUOUS' : 'LOCATOR_NOT_FOUND',
        `neither a derived query nor the observed reference resolved the selected node (${describeSignature(
          selection.selected,
        )}):${detail}`,
      );
    }
    await sleep(POLL_INTERVAL_MS, engine.signal);
  }
}

/**
 * Acts on the node through the reference the observation handed out.
 *
 * Derived queries describe a node by what it says, so a page that repeats a
 * control verbatim — one reservation button per departure date, the same label
 * on each — has nodes no query can separate. The reference can: it is bound to
 * the element the model was shown, in the revision it was shown in, which is a
 * stricter identity than any locator. It is re-read first, so a node that has
 * gone away is still a miss rather than a blind dispatch, and the read doubles
 * as the identity check the query sweep would have done.
 *
 * What it cannot do is outlive the observation, so nothing is recorded: a
 * reference is not a locator, and `cache-1` stores locators.
 */
async function addressByReference(
  invocation: Invocation,
  selection: Extract<Selection, { kind: 'node' }>,
): Promise<LocatedNode | undefined> {
  const selected = selection.selected;
  const node = await readNode(invocation, selected.ref);
  if (node === undefined || !matchesSignature(selected, node)) {
    agentTrace(() => 'locate: the observed reference no longer reads as the selected node');
    return undefined;
  }
  invocation.recordPolicy('locate.reference', 'allowed');
  agentTrace(
    () => `locate: no query separates ${describeSignature(node)}; acting on its observed reference`,
  );
  return {
    kind: 'node',
    ref: selected.ref,
    expression: undefined,
    node,
    observation: selection.observation,
    explanation: selection.explanation,
    origin: 'model',
    targeting: selection.targeting,
  };
}

/**
 * What one derived query proved about the selected node on the live screen:
 * either it addresses that node uniquely, or it does not and says why.
 */
type CandidateOutcome =
  | { readonly kind: 'resolved'; readonly ref: NodeRef; readonly node: SemanticNode }
  | { readonly kind: 'rejected'; readonly outcome: string; readonly ambiguous: boolean };

function rejected(outcome: string, ambiguous: boolean): CandidateOutcome {
  return { kind: 'rejected', outcome, ambiguous };
}

/** Resolves one derived query and checks it against the observed node. */
async function matchCandidate(
  invocation: Invocation,
  selected: SemanticNode,
  expression: LocatorExpression,
): Promise<CandidateOutcome> {
  const description = describeExpression(expression);
  let refs: readonly NodeRef[];
  try {
    // The invocation deadline bounds the sweep, so a caller-supplied timeout is
    // honored even while a driver error stays retryable.
    refs = await invocation.engine.resolveAll(expression, invocation.deadline);
  } catch (cause) {
    throw toAgentError(cause);
  }
  if (refs.length === 0) return rejected(`${description} -> no matches`, false);
  if (refs.length > 1) return rejected(`${description} -> ${refs.length} matches`, true);
  const ref = refs[0]!;
  const node = await readNode(invocation, ref);
  if (node === undefined) return rejected(`${description} -> matched node became unreadable`, false);
  if (!matchesSignature(selected, node)) {
    return rejected(`${description} -> resolved a different node (${describeSignature(node)})`, false);
  }
  return { kind: 'resolved', ref, node };
}

/** Reads one resolved node, or undefined when it is no longer readable. */
async function readNode(
  invocation: Invocation,
  ref: NodeRef,
): Promise<SemanticNode | undefined> {
  try {
    return await invocation.engine.session.screen.read(ref, invocation.operation());
  } catch {
    return undefined;
  }
}
