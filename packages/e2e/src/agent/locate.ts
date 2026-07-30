/**
 * Located-action tier (spec 02-test-api.md, 10-determinism.md).
 *
 * The model selects exactly one node from one fresh observation. The runner
 * derives portable semantic queries for that node, resolves them itself, and
 * requires a query that identifies the same single node before dispatching any
 * action. The model never supplies a selector or an action.
 *
 * A vision call may answer with a screenshot point instead of a node, for
 * surfaces the tree cannot describe. That is the one case where the model
 * supplies a coordinate, and it stays data: the runner bounds it to the
 * observed viewport, hit-tests it against the same observation, and records
 * what was found there before any dispatch.
 */

import { cacheMethodForApi } from '../cache/index.ts';
import {
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  type LocatorExpression,
  type NodeRef,
  type SemanticNode,
  type ViewportPoint,
} from '../driver/index.ts';
import {
  describeExpression,
  filterExpression,
  frameExpression,
  roleQuery,
  testIdQuery,
  textQuery,
} from '../locator/expression.ts';
import { POLL_INTERVAL_MS, sleep } from '../internal/time.ts';
import { agentTrace } from '../internal/trace.ts';
import type { Role } from '../types.ts';
import { AgentError } from './error.ts';
import { Invocation, toAgentError } from './invocation.ts';
import { openLocateCache, type OpenLocateCache } from './locate-cache.ts';
import type { AgentObservation, AgentPixels } from './observation.ts';
import {
  isNodeTarget,
  LOCATE_SCHEMAS,
  validateLocateResponse,
  type LocateGrammar,
  type ProtocolValidation,
} from './protocol.ts';
import { LOCATE_REQUESTS } from './prompts.ts';

export interface LocatedNode {
  readonly kind: 'node';
  readonly ref: NodeRef;
  /**
   * The portable query that re-found this node, or undefined when the node was
   * addressed by the reference the observation itself handed out. A node the
   * page repeats verbatim has no query that singles it out, and its reference
   * is the only exact answer; nothing about it is storable, so a
   * reference-addressed target is never cached.
   */
  readonly expression: LocatorExpression | undefined;
  /** Freshly read node behind the derived query. */
  readonly node: SemanticNode;
  readonly observation: AgentObservation;
  /** Model-reported reason for the selection. Untrusted prose. */
  readonly explanation: string;
  /** Whether a model chose this node or a cache entry replayed it. */
  readonly origin: 'model' | 'cache';
  /**
   * True when the instruction picked this node out by position rather than by
   * content, as reported by the model. Such a target is never recorded.
   */
  readonly positional: boolean;
}

/**
 * A validated screenshot point to act on directly. The runner dispatches at
 * the point, not at `hit`: retargeting to the center of an enclosing node
 * would move the action away from the pixels the model actually chose, which
 * on a canvas is the whole surface. `hit` is the audit record of what the tree
 * says is there.
 */
export interface LocatedPoint {
  readonly kind: 'point';
  readonly point: ViewportPoint;
  /** Innermost observed node containing the point, when the tree has one. */
  readonly hit: SemanticNode | null;
  readonly observation: AgentObservation;
  readonly explanation: string;
}

export type Located = LocatedNode | LocatedPoint;

/**
 * What one locate call got back, as the four outcomes it actually has.
 *
 * A union rather than a bag of correlated nulls: every consumer has to say
 * what it does with a point and with a miss, so a polling caller cannot
 * mistake a pointed answer for "not on screen yet".
 */
export type Selection =
  | {
      readonly kind: 'node';
      readonly observation: AgentObservation;
      readonly selected: SemanticNode;
      /** Why the node was selected. Untrusted prose. */
      readonly explanation: string;
      /** The model's report that the instruction identified this node by position. */
      readonly positional: boolean;
    }
  | {
      readonly kind: 'point';
      readonly observation: AgentObservation;
      readonly point: ViewportPoint;
      /** Innermost observed node under `point`, for the audit record. */
      readonly hit: SemanticNode | null;
      readonly explanation: string;
    }
  /** The model named a node id the current observation does not contain. */
  | {
      readonly kind: 'absent';
      readonly observation: AgentObservation;
      readonly explanation: string;
    }
  /** The model explicitly reported that nothing matches. */
  | {
      readonly kind: 'none';
      readonly observation: AgentObservation;
      readonly explanation: string;
    };

