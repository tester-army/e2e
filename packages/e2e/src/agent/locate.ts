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
import type { AgentObservation, AgentPixels } from './observation.ts';
import {
  isNodeTarget,
  LOCATE_SCHEMA,
  LOCATE_VISION_SCHEMA,
  validateLocateResponse,
  type LocateResponse,
  type ProtocolValidation,
} from './protocol.ts';
import { LOCATE_REQUEST, LOCATE_VISION_REQUEST } from './prompts.ts';

export interface LocatedNode {
  readonly kind: 'node';
  readonly ref: NodeRef;
  readonly expression: LocatorExpression;
  /** Freshly read node behind the derived query. */
  readonly node: SemanticNode;
  readonly observation: AgentObservation;
  /** Model-reported reason for the selection. Untrusted prose. */
  readonly explanation: string;
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

export interface Selection {
  readonly observation: AgentObservation;
  /** Null when the model declined, pointed, or named an absent node. */
  readonly selected: SemanticNode | null;
  /** Set when the model answered with a screenshot point instead of a node. */
  readonly point: ViewportPoint | null;
  /** Innermost observed node under `point`, for the audit record. */
  readonly hit: SemanticNode | null;
  /** Why the node was selected, or why no node matches. Untrusted prose. */
  readonly explanation: string;
  /** True when the model explicitly reported that no node matches. */
  readonly declined: boolean;
}

/**
 * Takes one fresh observation and asks the model to select one node, or, when
 * pixels reached the request, one point. Uses exactly one model call.
 */
export async function observeAndSelect(
  invocation: Invocation,
  target: string,
): Promise<Selection> {
  const observation = await invocation.observe();
  // Pointing is offered only when pixels actually became model input. A vision
  // call degraded to tree-only input (taint, unprovable masking, a driver
  // without pixels) falls back to the semantic grammar, so the model is never
  // invited to point at an image it cannot see.
  const grounded = observation.pixels !== undefined;
  const response = await invocation.ask({
    schemaName: 'agent-locate-1',
    schema: grounded ? LOCATE_VISION_SCHEMA : LOCATE_SCHEMA,
    validate: (value) => validateAgainstObservation(value, observation, grounded),
    prompt: {
      request: grounded ? LOCATE_VISION_REQUEST : LOCATE_REQUEST,
      instruction: target,
      observation,
    },
  });
  const explanation = response.explanation;
  const base = { observation, explanation };
  if (response.target === null) {
    agentTrace(() => `locate ${JSON.stringify(target)}: model declined — ${explanation}`);
    return { ...base, selected: null, point: null, hit: null, declined: true };
  }
  if (!isNodeTarget(response.target)) {
    // Validation bounded the answer in image space; actions and node rects live
    // in CSS pixels, so the conversion happens exactly once, here.
    const point = toViewportPoint(observation.pixels!, response.target.point);
    const hit = hitTest(observation, point);
    invocation.recordPolicy('locate.point', 'allowed');
    agentTrace(
      () =>
        `locate ${JSON.stringify(target)}: model pointed at (${point.x}, ${point.y}) (${
          hit === null ? 'no semantic node there' : describe(hit)
        }) — ${explanation}`,
    );
    return { ...base, selected: null, point, hit, declined: false };
  }
  const targetId = response.target.id;
  const selected = observation.nodes.get(targetId) ?? null;
  if (selected === null) invocation.recordPolicy('locate.node', 'denied', 'POLICY_DENIED');
  agentTrace(
    () =>
      `locate ${JSON.stringify(target)}: model selected #${targetId} (${
        selected === null ? 'not in observation' : describe(selected)
      }) — ${explanation}`,
  );
  return { ...base, selected, point: null, hit: null, declined: false };
}

/**
 * Protocol validation plus observation grounding. A response naming a node id,
 * a revision, or a point outside the current observation violates "never
 * invent identifiers" and is invalid output, so the ask() repair loop can
 * correct one bad reference while the model-call budget allows.
 */
function validateAgainstObservation(
  value: unknown,
  observation: AgentObservation,
  allowPoint: boolean,
): ProtocolValidation<LocateResponse> {
  const validation = validateLocateResponse(value, { allowPoint });
  if (!validation.ok || validation.value.target === null) return validation;
  const target = validation.value.target;
  if (target.revision !== observation.revision) {
    return {
      ok: false,
      issue: `target.revision "${target.revision}" is stale; answer for the current observation revision "${observation.revision}"`,
    };
  }
  if (!isNodeTarget(target)) {
    const pixels = observation.pixels;
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
    return validation;
  }
  if (!observation.nodes.has(target.id)) {
    return {
      ok: false,
      issue: `target.id "${target.id}" is not in the current observation; use a node id exactly as printed after "#", e.g. "n42"`,
    };
  }
  return validation;
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
    if (point.x < rect.x || point.x > rect.x + rect.width) continue;
    if (point.y < rect.y || point.y > rect.y + rect.height) continue;
    const area = rect.width * rect.height;
    if (area >= bestArea) continue;
    best = node;
    bestArea = area;
  }
  return best;
}

