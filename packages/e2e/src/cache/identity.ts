/**
 * Trace cache key identity.
 *
 * A key names the exact context a trace was recorded in. Every field that can
 * change replay behavior is part of the key, so a stale entry can only ever be
 * a miss rather than a wrong answer. Secret values never enter a key: a secret
 * contributes only its stable name and purpose, exactly as the executor sees
 * it in the projected params.
 *
 * The agent a step runs with is part of the key: its configured name, since
 * two agents of one test (`agent: ['buyer', 'admin']`) act as different
 * people, and a digest of the context it reads, since a test's
 * `agentContext` decides what the step does. The context is digested after
 * redaction, so a registered secret in it contributes its name only. The
 * executor that produced a trace stays provenance on the entry: the agent's
 * name already keeps two configured agents apart.
 *
 * The engine's package version is not part of the key. Its name and SPI
 * version are: another engine, or another contract, is another context. A
 * release of the same engine is not, since a recording's actions re-find
 * their nodes against a fresh observation at replay and a node an engine
 * release resolves differently misses then (`relocate.ts`). Keying on the
 * version cold-started every committed recording on each release, which
 * under `cache.strict` failed every step as `REPLAY_STALE` until it was
 * re-recorded, for engines that had not changed how a node resolves.
 */

import { canonicalDigest, sha256Hex } from '../internal/ids.ts';
import type { JsonValue } from '../types.ts';
import { KEY_CONTEXT_FIELDS, TRACE_SCHEMA_VERSION, type TraceKeyContext } from './trace.ts';

/**
 * Step kinds the trace cache admits. Only `act` today: an assert must not
 * change state, so its trace would be action-free, and judgments are made
 * fresh per run by normative rule (spec 10).
 */
export type TraceCacheKind = 'act';

export interface TraceCacheKey {
  readonly specVersion: '0.1';
  readonly cacheSchema: typeof TRACE_SCHEMA_VERSION;
  /** SHA-256 of the resolved `projectId`. */
  readonly project: string;
  readonly testId: string;
  readonly targetId: string;
  readonly platform: string;
  readonly engineName: string;
  readonly engineSpiVersion: number;
  readonly kind: TraceCacheKind;
  /** Zero-based occurrence of this signature within the attempt. */
  readonly callIndex: number;
  readonly instructionDigest: string;
  readonly paramsDigest: string;
  readonly appIdentity: string;
  /** Name of the configured agent the step ran with. */
  readonly agent: string;
  /** SHA-256 of the agent's redacted context (its `context` then the test's `agentContext`), or of the empty string. */
  readonly agentContextDigest: string;
  readonly policyVersion: string;
}

/** The agent a step runs with, as the key sees it. */
export interface CacheAgentIdentity {
  readonly name: string;
  /** The context the agent reads, already redacted. */
  readonly context: string | undefined;
}

/** Identity of the target/engine/app a trace was recorded against. */
export interface CacheTargetIdentity {
  readonly targetId: string;
  readonly platform: string;
  readonly engineName: string;
  readonly spiVersion: number;
  readonly appIdentity: string;
}

/**
 * Normalizes one instruction before digesting it: CRLF/CR become LF, the text
 * is NFC-normalized, and leading/trailing Unicode whitespace is trimmed.
 * Interior whitespace is preserved, because it can be semantically meaningful.
 */
export function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\r\n?/gu, '\n').normalize('NFC').trim();
}

/** SHA-256 of the normalized instruction. */
export function instructionDigest(instruction: string): string {
  return sha256Hex(normalizeInstruction(instruction));
}

/**
 * SHA-256/JCS of the projected (secret-free) call parameters. A missing params
 * object digests as the empty object, so `act(x)` and `act(x, {})` share one
 * entry.
 */
export function paramsDigest(params: Readonly<Record<string, JsonValue>> | undefined): string {
  return canonicalDigest(params ?? {});
}

/** SHA-256 of the resolved project identity. */
export function projectIdentity(projectId: string): string {
  return sha256Hex(projectId);
}

/**
 * What a step asks for, independent of where it sits in the test: the kind
 * plus the digests of its instruction and projected parameters.
 *
 * Two steps sharing a signature are the same request, so this is the scope the
 * occurrence index counts within. Scoping it any wider — counting every agent
 * step in the test — would make an unrelated step appearing or disappearing
 * renumber every entry after it, which is exactly what a conditional flow like
 * an optional cookie dialog does on a real site.
 */