/**
 * Takes one fresh observation and asks the model to select one node, or, when
 * the caller can act on a coordinate and pixels reached the request, one
 * point. Uses exactly one model call.
 *
 * `allowPoint` is the caller's answer to "can I act on a bare coordinate?",
 * and it gates the grammar, not the result. A caller that needs a node
 * reference is never shown the pointing schema or the pointing instructions,
 * so it can never spend a model call on an answer it would have to reject.
 */
export async function observeAndSelect(
  invocation: Invocation,
  target: string,
  options: { allowPoint: boolean } = { allowPoint: false },
): Promise<Selection> {
  const observation = await invocation.observe();
  // Pointing additionally requires pixels that actually became model input. A
  // vision call degraded to tree-only input (taint, unprovable masking, a
  // driver without pixels) falls back to the semantic grammar, so the model is
  // never invited to point at an image it cannot see.
  const pixels = options.allowPoint ? observation.pixels : undefined;
  const grammar: LocateGrammar = invocation.treeWithheld
    ? 'point'
    : pixels === undefined
      ? 'node'
      : 'nodeOrPoint';
  const answer = await invocation.ask({
    schemaName: 'agent-locate-1',
    schema: LOCATE_SCHEMAS[grammar],
    validate: (value) => validateAgainstObservation(value, observation, grammar, pixels),
    prompt: { request: LOCATE_REQUESTS[grammar], instruction: target, observation },
  });
  const explanation = answer.explanation;
  if (answer.kind === 'none') {
    agentTrace(() => `locate ${JSON.stringify(target)}: model declined — ${explanation}`);
    return { kind: 'none', observation, explanation };
  }
  if (answer.kind === 'point') {
    const { point } = answer;
    const hit = hitTest(observation, point);
    invocation.recordPolicy('locate.point', 'allowed');
    agentTrace(
      () =>
        `locate ${JSON.stringify(target)}: model pointed at (${point.x}, ${point.y}) (${
          hit === null ? 'no semantic node there' : describe(hit)
        }) — ${explanation}`,
    );
    return { kind: 'point', observation, point, hit, explanation };
  }
  const selected = observation.nodes.get(answer.id);
  agentTrace(
    () =>
      `locate ${JSON.stringify(target)}: model selected #${answer.id} (${
        selected === undefined ? 'not in observation' : describe(selected)
      }) — ${explanation}`,
  );
  if (selected === undefined) {
    invocation.recordPolicy('locate.node', 'denied', 'POLICY_DENIED');
    return { kind: 'absent', observation, explanation };
  }
  return { kind: 'node', observation, selected, explanation, positional: answer.positional };
}

/**
 * One locate answer, already grounded in the observation it was asked about
 * and already expressed in runner space.
 *
 * Validation is where the answer meets the observation, so it is also where a
 * screenshot coordinate becomes a viewport coordinate: the image is in scope
 * exactly once, and no later stage has to re-derive which space a number is in
 * or assert that a screenshot was attached.
 */
type LocateAnswer =
  | {
      readonly kind: 'node';
      readonly id: string;
      readonly explanation: string;
      readonly positional: boolean;
    }
  | { readonly kind: 'point'; readonly point: ViewportPoint; readonly explanation: string }
  | { readonly kind: 'none'; readonly explanation: string };

/**
 * Protocol validation plus observation grounding. A response naming a node id,
 * a revision, or a point outside the current observation violates "never
 * invent identifiers" and is invalid output, so the ask() repair loop can
 * correct one bad reference while the model-call budget allows.
 *
 * `pixels` is the image the model was shown, or undefined for a tree-only
 * call. Undefined makes a point target invalid rather than merely unusable.
 */
