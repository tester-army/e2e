/**
 * Located-action tier (spec 02-test-api.md, 10-determinism.md).
 *
 * The model selects exactly one node from one fresh observation. The runner
 * derives portable semantic queries for that node, resolves them itself, and
 * requires a query that identifies the same single node before dispatching any
 * action. The model never supplies a selector, coordinate, or action.
 */

import { cacheMethodForApi } from '../cache/index.ts';
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
import { agentTrace } from '../internal/trace.ts';
import type { Role } from '../types.ts';
import { AgentError } from './error.ts';
import { Invocation, toAgentError } from './invocation.ts';
import { openLocateCache, type OpenLocateCache } from './locate-cache.ts';
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
  /** Whether a model chose this node or a cache entry replayed it. */
  readonly origin: 'model' | 'cache';
  /**
   * True when the instruction picked this node out by position rather than by
   * content, as reported by the model. Such a target is never recorded.
   */
  readonly positional: boolean;
}

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
 * Outcome of one model locate call. Modelled as a union rather than a nullable
 * node so the resolve path cannot be reached without a node, and so callers do
 * not have to re-check an invariant the selection already settled.
 */
type Selection = MatchedSelection | UnmatchedSelection;

interface MatchedSelection {
  readonly matched: true;
  readonly observation: AgentObservation;
  readonly node: SemanticNode;
  /** Why the node was selected. Untrusted prose. */
  readonly explanation: string;
  /** The model's report that the instruction identified this node by position. */
  readonly positional: boolean;
}

interface UnmatchedSelection {
  readonly matched: false;
  /** Why no node matches. Untrusted prose. */
  readonly explanation: string;
  /**
   * True when the model explicitly reported that no node matches, as opposed
   * to naming a node absent from the observation.
   */
  readonly declined: boolean;
}

/**
 * Asks the model to select one node from an observation the caller already
 * captured. Uses exactly one model call.
 */
async function selectFrom(
  invocation: Invocation,
  target: string,
  observation: AgentObservation,
): Promise<Selection> {
  const response = await invocation.ask({
    schemaName: 'agent-locate-1',
    schema: LOCATE_SCHEMA,
    validate: (value) => validateAgainstObservation(value, observation),
    prompt: { request: LOCATE_REQUEST, instruction: target, observation },
  });
  const explanation = response.explanation;
  if (response.target === null) {
    agentTrace(`locate ${JSON.stringify(target)}: model declined — ${explanation}`);
    return { matched: false, explanation, declined: true };
  }
  const node = observation.nodes.get(response.target.id);
  agentTrace(
    `locate ${JSON.stringify(target)}: model selected #${response.target.id} (${
      node === undefined ? 'not in observation' : describe(node)
    }) — ${explanation}`,
  );
  if (node === undefined) {
    invocation.recordPolicy('locate.node', 'denied', 'POLICY_DENIED');
    return { matched: false, explanation, declined: false };
  }
  return { matched: true, observation, node, explanation, positional: response.positional };
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
      issue: `target.id "${id}" is not in the current observation; use a node id exactly as printed after "#", e.g. "n42"`,
    };
  }
  return validation;
}

/**
 * Runs one locate under the cache protocol: observe the starting screen, try
 * to replay a stored locator against it, and otherwise fall back to `resolve`
 * and record whatever it produced.
 *
 * Every cacheable locate goes through here, so the replay/record pair cannot
 * drift apart and a caller cannot forget to write back. `resolve` receives the
 * starting observation, which the miss path needs anyway, so a hit costs one
 * observation and zero model calls.
 *
 * A stale entry never wins: any mismatch falls through to `resolve`, whose
 * result replaces the entry, so the entry costs one resolve and self-heals.
 */
async function locateCached(
  invocation: Invocation,
  target: string,
  options: LocateOptions,
  resolve: (starting: AgentObservation) => Promise<LocatedNode>,
): Promise<LocatedNode> {
  const starting = await invocation.observe();
  const cache = await openCacheFor(invocation, starting, target, options);
  const replayed = await cache?.replay();
  if (replayed !== undefined) return replayed;

  const located = await resolve(starting);
  await cache?.record(located);
  return located;
}

/** Selects one node and resolves it to a deterministic, unique locator. */
export function locateOne(
  invocation: Invocation,
  target: string,
  options: LocateOptions,
): Promise<LocatedNode> {
  return locateCached(invocation, target, options, async (observation) => {
    const selection = await selectFrom(invocation, target, observation);
    if (!selection.matched) throw unmatched(invocation, target, selection);
    return resolveSelected(invocation, selection, options);
  });
}

/** Turns a selection with no node into the locate failure that explains it. */
function unmatched(
  invocation: Invocation,
  target: string,
  selection: UnmatchedSelection,
): AgentError {
  if (!selection.declined) {
    return new AgentError(
      'LOCATOR_NOT_FOUND',
      `the observation contains no node matching ${JSON.stringify(target)}`,
    );
  }
  invocation.note({ explanation: selection.explanation });
  return new AgentError(
    'LOCATOR_NOT_FOUND',
    `the model found no node matching ${JSON.stringify(target)}: ${selection.explanation}`,
  );
}

/**
 * Locates one node, scrolling `direction` and re-observing until the model
 * finds it or the budget runs out.
 *
 * The cache is keyed on the screen before any scrolling, which is also the
 * screen round one examines: a hit therefore skips the scrolling entirely,
 * and a miss has already paid for the observation it needs.
 */
