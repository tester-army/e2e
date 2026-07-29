/**
 * Locate replay orchestration (spec 10-determinism.md "Locate replay").
 *
 * A hit resolves a stored semantic locator once and requires exactly one
 * compatible node. Zero, multiple, stale, or incompatible results are a miss
 * and permit one fresh model locate, whose result atomically replaces the
 * entry. The action that follows a hit still goes through normal actionability
 * and origin policy, so a poisoned or stale entry can never do more than waste
 * one resolve.
 */

import {
  buildCacheKey,
  cacheCallSignature,
  cacheKeyHash,
  screenFingerprint,
  asCacheLocator,
  toSemanticIdentity,
  type CacheKey,
  type CacheMethod,
  type SemanticIdentity,
} from '../cache/index.ts';
import type { SemanticNode } from '../driver/index.ts';
import { describeExpression } from '../locator/expression.ts';
import { errorMessage } from '../internal/errors.ts';
import { normalizeText } from '../internal/text.ts';
import { agentTrace } from '../internal/trace.ts';
import type { AgentObservation } from './observation.ts';
import type { AgentCacheContext, Invocation } from './invocation.ts';
import type { LocatedNode } from './locate.ts';

/** Inputs that identify one locate call beyond its instruction. */
export interface LocateCacheParams {
  readonly method: CacheMethod;
  readonly instruction: string;
  /** Non-secret call parameters; a secret contributes only its name and purpose. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface OpenLocateCache {
  readonly key: CacheKey;
  readonly keyHash: string;
  /** Resolves the stored locator, or undefined on any mismatch. */
  replay(): Promise<LocatedNode | undefined>;
  /** Stores a freshly resolved locator, replacing any existing entry. */
  record(located: LocatedNode): Promise<void>;
}

/**
 * Prepares the cache for one locate call. Returns undefined when the call is
 * not cacheable, which the caller reports as a bypass. Requires the fresh
 * observation the miss path needs anyway, so a hit costs one observation and
 * zero model calls.
 */
export async function openLocateCache(
  invocation: Invocation,
  observation: AgentObservation,
  params: LocateCacheParams,
): Promise<OpenLocateCache | undefined> {
  const context = invocation.cacheContext;

  // Order matters and is therefore explicit: the occurrence index is consumed
  // once per cacheable call that gets this far, so a bypassed or non-cacheable
  // call must never take a number.
  const signature = cacheCallSignature(params.method, params.instruction, params.input);
  const callIndex = context.nextCallIndex(signature);
  const fingerprint = screenFingerprint({
    viewport: observation.viewport,
    url: await currentUrl(invocation),
    redact: observation.redact,
  });

  const key = buildCacheKey({
    project: context.project,
    testId: context.testId,
    target: context.target,
    signature,
    callIndex,
    screenFingerprint: fingerprint,
    policyVersion: context.policyVersion,
  });
  const keyHash = cacheKeyHash(key);

  return {
    key,
    keyHash,
    replay: () => replay(invocation, context, observation, key, keyHash),
    record: (located) => record(invocation, context, key, keyHash, located),
  };
}

function replay(
  invocation: Invocation,
  context: AgentCacheContext,
  observation: AgentObservation,
  key: CacheKey,
  keyHash: string,
): Promise<LocatedNode | undefined> {
  return invocation.cacheReplay(() => consult(invocation, context, observation, key, keyHash));
}

