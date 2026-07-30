/**
 * Resolving a model's selection to something the driver can act on.
 *
 * The model picks a node out of an observation; this turns that pick into a
 * portable query the driver can re-run and the report can show. Every path ends
 * in a re-read of the live node and a signature check, so a selection that has
 * gone stale is a miss rather than a blind dispatch.
 *
 * A query that matches several nodes is not a dead end: the selected node is one
 * of them, and pinning it by index turns an ambiguous query into a unique one.
 * That index is a property of this run's match set, not of the page, which is
 * why an index-bearing locator is resolvable now but not recordable later — see
 * `storableLocator`.
 */

import type { NodeRef, SemanticNode } from '../driver/index.ts';
import { describeExpression, indexExpression } from '../locator/expression.ts';
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
    let terminal = false;
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
      // A query matching several nodes is not necessarily a dead end: the
      // selected node is one of them, and pinning it by position turns the
      // ambiguous query into a unique one.
      const picked =
        refs.length === 1
          ? await readOnly(invocation, refs[0]!)
          : await pinOne(invocation, refs, selection.selected);
      if (picked.kind === 'miss') {
        ambiguous ||= picked.ambiguous;
        terminal ||= picked.terminal === true;
        outcomes.push(`${describeExpression(expression)} -> ${picked.detail}`);
        continue;
      }
      if (!matchesSignature(selection.selected, picked.node)) {
        outcomes.push(
          `${describeExpression(expression)} -> resolved a different node (${describeSignature(picked.node)})`,
        );
        continue;
      }
      // The expression carries the index, so the action still dispatches through
      // a query the report can show, not through a raw handle.
      const resolved =
        picked.index === undefined ? expression : indexExpression(expression, picked.index);
      invocation.recordPolicy('locate.identity', 'allowed');
      agentTrace(() => `locate: resolved via ${describeExpression(resolved)}`);
      return {
        kind: 'node',
        ref: picked.ref,
        expression: resolved,
        node: picked.node,
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
    // `terminal` short-circuits the wait: an instruction that lands on controls
    // nothing can tell apart is not a page that is still settling, and spending
    // the whole deadline before saying so buries the diagnosis in a timeout.
    if (options.poll === false || terminal || invocation.deadline.expired()) throw giveUp();
    await sleep(POLL_INTERVAL_MS, engine.signal);
    // Never begin a sweep on an expired clock. A zero remaining budget reaches
    // the driver as "no timeout" rather than "give up now", so the next query
    // would hang and the step would die of an outer timeout — losing the
    // diagnosis this sweep already has.
    if (invocation.deadline.expired()) throw giveUp();
  }
}

/**
 * The failure of a completed sweep, naming every candidate and its outcome.
 *
 * Ambiguity that survived indexing is a property of the page rather than of the
 * query vocabulary, so it comes with the only remedy that works: a more specific
 * instruction. Without that line a reader sees a list of rejected queries and
 * reaches for a longer timeout instead.
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

/**
 * What one candidate query produced: the selected node pinned down, or why not.
 *
 * `ambiguous` is carried rather than inferred from the text, because it decides
 * whether the sweep reports LOCATOR_AMBIGUOUS or LOCATOR_NOT_FOUND.
 */
type MatchOutcome =
  | {
      readonly kind: 'pinned';
      readonly ref: NodeRef;
      readonly node: SemanticNode;
      /** Set when an index is needed to make the query resolve to one node. */
      readonly index?: number;
    }
  | {
      readonly kind: 'miss';
      readonly detail: string;
      readonly ambiguous: boolean;
      /** True when re-sweeping cannot change this outcome. */
      readonly terminal?: boolean;
    };

/** One candidate query failed to pin the node down. */
function miss(detail: string, ambiguous = false, terminal = false): MatchOutcome {
  return { kind: 'miss', detail, ambiguous, terminal };
}

/**
 * Beyond this many matches a query is not worth disambiguating: an instruction
 * that lands on dozens of identical controls needs rewording, not an index, and
 * reading them all would spend the sweep's budget on one hopeless candidate.
 */
const MAX_AMBIGUOUS_MATCHES = 24;

/** Reads the single match of an unambiguous query. */
async function readOnly(invocation: Invocation, ref: NodeRef): Promise<MatchOutcome> {
  try {
    const node = await invocation.engine.session.screen.read(ref, invocation.operation());
    return { kind: 'pinned', ref, node };
  } catch {
    return miss('matched node became unreadable');
  }
}

/**
 * Picks the selected node out of an ambiguous query's matches.
 *
 * The index is computed here, against the match set the query actually returned,
 * rather than recorded during observation. That is what keeps `nth` honest: the
 * observation is byte-budgeted and may not even contain every match, and the page
 * can reflow between capture and resolution. Deciding at resolve time means the
 * index always refers to the list it was measured against, and the caller still
 * signature-checks the node before dispatching, so a page that reordered fails
 * the check instead of acting on the wrong control.
 *
 * Discrimination is by signature first, then by observed geometry. Two distinct
 * visible controls cannot occupy the same rectangle, so a rect that still matches
 * identifies the one the model chose; a reflow moves all of them and matches
 * none, which reports ambiguity rather than guessing.
 */
async function pinOne(
  invocation: Invocation,
  refs: readonly NodeRef[],
  selected: SemanticNode,
): Promise<MatchOutcome> {
  if (refs.length > MAX_AMBIGUOUS_MATCHES) {
    return miss(`${refs.length} matches, too many to tell apart`, true);
  }
  const matches: Extract<MatchOutcome, { kind: 'pinned' }>[] = [];
  let unread = 0;
  for (const [index, ref] of refs.entries()) {
    let node: SemanticNode;
    try {
      node = await invocation.engine.session.screen.read(ref, invocation.operation());
    } catch {
      // A match that could not be read is a match whose identity is unknown, and
      // dropping it would shrink the set until whatever is left looks unique.
      // Under a nearly-expired deadline that turned "indistinguishable" into a
      // confident index onto an arbitrary element.
      unread += 1;
      continue;
    }
    if (matchesSignature(selected, node)) matches.push({ kind: 'pinned', ref, node, index });
  }
  if (unread > 0) {
    return miss(`${refs.length} matches, ${unread} of them unreadable`, true);
  }
  if (matches.length === 0) {
    return miss(`${refs.length} matches, none of them the selected node`, true);
  }
  if (matches.length === 1) return matches[0]!;
  const byRect = matches.filter((match) => sameRect(selected.rect, match.node.rect));
  if (byRect.length === 1) return byRect[0]!;
  // Indistinguishable by name and by position both. Re-sweeping cannot separate
  // them, so this is terminal: the instruction, not the locator, has to choose,
  // and polling to the deadline would only delay saying so.
  return miss(
    `${matches.length} matches indistinguishable from the selected node`,
    true,
    true,
  );
}

/** Exact rectangle equality, used only to tell simultaneous matches apart. */
function sameRect(a: SemanticNode['rect'], b: SemanticNode['rect']): boolean {
  if (a === undefined || b === undefined) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