/**
 * Selects one node and resolves it to a deterministic, unique locator.
 *
 * `allowPoint` is the caller's answer to "can this method act on a bare
 * coordinate?". Only a plain tap can; every other method needs a node
 * reference to hand the driver, so a point there is a miss, not a fallback.
 */
export function locateOne(
  invocation: Invocation,
  target: string,
  options: { testIdAttribute: string; allowPoint?: false },
): Promise<LocatedNode>;
export function locateOne(
  invocation: Invocation,
  target: string,
  options: { testIdAttribute: string; allowPoint: boolean },
): Promise<Located>;
export async function locateOne(
  invocation: Invocation,
  target: string,
  options: { testIdAttribute: string; allowPoint?: boolean },
): Promise<Located> {
  const selection = await observeAndSelect(invocation, target);
  if (selection.declined) {
    invocation.note({ explanation: selection.explanation });
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      `the model found no node matching ${JSON.stringify(target)}: ${selection.explanation}`,
    );
  }
  if (selection.point !== null) {
    return locatePoint(invocation, target, selection, selection.point, options.allowPoint === true);
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

/** Accepts one pointed selection, recording what the tree says is under it. */
function locatePoint(
  invocation: Invocation,
  target: string,
  selection: Selection,
  point: ViewportPoint,
  allowPoint: boolean,
): LocatedPoint {
  const where = `(${point.x}, ${point.y})`;
  if (!allowPoint) {
    invocation.note({ explanation: selection.explanation });
    throw new AgentError(
      'LOCATOR_NOT_FOUND',
      `the model pointed at ${where} for ${JSON.stringify(target)} instead of naming a node, ` +
        'but this method acts on a semantic node; the model explained: ' +
        selection.explanation,
    );
  }
  const hit = selection.hit;
  invocation.note({
    explanation:
      `the model pointed at ${where} for ${JSON.stringify(target)}; the runner hit-tested ` +
      `${hit === null ? 'no semantic node' : describeHit(hit)} there. The model explained: ` +
      selection.explanation,
  });
  return {
    kind: 'point',
    point,
    hit,
    observation: selection.observation,
    explanation: selection.explanation,
  };
}

/** Node identity recorded for a pointed action, per spec 13-reporting.md. */
function describeHit(node: SemanticNode): string {
  const name = normalize(node.name ?? node.text);
  const role = node.role ?? 'node';
  return name === '' ? `a ${role}` : `the ${role} ${JSON.stringify(name)}`;
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
      if (!matchesSignature(selection.selected, node)) {
        outcomes.push(
          `${describeExpression(expression)} -> resolved a different node (${describe(node)})`,
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
        explanation: selection.explanation ?? '',
      };
    }

    agentTrace(() => `locate: sweep failed\n  ${outcomes.join('\n  ')}`);
    if (invocation.deadline.expired()) {
      invocation.recordPolicy('locate.identity', 'denied');
      // Each candidate's outcome names the exact query and why it was
      // rejected, so a locate failure explains itself.
      const detail = outcomes.map((outcome) => `\n  ${outcome}`).join('');
      throw new AgentError(
        ambiguous ? 'LOCATOR_AMBIGUOUS' : 'LOCATOR_NOT_FOUND',
        `no derived query uniquely resolved the selected node (${describe(selection.selected)}):${detail}`,
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
