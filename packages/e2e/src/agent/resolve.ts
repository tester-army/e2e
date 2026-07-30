/**
 * Resolving a model's selection to something the driver can act on.
 *
 * The model picks a node out of an observation; this turns that pick into a
 * portable query the driver can re-run and the report can show. Every path ends
 * in a re-read of the live node and a signature check, so a selection that has
 * gone stale is a miss rather than a blind dispatch.
 *
 * A query that matches several nodes is not a dead end and is not something to
 * disambiguate either: the selection already carries the identity of the node
 * the model picked, as a reference the driver backs with the element itself.
 * Ambiguous queries are dropped and `addressByReference` dispatches through that
 * reference, which no reflow, scroll, or repeated row can confuse.
 */

import type { NodeRef, SemanticNode } from '../driver/index.ts';
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
 * matches exactly one node with the same semantics.
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
      let refs: readonly NodeRef[];
      try {
        // The invocation deadline bounds the sweep, so a caller-supplied
        // timeout is honored even while a driver error stays retryable.
        refs = await engine.resolveAll(expression, invocation.deadline);
      } catch (cause) {
        // A query that ran out of clock is this sweep's own verdict to report, not
        // a transport failure. Rethrowing here would race the loop's diagnosis and
        // surface STEP_TIMEOUT instead of the ambiguity that actually blocked the
        // locate — sending the author after their timeout rather than their
        // instruction.
        if (!invocation.deadline.expired()) throw toAgentError(cause);
        outcomes.push(`${describeExpression(expression)} -> timed out`);
        continue;
      }
      if (refs.length === 0) {
        outcomes.push(`${describeExpression(expression)} -> no matches`);
        continue;
      }
      // A query that matches several nodes cannot say which one the model meant,
      // and no amount of reading them can: separating them by geometry compares
      // viewport coordinates captured before the page scrolled, and separating
      // them by index records an order the next run will not have. The reference
      // below already knows, so this query is simply not the way to say it.
      if (refs.length > 1) {
        ambiguous = true;
        outcomes.push(`${describeExpression(expression)} -> ${refs.length} matches`);
        continue;
      }
      const ref = refs[0]!;
      let node: SemanticNode;
      try {
        node = await invocation.engine.session.screen.read(ref, invocation.operation());
      } catch {
        outcomes.push(`${describeExpression(expression)} -> matched node became unreadable`);
        continue;
      }
      if (!matchesSignature(selection.selected, node)) {
        outcomes.push(
          `${describeExpression(expression)} -> resolved a different node (${describeSignature(node)})`,
        );
        continue;
      }
      invocation.recordPolicy('locate.identity', 'allowed');
      agentTrace(() => `locate: resolved via ${describeExpression(expression)}`);
      return {
        kind: 'node',
        ref,
        expression,
        node,
        observation: selection.observation,
        explanation: selection.explanation,
        origin: 'model',
        targeting: selection.targeting,
      };
    }

    agentTrace(() => `locate: sweep failed\n  ${outcomes.join('\n  ')}`);
    const giveUp = (): AgentError => {
      invocation.recordPolicy('locate.identity', 'denied');
      return sweepFailure(selection.selected, outcomes, ambiguous);
    };
    // Both sweep failures land here: a query that matched several nodes, and one
    // that matched none because the name Playwright computes for a node diverges
    // from the one the observation read — routine for a card-sized accessible
    // name, where a single whitespace or a nested button's text is enough. The
    // model saw that node and the reference still points at it, so there is
    // nothing to wait for and nothing to guess.
    //
    // Skipped only for `poll: false`, where the caller means to escalate rather
    // than to act.
    if (options.poll !== false) {
      const byReference = await addressByReference(invocation, selection);
      if (byReference !== undefined) return byReference;
    }
    // An ambiguous sweep whose reference is gone is not a page still settling:
    // re-running the same queries against the same selection cannot make
    // duplicates unique, and spending the whole deadline before saying so buries
    // the diagnosis in a timeout.
    if (options.poll === false || ambiguous || invocation.deadline.expired()) throw giveUp();
    await sleep(POLL_INTERVAL_MS, engine.signal);
    // Never begin a sweep on an expired clock. A zero remaining budget reaches
    // the driver as "no timeout" rather than "give up now", so the next query
    // would hang and the step would die of an outer timeout — losing the
    // diagnosis this sweep already has.
    if (invocation.deadline.expired()) throw giveUp();
  }
}

/**
 * Acts on the node through the reference the observation handed out.
 *
 * Derived queries describe a node by what it says, and what a node says is not
 * always something a query can be built from: a listing card's accessible name
 * aggregates its whole contents — dates, price, rating, the nested button's
 * label — and the name Playwright recomputes for it differs from the one the
 * observation read by a space or a fragment. Every query then matches nothing,
 * even though the node is right there.
 *
 * The reference is bound to the element the model was shown, in the revision it
 * was shown in, which is a stricter identity than any query. It is re-read
 * first, so a node that has gone away is still a miss rather than a blind
 * dispatch, and the read doubles as the identity check the sweep would have done.
 *
 * What it cannot do is outlive the observation, so it is not a locator and never
 * recorded as one. `storableLocator` stores the driver's selector for this node
 * instead.
 */
async function addressByReference(
  invocation: Invocation,
  selection: Extract<Selection, { kind: 'node' }>,
): Promise<LocatedNode | undefined> {
  const selected = selection.selected;
  let node: SemanticNode;
  try {
    node = await invocation.engine.session.screen.read(selected.ref, invocation.operation());
  } catch {
    agentTrace(() => 'locate: the observed reference could not be read');
    return undefined;
  }
  if (!matchesSignature(selected, node)) {
    agentTrace(() => 'locate: the observed reference no longer reads as the selected node');
    return undefined;
  }
  invocation.recordPolicy('locate.reference', 'allowed');
  agentTrace(
    () =>
      `locate: no derived query resolved ${describeSignature(node)}; ` +
      'acting on its observed reference',
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
 * The failure of a completed sweep, naming every candidate and its outcome.
 *
 * Reaching this with an ambiguous outcome means the reference was gone too, so
 * nothing left in the run knows which control was meant. That is a property of
 * the page rather than of the query vocabulary, so it comes with the only remedy
 * that works: a more specific instruction. Without that line a reader sees a list
 * of rejected queries and reaches for a longer timeout instead.
 */
function sweepFailure(
  selected: SemanticNode,
  outcomes: readonly string[],
  ambiguous: boolean,
): AgentError {
  const detail = outcomes.map((outcome) => `\n  ${outcome}`).join('');
  const remedy = ambiguous
    ? '\nthe page has several controls this instruction cannot tell apart; ' +
      'name what distinguishes the one you mean, such as the section or row it belongs to'
    : '';
  return new AgentError(
    ambiguous ? 'LOCATOR_AMBIGUOUS' : 'LOCATOR_NOT_FOUND',
    `no derived query uniquely resolved the selected node (${describeSignature(selected)}):${detail}${remedy}`,
  );
}