function validateAgainstObservation(
  value: unknown,
  observation: AgentObservation,
  grammar: LocateGrammar,
  pixels: AgentPixels | undefined,
): ProtocolValidation<LocateAnswer> {
  const validation = validateLocateResponse(value, grammar);
  if (!validation.ok) return validation;
  const { target, explanation, positional } = validation.value;
  if (target === null) return { ok: true, value: { kind: 'none', explanation } };
  if (target.revision !== observation.revision) {
    return {
      ok: false,
      issue: `target.revision "${target.revision}" is stale; answer for the current observation revision "${observation.revision}"`,
    };
  }
  if (isNodeTarget(target)) {
    if (!observation.nodes.has(target.id)) {
      return {
        ok: false,
        issue: `target.id "${target.id}" is not in the current observation; use a node id exactly as printed after "#", e.g. "n42"`,
      };
    }
    return { ok: true, value: { kind: 'node', id: target.id, explanation, positional } };
  }
  if (pixels === undefined) {
    return { ok: false, issue: 'no screenshot was attached; select a node from the observation' };
  }
  // Bounds are checked in the image space the model was shown, not the CSS
  // viewport. Out of bounds means the coordinate space was misread — a
  // normalized or percentage answer — and clamping it would dispatch into a
  // corner instead of surfacing the mistake for one repair round.
  const { x, y } = target.point;
  if (x > pixels.width - 1 || y > pixels.height - 1) {
    return {
      ok: false,
      issue:
        `target.point (${x}, ${y}) is outside the attached ${pixels.width}x${pixels.height} screenshot; ` +
        `return absolute pixels with x in [0, ${pixels.width - 1}] and y in [0, ${pixels.height - 1}], ` +
        'never normalized or percentage values',
    };
  }
  return {
    ok: true,
    value: { kind: 'point', point: toViewportPoint(pixels, target.point), explanation },
  };
}

/**
 * Converts a point read off the screenshot into the CSS pixel space the driver
 * dispatches in and node rects are expressed in, clamped to that space.
 *
 * The ratio is 1 for a CSS-scale capture, so this is a no-op on web today, but
 * it is what keeps a device-scale capture — the normal case for a phone
 * screenshot — from acting at a fraction of the intended position.
 */