export interface TraceCallSignature {
  readonly kind: TraceCacheKind;
  readonly instructionDigest: string;
  readonly paramsDigest: string;
}

/** Builds one signature by digesting the instruction and projected parameters. */
export function traceCallSignature(
  kind: TraceCacheKind,
  instruction: string,
  params: Readonly<Record<string, JsonValue>> | undefined,
): TraceCallSignature {
  return {
    kind,
    instructionDigest: instructionDigest(instruction),
    paramsDigest: paramsDigest(params),
  };
}

/**
 * Map key for one signature. Both digests are hex, so a colon cannot appear
 * inside either and the join is unambiguous.
 */
function traceCallSignatureKey(signature: TraceCallSignature): string {
  return `${signature.kind}:${signature.instructionDigest}:${signature.paramsDigest}`;
}

/**
 * Counts occurrences of each call signature within one attempt, returning the
 * zero-based index of each step among its own repeats. Per signature rather
 * than per attempt on purpose: only a genuine repeat of the same request
 * advances the number.
 */
export function createCallIndexer(): (signature: TraceCallSignature) => number {
  const seen = new Map<string, number>();
  return (signature) => {
    const mapKey = traceCallSignatureKey(signature);
    const count = seen.get(mapKey) ?? 0;
    seen.set(mapKey, count + 1);
    return count;
  };
}

/**
 * Assembles one key. Field order is irrelevant to the digest, since JCS sorts
 * keys, but the explicit shape keeps every required field accounted for.
 */
export function buildTraceCacheKey(parts: {
  readonly project: string;
  readonly testId: string;
  readonly target: CacheTargetIdentity;
  readonly signature: TraceCallSignature;
  readonly callIndex: number;
  readonly agent: CacheAgentIdentity;
  readonly policyVersion: string;
}): TraceCacheKey {
  return {
    specVersion: '0.1',
    cacheSchema: TRACE_SCHEMA_VERSION,
    project: parts.project,
    testId: parts.testId,
    targetId: parts.target.targetId,
    platform: parts.target.platform,
    engineName: parts.target.engineName,
    engineSpiVersion: parts.target.spiVersion,
    kind: parts.signature.kind,
    callIndex: parts.callIndex,
    instructionDigest: parts.signature.instructionDigest,
    paramsDigest: parts.signature.paramsDigest,
    appIdentity: parts.target.appIdentity,
    agent: parts.agent.name,
    agentContextDigest: sha256Hex(parts.agent.context ?? ''),
    policyVersion: parts.policyVersion,
  };
}

/** SHA-256/JCS of one key, used as both the entry digest and its file name. */
export function traceCacheKeyHash(key: TraceCacheKey): string {
  return canonicalDigest(key);
}

/** The parts of a key outside the step's own identity, as an entry records them (`ActionTrace.keyedBy`). */
export function keyContext(key: TraceKeyContext): TraceKeyContext {
  return Object.fromEntries(KEY_CONTEXT_FIELDS.map((field) => [field, key[field]])) as TraceKeyContext;
}

/** How each part of a key's context reads in a sentence, and whether its value means anything to a reader. */
const KEY_CONTEXT_WORDS: Readonly<Record<keyof TraceKeyContext, { readonly name: string; readonly shown: boolean }>> = {
  cacheSchema: { name: 'the cache format', shown: true },
  policyVersion: { name: 'the replay policy', shown: true },
  project: { name: 'the projectId', shown: false },
  platform: { name: 'the platform', shown: true },
  engineName: { name: 'the engine', shown: true },
  engineSpiVersion: { name: 'the engine contract', shown: true },
  appIdentity: { name: "the app's identity (app.identity, else its URL) or environment", shown: false },
  agentContextDigest: { name: "the agent's context (its context, or the test's agentContext)", shown: false },
};

/**
 * What differs between the context an entry was recorded under and this
 * run's: `the engine contract (1 -> 2)`, `the app's identity ...`. Empty
 * when nothing differs or the entry recorded no context.
 */
export function keyContextChanges(recorded: TraceKeyContext | undefined, now: TraceKeyContext): string[] {
  if (recorded === undefined) return [];
  return KEY_CONTEXT_FIELDS.flatMap((field) => {
    if (recorded[field] === now[field]) return [];
    const { name, shown } = KEY_CONTEXT_WORDS[field];
    return [shown ? `${name} (${String(recorded[field])} -> ${String(now[field])})` : name];
  });
}
