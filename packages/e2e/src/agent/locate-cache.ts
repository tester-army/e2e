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
  cacheKeyHash,
  cacheKeysEqual,
  screenFingerprint,
  toCacheLocator,
  toSemanticIdentity,
  type CacheKey,
  type CacheMethod,
  type SemanticIdentity,
} from '../cache/index.ts';
import type { SemanticNode } from '../driver/index.ts';
import { agentTrace } from '../internal/trace.ts';
import { createRedactor, type AgentObservation } from './observation.ts';
import type { Invocation } from './invocation.ts';
import type { LocatedNode } from './locate.ts';

/** Inputs that identify one locate call beyond its instruction. */
export interface LocateCacheParams {
  readonly method: CacheMethod;
  readonly instruction: string;
  /** Non-secret call parameters; a secret contributes only its name and purpose. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly testIdAttribute: string;
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
  const context = invocation.cache;
  if (context === undefined || !context.enabled || !invocation.cacheAllowed) return undefined;

  const key = buildCacheKey({
    project: context.project,
    testId: context.testId,
    target: context.target,
    method: params.method,
    callIndex: invocation.callIndex,
    instruction: params.instruction,
    input: params.input,
    screenFingerprint: screenFingerprint({
      tree: observation.tree,
      viewport: observation.viewport,
      url: await currentUrl(invocation),
      redact: createRedactor(invocation.secretValues),
      testIdAttribute: params.testIdAttribute,
    }),
    policyVersion: context.policyVersion,
  });
  const keyHash = cacheKeyHash(key);

  return {
    key,
    keyHash,
    replay: () => replay(invocation, observation, key, keyHash),
    record: (located) => record(invocation, key, keyHash, located),
  };
}

async function replay(
  invocation: Invocation,
  observation: AgentObservation,
  key: CacheKey,
  keyHash: string,
): Promise<LocatedNode | undefined> {
  const result = await invocation.cache!.store.read(keyHash);
  if (result.status === 'invalid') {
    invocation.setCache({ status: 'invalid', keyHash, ...bytesOf(result.bytes) });
    invocation.recordPolicy('cache.entry', 'denied', 'CACHE_INVALID');
    agentTrace(`cache: ignored invalid entry ${keyHash.slice(0, 12)} — ${result.reason}`);
    return undefined;
  }
  if (result.status === 'miss') {
    invocation.setCache({ status: 'miss', keyHash });
    return undefined;
  }

  const miss = (reason: string): undefined => {
    invocation.setCache({ status: 'miss', keyHash, bytes: result.bytes });
    agentTrace(`cache: miss on ${keyHash.slice(0, 12)} — ${reason}`);
    return undefined;
  };

  // The file name already implies the digest, but comparing the whole key is
  // what actually authorizes replay: an offline semantic check alone must not.
  if (!cacheKeysEqual(result.entry.key, key)) return miss('the stored key differs');

  const locator = result.entry.payload.locator;
  let refs;
  try {
    // Resolved once with no polling: a stale entry must not spend the caller's
    // timeout before the fresh locate that will replace it.
    refs = await invocation.engine.resolveAll(locator, invocation.deadline);
  } catch (cause) {
    return miss(`the stored locator failed to resolve: ${message(cause)}`);
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

  invocation.setCache({ status: 'hit', keyHash, bytes: result.bytes });
  invocation.recordPolicy('cache.entry', 'allowed');
  agentTrace(`cache: hit ${keyHash.slice(0, 12)} (${describe(node)})`);
  return { ref, expression: locator, node, observation, explanation: '', origin: 'cache' };
}

async function record(
  invocation: Invocation,
  key: CacheKey,
  keyHash: string,
  located: LocatedNode,
): Promise<void> {
  const store = invocation.cache!.store;
  if (!store.writable) return;

  const locator = toCacheLocator(located.expression);
  if (!locator.ok) {
    agentTrace(`cache: not recording ${keyHash.slice(0, 12)} — ${locator.reason}`);
    return;
  }
  const expected = toSemanticIdentity(located.node);
  if (!expected.ok) {
    agentTrace(`cache: not recording ${keyHash.slice(0, 12)} — ${expected.reason}`);
    return;
  }
  try {
    const written = await store.write(key, {
      type: 'locate',
      locator: locator.value,
      expected: expected.value,
    });
    if (written !== undefined) {
      invocation.setCache({ status: 'written', keyHash, bytes: written.bytes });
      agentTrace(`cache: wrote ${keyHash.slice(0, 12)} (${written.bytes}B)`);
    }
  } catch (cause) {
    // A cache write is never authority, so losing one must not fail a passing
    // test. The step keeps its miss status and the next run tries again.
    agentTrace(`cache: write failed for ${keyHash.slice(0, 12)} — ${message(cause)}`);
  }
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
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