function toViewportPoint(pixels: AgentPixels, point: { x: number; y: number }): ViewportPoint {
  const scale = pixels.scale > 0 ? pixels.scale : 1;
  const maxX = Math.max(0, Math.round(pixels.width / scale) - 1);
  const maxY = Math.max(0, Math.round(pixels.height / scale) - 1);
  return {
    x: clamp(Math.round(point.x / scale), 0, maxX),
    y: clamp(Math.round(point.y / scale), 0, maxY),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Finds the innermost observed node containing a point.
 *
 * Node rects and the screenshot share the CSS pixel space, so the observation
 * is itself the hit-test surface: no extra driver round-trip, and the answer is
 * a node the model could equally have named. The document root is skipped
 * because it contains every point and would make "nothing is there" — the case
 * that motivates pointing — impossible to report.
 *
 * Rects are half-open, so abutting siblings do not both claim their seam.
 */
export function hitTest(
  observation: AgentObservation,
  point: ViewportPoint,
): SemanticNode | null {
  let best: SemanticNode | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const node of observation.nodes.values()) {
    const rect = node.rect;
    if (rect === undefined || node.role === 'document' || node.states?.hidden === true) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (point.x < rect.x || point.x >= rect.x + rect.width) continue;
    if (point.y < rect.y || point.y >= rect.y + rect.height) continue;
    const area = rect.width * rect.height;
    if (area >= bestArea) continue;
    best = node;
    bestArea = area;
  }
  return best;
}

/**
 * What a caller does with a screenshot point.
 *
 * One value carries both halves of the decision: whether the model is offered
 * the pointing grammar at all, and what happens to a point that comes back.
 * A caller with no `perform` is never shown the pointing schema, which is why
 * `locateOne` resolves to a node for it.
 */
export type PointPolicy<Value = never> =
  | { readonly allowed: false }
  | {
      readonly allowed: true;
      /** Dispatches at the point, in place of the located-node action. */
      readonly perform: (invocation: Invocation, located: LocatedPoint) => Promise<Value>;
    };

/** The policy of a caller that needs a node reference to hand the driver. */
export const NODE_ONLY: PointPolicy = { allowed: false };

export interface LocateOptions {
  readonly testIdAttribute: string;
  /**
   * Non-secret parameters of the calling method, digested into the cache key.
   * A secret contributes only its stable name and purpose, never its value.
   *
   * Required, and empty only for a call that genuinely has no parameters. An
   * optional field here would let a new located action silently key on nothing
   * and replay an entry recorded for different arguments.
   */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Opens the cache for this call, or returns undefined when the method is not
 * cacheable. `cache-1` admits a closed set of methods, so a located action
 * outside it reports a bypass rather than inventing a key.
 */
async function openCacheFor(
  invocation: Invocation,
  target: string,
  options: LocateOptions,
): Promise<OpenLocateCache | undefined> {
  const method = cacheMethodForApi(invocation.api);
  if (method === undefined) {
    return invocation.bypassCache(`${invocation.api} is not a cacheable cache-1 method`);
  }
  const bypass = invocation.cacheBypass;
  if (bypass !== undefined) return invocation.bypassCache(bypass);
  // Observed only once it is known this call will be keyed, so a non-cacheable
  // or opted-out method never pays for it. A hit replays against this
  // observation; a miss re-observes inside the attempt, which is one extra
  // observation against the model call it is about to avoid paying for.
  const observation = await invocation.observe();
  return openLocateCache(invocation, observation, {
    method,
    instruction: target,
    input: options.input,
  });
}

/**
 * Locates one node, scrolling and re-observing until the model finds it or the
 * budget runs out, then hands the node back for the caller to act on.
 *
 * Node-only by construction: `scrollIntoView` needs a node reference, so the
 * model is never shown the pointing grammar here and a pointed answer, which
 * this loop would misread as "not on screen yet", cannot reach it.
 */
export async function locateByScrolling(
  invocation: Invocation,
  target: string,
  options: LocateOptions,
  scroll: () => Promise<void>,
): Promise<LocatedNode> {
  const cache = await openCacheFor(invocation, target, options);
  const replayed = await cache?.replay();
  if (replayed !== undefined) return replayed;

  let lastExplanation = '';
  for (let round = 1; ; round += 1) {
    invocation.recordPoll('scrollTo', round);
    const selection = await observeAndSelect(invocation, target);
    if (selection.kind === 'node') {
      const located = await resolveSelected(invocation, selection, options);
      await cache?.record(located);
      return located;
    }
    if (selection.kind === 'none') lastExplanation = selection.explanation;
    if (invocation.deadline.expired() || !invocation.canAsk()) {
      if (lastExplanation !== '') invocation.note({ explanation: lastExplanation });
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        `scrollTo did not reach ${JSON.stringify(target)} within its budget${
          lastExplanation === '' ? '' : `; the model reported: ${lastExplanation}`
        }`,
      );
    }
    await scroll();
  }
}

/**
 * Selects one node and resolves it to a deterministic, unique locator, or, for
 * a caller whose policy allows it, dispatches at one screenshot point.
 *
 * Under `vision: 'fallback'` this is the method that owns the escalation,
 * because a locate is the only thing that can say "the tree was not enough"
 * without guessing: either the model reported no match, or no derived query
 * resolved the node it chose. Both surface as the same two locator codes, so
 * one attempt, one predicate, and one retry cover the whole feature.
 */
export async function locateOne<Value = never>(
  invocation: Invocation,
  target: string,
  options: LocateOptions & { point?: PointPolicy<Value> },
): Promise<LocatedNode | Value> {
  requirePointCapability(invocation, options.point ?? NODE_ONLY);

  // Opened once, before any attempt: a vision escalation re-asks the model but
  // stays on the same route, so it is the same key and must not be looked up
  // twice.
  const cache = await openCacheFor(invocation, target, options);
  const replayed = await cache?.replay();
  if (replayed !== undefined) return replayed;

  try {
    // While an escalation is still available, the first attempt does not spend
    // the clock proving a tree-only pick unresolvable: one sweep, then ask
    // again with pixels. The escalated attempt polls to the deadline as usual,
    // so the worst case is no slower than a single-tier locate.
    const poll = !invocation.canEscalateVision();
    return await locateAttempt(invocation, target, { ...options, poll, cache });
  } catch (cause) {
    // Re-asked rather than reused: the first attempt spent budget and clock, and
    // escalating into an exhausted budget would replace the locator failure the
    // caller needs to read with a budget failure.
    if (!invocation.canEscalateVision() || invocation.dispatched || !isTreeMiss(cause)) {
      throw cause;
    }
    invocation.escalateVision();
    return locateAttempt(invocation, target, { ...options, poll: true, cache });
  }
}

/**
 * Rejects `vision: 'only'` for a method that needs a semantic node.
 *
 * Withholding the tree leaves a point as the only expressible answer, and this
 * method has no coordinate equivalent, so the call cannot be satisfied. Failing
 * before the first model call says that plainly, instead of paying for a round
 * that can only come back invalid.
 */
function requirePointCapability(invocation: Invocation, policy: PointPolicy<unknown>): void {
  if (!invocation.treeWithheld || policy.allowed) return;
  throw new AgentError(
    'POLICY_DENIED',
    `${invocation.api} acts on a semantic node, but vision: 'only' withholds the observation, ` +
      'leaving nothing to name a node from; use true or \'fallback\' here, or tap/click for a ' +
      'target that only pixels can find',
  );
}

/**
 * True for the failures that mean "the accessibility tree did not describe this
 * target", which are exactly the ones pixels can still answer. Any other
 * failure — a dispatch, a timeout, a cancelled run — is not retried.
 */
function isTreeMiss(cause: unknown): boolean {
  if (!(cause instanceof AgentError)) return false;
  return cause.code === 'LOCATOR_NOT_FOUND' || cause.code === 'LOCATOR_AMBIGUOUS';
}

async function locateAttempt<Value>(
  invocation: Invocation,
  target: string,
  options: LocateOptions & {
    point?: PointPolicy<Value>;
    poll: boolean;
    cache?: OpenLocateCache | undefined;
  },
): Promise<LocatedNode | Value> {
  const policy = options.point ?? NODE_ONLY;
  const selection = await observeAndSelect(invocation, target, { allowPoint: policy.allowed });
  if (selection.kind === 'point' && policy.allowed) {
    // Not recorded, and not by omission: a point is a screen coordinate, which
    // `cache-1` must never store. Keeping the write on the node branch makes
    // that structural rather than a check someone can forget.
    return policy.perform(invocation, acceptPoint(invocation, target, selection));
  }
  const located = await requireNode(invocation, target, selection, options);
  await options.cache?.record(located);
  return located;
}

/**
 * Resolves a selection that has to be a node.
 *
 * The pointed case restates the protocol rule "a point requires a caller that
 * asked for one" as a last line of defence: the grammar and the validator both
 * already gate on the same policy, so reaching it means those two drifted.
 */
async function requireNode(
  invocation: Invocation,
  target: string,
  selection: Selection,
  options: { testIdAttribute: string; poll?: boolean },
): Promise<LocatedNode> {
  switch (selection.kind) {
    case 'node':
      return resolveSelected(invocation, selection, options);
    case 'absent':
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        `the observation contains no node matching ${JSON.stringify(target)}`,
      );
    case 'none':
      invocation.note({ explanation: selection.explanation });
      throw new AgentError(
        'LOCATOR_NOT_FOUND',
        `the model found no node matching ${JSON.stringify(target)}: ${selection.explanation}`,
      );
    case 'point':
      throw new AgentError(
        'MODEL_OUTPUT_INVALID',
        `the model pointed at (${selection.point.x}, ${selection.point.y}) for ` +
          `${JSON.stringify(target)}, but this method acts on a semantic node`,
      );
  }
}