export function locateByScrolling(
  invocation: Invocation,
  target: string,
  options: LocateOptions,
  scroll: () => Promise<void>,
): Promise<LocatedNode> {
  return locateCached(invocation, target, options, async (starting) => {
    let observation = starting;
    let lastExplanation = '';
    for (let round = 1; ; round += 1) {
      invocation.recordPoll('scrollTo', round);
      const selection = await selectFrom(invocation, target, observation);
      if (selection.matched) return resolveSelected(invocation, selection, options);
      if (selection.declined) lastExplanation = selection.explanation;
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
      observation = await invocation.observe();
    }
  });
}

/**
 * Opens the cache for this call, or returns undefined when the method is not
 * cacheable. `cache-1` admits a closed set of methods, so a located action
 * outside it reports a bypass rather than inventing a key.
 */
function openCacheFor(
  invocation: Invocation,
  observation: AgentObservation,
  target: string,
  options: LocateOptions,
): Promise<OpenLocateCache | undefined> {
  const method = cacheMethodForApi(invocation.api);
  if (method === undefined) {
    return Promise.resolve(
      invocation.bypassCache(`${invocation.api} is not a cacheable cache-1 method`),
    );
  }
  return openLocateCache(invocation, observation, {
    method,
    instruction: target,
    input: options.input,
  });
}

/**
 * Resolves a selected observation node through the first derived query that
 * matches exactly one node with the same semantics.
 */
async function resolveSelected(
  invocation: Invocation,
  selection: MatchedSelection,
  options: LocateOptions,
): Promise<LocatedNode> {
  const candidates = deriveQueries(selection.node, options.testIdAttribute).map((query) =>
    scopeToFrames(query, selection.node.framePath),
  );
  if (candidates.length === 0) {
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      'the selected node exposes no role, name, test ID, placeholder, or text to address it portably',
    );
  }
  const engine = invocation.engine;
  let outcomes: string[] = [];

  for (;;) {
    // Outcomes are judged per sweep: a query that stopped matching several
    // nodes must not keep reporting LOCATOR_AMBIGUOUS from an earlier round.
    outcomes = [];
    let ambiguous = false;
    for (const expression of candidates) {
      let refs: readonly NodeRef[];
      try {
        // The invocation deadline bounds the sweep, so a caller-supplied
        // timeout is honored even while a driver error stays retryable.
        refs = await engine.resolveAll(expression, invocation.deadline);
      } catch (cause) {
        throw toAgentError(cause);
      }
      if (refs.length === 0) {
        outcomes.push(`${describeExpression(expression)} -> no matches`);
        continue;
      }
      if (refs.length > 1) {
        ambiguous = true;
        outcomes.push(`${describeExpression(expression)} -> ${refs.length} matches`);
        continue;
      }
      const ref = refs[0]!;
      let node: SemanticNode;
      try {
        node = await engine.session.screen.read(ref, invocation.operation());
      } catch {
        outcomes.push(`${describeExpression(expression)} -> matched node became unreadable`);
        continue;
      }
      if (!matchesSignature(selection.node, node)) {
        outcomes.push(
          `${describeExpression(expression)} -> resolved a different node (${describe(node)})`,
        );
        continue;
      }
      invocation.recordPolicy('locate.identity', 'allowed');
      agentTrace(`locate: resolved via ${describeExpression(expression)}`);
      return {
        ref,
        expression,
        node,
        observation: selection.observation,
        explanation: selection.explanation,
        origin: 'model',
        positional: selection.positional,
      };
    }

    agentTrace(`locate: sweep failed\n  ${outcomes.join('\n  ')}`);
    if (invocation.deadline.expired()) {
      invocation.recordPolicy('locate.identity', 'denied');
      // Each candidate's outcome names the exact query and why it was
      // rejected, so a locate failure explains itself.
      const detail = outcomes.map((outcome) => `\n  ${outcome}`).join('');
      throw new AgentError(
        ambiguous ? 'LOCATOR_AMBIGUOUS' : 'LOCATOR_NOT_FOUND',
        `no derived query uniquely resolved the selected node (${describe(selection.node)}):${detail}`,
      );
    }
    await sleep(POLL_INTERVAL_MS, engine.signal);
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
 * Observed names and texts at or beyond this length may have been truncated by
 * the driver's observation bound, which driver-1 does not signal. Such values
 * are matched as substrings and compared as prefixes: for a complete value the
 * relaxed match still holds, so the fallback is safe in both cases.
 */
const POSSIBLY_TRUNCATED_LENGTH = 200;

/**
 * Bounded prefix used to re-find nodes whose names aggregate a whole card of
 * text. Long names diverge between accessible-name computation and rendered
 * text (image alts, badges), so a role-scoped text-content prefix filter is
 * the reliable signal; the identity signature still checks the full name.
 */
const NAME_PREFIX_LENGTH = 64;

function possiblyTruncated(value: string): boolean {
  return value.length >= POSSIBLY_TRUNCATED_LENGTH;
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
  const testId = node.attributes?.[testIdAttribute];
  const placeholder = node.attributes?.['placeholder'];

  if (role !== undefined && role !== '' && name !== '') {
    candidates.push(
      roleQuery(role as Role, { name, exact: !possiblyTruncated(name) }, undefined),
    );
    if (possiblyTruncated(name)) {
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
    candidates.push(textQuery('label', name, { exact: !possiblyTruncated(name) }, undefined));
    candidates.push(textQuery('text', name, { exact: !possiblyTruncated(name) }, undefined));
  }
  if (text !== '' && text !== name) {
    candidates.push(textQuery('text', text, { exact: !possiblyTruncated(text) }, undefined));
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
    // A possibly-truncated observed name identifies its node by prefix; the
    // re-read node carries the full name.
    return possiblyTruncated(observedName)
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