async function consult(
  invocation: Invocation,
  context: AgentCacheContext,
  observation: AgentObservation,
  key: CacheKey,
  keyHash: string,
): Promise<LocatedNode | undefined> {
  const result = await context.store.read(keyHash);
  if (result.status === 'invalid') {
    invocation.setCache({
      status: 'invalid',
      keyHash,
      reason: result.reason,
      ...bytesOf(result.bytes),
    });
    invocation.recordPolicy('cache.entry', 'denied', 'CACHE_INVALID');
    agentTrace(() => `cache: ignored invalid entry ${keyHash.slice(0, 12)} — ${result.reason}`);
    return undefined;
  }
  if (result.status === 'miss') {
    invocation.setCache({ status: 'miss', keyHash, reason: 'no entry for this key' });
    return undefined;
  }

  const miss = (reason: string): undefined => {
    invocation.setCache({ status: 'miss', keyHash, bytes: result.bytes, reason });
    agentTrace(() => `cache: miss on ${keyHash.slice(0, 12)} — ${reason}`);
    return undefined;
  };

  const locator = result.entry.payload.locator;
  let refs;
  try {
    // Resolved once with no polling: a stale entry must not spend the caller's
    // timeout before the fresh locate that will replace it.
    refs = await invocation.engine.resolveAll(locator, invocation.deadline);
  } catch (cause) {
    return miss(`the stored locator failed to resolve: ${errorMessage(cause)}`);
  }
  if (refs.length !== 1) return miss(`the stored locator matched ${refs.length} nodes`);

  const ref = refs[0]!;
  let node: SemanticNode;
  try {
    node = await invocation.session.screen.read(ref, invocation.operation());
  } catch {
    return miss('the matched node became unreadable');
  }
  if (!matchesIdentity(result.entry.payload.expected, node)) {
    return miss(`the matched node is ${describe(node)}, not the recorded identity`);
  }

  invocation.setCache({
    status: 'hit',
    keyHash,
    bytes: result.bytes,
    reason: `replayed ${describeExpression(locator)} to ${describe(node)}`,
  });
  invocation.recordPolicy('cache.entry', 'allowed');
  agentTrace(() => `cache: hit ${keyHash.slice(0, 12)} (${describe(node)})`);
  // A replayed target is content-addressed by construction: a positional one is
  // never recorded, so there is nothing positional to replay.
  return {
    kind: 'node',
    ref,
    expression: locator,
    node,
    observation,
    explanation: '',
    origin: 'cache',
    positional: false,
  };
}

async function record(
  invocation: Invocation,
  context: AgentCacheContext,
  key: CacheKey,
  keyHash: string,
  located: LocatedNode,
): Promise<void> {
  const store = context.store;
  if (!store.writable) return notRecorded(invocation, keyHash, 'the cache is read-only');

  // A positional target is deliberately not recorded. The locator would be
  // content-addressed, so replaying it would keep finding the item that was in
  // that position when it was recorded rather than whatever is there now — a
  // wrong answer, not a miss, which the cache is never allowed to produce.
  if (located.positional) {
    return notRecorded(
      invocation,
      keyHash,
      'the instruction targets a position, so a stored locator could drift to the wrong item',
    );
  }

  const locator = asCacheLocator(located.expression);
  if (locator === undefined) {
    return notRecorded(invocation, keyHash, 'the locator is not a portable semantic query');
  }
  const expected = toSemanticIdentity(located.node);
  if (expected === undefined) {
    return notRecorded(invocation, keyHash, 'the node exposes no role to identify it by');
  }
  try {
    const written = await store.write(keyHash, { locator, expected });
    if (written === undefined) {
      notRecorded(invocation, keyHash, 'the entry exceeded the cache byte limit');
      return;
    }
    invocation.mergeCache({
      status: 'written',
      keyHash,
      bytes: written.bytes,
      reason: `recorded ${describeExpression(locator)}`,
    });
    agentTrace(() => `cache: wrote ${keyHash.slice(0, 12)} (${written.bytes}B)`);
  } catch (cause) {
    // A cache write is never authority, so losing one must not fail a passing
    // test. The step keeps its miss status and the next run tries again.
    notRecorded(invocation, keyHash, `the write failed: ${errorMessage(cause)}`);
  }
}

/**
 * Keeps the step's existing status but explains why nothing was stored, so a
 * run that never warms up says why instead of just reporting a miss forever.
 */
function notRecorded(invocation: Invocation, keyHash: string, reason: string): undefined {
  invocation.mergeCache({ reason: `not recorded: ${reason}` });
  agentTrace(() => `cache: not recording ${keyHash.slice(0, 12)} — ${reason}`);
  return undefined;
}

/**
 * Compares a replayed node with the recorded identity. Role and name determine
 * identity; recorded states are informational, because a node whose checked or
 * disabled state changed is still the same node, and actionability re-checks
 * the states that matter before the action runs.
 */
function matchesIdentity(expected: SemanticIdentity, node: SemanticNode): boolean {
  if (node.role !== expected.role) return false;
  if (expected.name === undefined) return true;
  return normalize(node.name) === expected.name;
}

/** Reads the current top-level URL, or undefined for a driver exposing none. */
async function currentUrl(invocation: Invocation): Promise<string | undefined> {
  const web = invocation.session.web;
  if (web === undefined) return undefined;
  try {
    return await web.url(invocation.operation());
  } catch {
    return undefined;
  }
}

function bytesOf(bytes: number | undefined): { bytes?: number } {
  return bytes === undefined ? {} : { bytes };
}

function describe(node: SemanticNode): string {
  return `role=${node.role ?? 'none'} name=${JSON.stringify(normalize(node.name))}`;
}

function normalize(value: string | undefined): string {
  return value === undefined ? '' : normalizeText(value);
}