/** Records what the tree says is under a pointed selection, before dispatch. */
function acceptPoint(
  invocation: Invocation,
  target: string,
  selection: Extract<Selection, { kind: 'point' }>,
): LocatedPoint {
  const { point, hit, observation, explanation } = selection;
  invocation.note({
    explanation:
      `the model pointed at (${point.x}, ${point.y}) for ${JSON.stringify(target)}; the runner ` +
      `hit-tested ${hit === null ? 'no semantic node' : describeHit(hit)} there. ` +
      `The model explained: ${explanation}`,
  });
  return { kind: 'point', point, hit, observation, explanation };
}

/** Node identity recorded for a pointed action, per spec 13-reporting.md. */
function describeHit(node: SemanticNode): string {
  const name = normalize(node.name ?? node.text);
  const role = node.role ?? 'node';
  return name === '' ? `a ${role}` : `the ${role} ${JSON.stringify(name)}`;
}

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
        positional: selection.positional,
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
        `neither a derived query nor the observed reference resolved the selected node (${describe(
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
    () => `locate: no query separates ${describe(node)}; acting on its observed reference`,
  );
  return {
    kind: 'node',
    ref: selected.ref,
    expression: undefined,
    node,
    observation: selection.observation,
    explanation: selection.explanation,
    origin: 'model',
    positional: selection.positional,
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
    return rejected(`${description} -> resolved a different node (${describe(node)})`, false);
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
 * Bounded prefix used to re-find nodes whose names aggregate a whole card of
 * text. Long names diverge between accessible-name computation and rendered
 * text (image alts, badges), so a role-scoped text-content prefix filter is
 * the reliable signal; the identity signature still checks the full name.
 */
const NAME_PREFIX_LENGTH = 64;

/**
 * True when an observed field was cut at the driver contract's observation
 * bound (`OBSERVED_NAME_LIMIT` / `OBSERVED_TEXT_LIMIT`). Checked on the raw
 * value — normalization only shrinks — so every value below the limit is
 * provably complete. Truncated values are matched as substrings and compared
 * as prefixes.
 */
function truncatedAt(value: string | undefined, limit: number): boolean {
  return (value ?? '').length >= limit;
}

/**
 * Matches an observed-text prefix regardless of whitespace differences. The
 * observed name comes from rendered text, which inserts spaces at element
 * boundaries that raw text content does not have (and vice versa), so every
 * space matches any amount of whitespace including none. Case-insensitive
 * because rendering may also apply text transforms.
 */
function prefixPattern(value: string): RegExp {
  const escaped = value
    .slice(0, NAME_PREFIX_LENGTH)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s*');
  return new RegExp(escaped, 'i');
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
  const nameTruncated = truncatedAt(node.name, OBSERVED_NAME_LIMIT);
  const textTruncated = truncatedAt(node.text, OBSERVED_TEXT_LIMIT);
  const testId = node.attributes?.[testIdAttribute];
  const placeholder = node.attributes?.['placeholder'];

  if (role !== undefined && role !== '' && name !== '') {
    candidates.push(roleQuery(role as Role, { name, exact: !nameTruncated }, undefined));
    if (nameTruncated) {
      candidates.push(
        filterExpression(roleQuery(role as Role, undefined, undefined), {
          hasText: prefixPattern(name),
        }),
      );
    }
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
    candidates.push(textQuery('label', name, { exact: !nameTruncated }, undefined));
    candidates.push(textQuery('text', name, { exact: !nameTruncated }, undefined));
  }
  if (text !== '' && text !== name) {
    candidates.push(textQuery('text', text, { exact: !textTruncated }, undefined));
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
  if (observedName !== '') {
    const resolvedName = normalize(resolved.name);
    // A truncated observed name identifies its node by prefix; the re-read
    // node comes from an unbounded single-node read and carries the full name.
    return truncatedAt(observed.name, OBSERVED_NAME_LIMIT)
      ? resolvedName.startsWith(observedName)
      : resolvedName === observedName;
  }
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
