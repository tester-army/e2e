/**
 * Path guidance for the planning tier (spec 10-determinism.md "Path guidance").
 *
 * Guidance is advisory, not replay. A recorded path is offered to the model as
 * the route that worked last time; the model still receives a fresh observation
 * every round and still chooses. So a stale path costs a discarded suggestion,
 * not a wrong action — which is why a recorded action carries a semantic locator
 * and no identity to check it against.
 *
 * The model choosing differently is therefore a normal outcome, not a failure:
 * the guidance is dropped and the invocation reasons on. It is never
 * `CACHE_REPLAY_DIVERGED`. That code belongs to an implementation that dispatches
 * recorded actions without asking, where a broken replay can leave a flow
 * half-applied and restarting would re-apply it — which is what
 * 10-determinism.md's "MUST NOT restart or replay from the beginning" is
 * guarding. Nothing here ever replays, so the hazard cannot arise, and treating a
 * declined suggestion as that failure made the cache turn passing tests red on
 * any page whose content moves between runs.
 */

import {
  buildCacheKey,
  cacheCallSignature,
  cacheKeyHash,
  screenFingerprint,
  MAX_PATH_ACTIONS,
  type CacheKey,
  type PathAction,
} from '../cache/index.ts';
import { errorMessage } from '../internal/errors.ts';
import { stableStringify } from '../internal/json.ts';
import { agentTrace } from '../internal/trace.ts';
import type { AgentCacheContext, Invocation } from './invocation.ts';
import type { AgentObservation } from './observation.ts';

/** Inputs that identify one `act` call beyond its instruction. */
export interface PathCacheParams {
  readonly instruction: string;
  /** Non-secret parameters; a secret contributes only its name and purpose. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** Guidance for one `act` invocation, plus the recorder for its own path. */
export interface OpenPathCache {
  readonly key: CacheKey;
  readonly keyHash: string;
  /** The next recorded action to suggest, or undefined once guidance is gone. */
  next(): PathAction | undefined;
  /** Drops the remaining guidance when the model chose something else. */
  reconcile(proposed: PathAction | undefined): void;
  /** Notes that an action committed, which records it and advances the guidance. */
  committed(action: PathAction | undefined): void;
  /** Stores the path of a fully successful invocation. */
  write(): Promise<void>;
}

/**
 * Prepares path guidance for one `act` call. Returns undefined when the call
 * cannot be cached, which the caller reports as a bypass.
 *
 * Takes the first observation because the cache key is screen-scoped: the same
 * instruction on a different screen is a different call, and keying it otherwise
 * would offer a checkout path to a settings page.
 */
export async function openPathCache(
  invocation: Invocation,
  observation: AgentObservation,
  params: PathCacheParams,
): Promise<OpenPathCache | undefined> {
  const context = invocation.cacheContext;
  const bypass = invocation.cacheBypass;
  if (bypass !== undefined) return invocation.bypassCache('path', bypass);

  // Order matters and is therefore explicit: the occurrence index is consumed
  // once per cacheable call that gets this far, so a bypassed call never takes
  // a number.
  const signature = cacheCallSignature('act', params.instruction, params.input);
  const callIndex = context.nextCallIndex(signature);
  const key = buildCacheKey({
    project: context.project,
    testId: context.testId,
    target: context.target,
    signature,
    callIndex,
    screenFingerprint: screenFingerprint({
      viewport: observation.viewport,
      url: await currentUrl(invocation),
      base: invocation.appBase,
    }),
    policyVersion: context.policyVersion,
  });
  const keyHash = cacheKeyHash(key);

  const guidance = await invocation.cacheReplay(() => read(invocation, context, keyHash));
  return new PathCache(invocation, context, key, keyHash, guidance);
}

/**
 * Where one invocation is along a recorded route.
 *
 * Separate from the store and report plumbing below because the two obey
 * different rules and conflating them is what produced the bug this shape now
 * makes hard to write: *agreeing* with the recorded step (`reconcile`) and
 * *taking* it (`advance`) are different events, and only the second one moves.
 *
 * Advancing on agreement offered the next round step N+1 after step N had failed
 * to dispatch, which guided the model straight past the one thing it had just
 * been unable to do.
 */
export class Guidance {
  private cursor = 0;
  private actions: readonly PathAction[] | undefined;

  constructor(recorded: readonly PathAction[] | undefined) {
    this.actions = recorded;
  }

  /** The step to suggest, or undefined when there is no guidance left. */
  next(): PathAction | undefined {
    return this.actions?.[this.cursor];
  }

  /**
   * Compares a proposal against the current step.
   *
   * `abandoned` is reported on the transition only, so a caller can report the
   * discard exactly once: every later round has no step left to compare and is
   * simply `none`.
   */
  reconcile(proposed: PathAction | undefined): 'agreed' | 'abandoned' | 'none' {
    const expected = this.next();
    if (expected === undefined) return 'none';
    if (proposed !== undefined && sameAction(expected, proposed)) return 'agreed';
    // The page moved, or the model read it differently. Either way the recorded
    // route no longer describes this run, so forget it and reason freely for the
    // rest of the invocation.
    this.actions = undefined;
    return 'abandoned';
  }

  /** Moves to the next recorded step. Called only once an action has committed. */
  advance(): void {
    if (this.actions !== undefined) this.cursor += 1;
  }
}

class PathCache implements OpenPathCache {
  private readonly guidance: Guidance;
  /** What was offered, kept so an unchanged path is not rewritten. */
  private readonly offered: readonly PathAction[] | undefined;
  private readonly recorded: (PathAction | undefined)[] = [];
  /** Set once anything was not recordable, which makes the path unwritable. */
  private unrecordable: string | undefined;

  constructor(
    private readonly invocation: Invocation,
    private readonly context: AgentCacheContext,
    readonly key: CacheKey,
    readonly keyHash: string,
    guidance: readonly PathAction[] | undefined,
  ) {
    this.guidance = new Guidance(guidance);
    this.offered = guidance;
  }

  next(): PathAction | undefined {
    return this.guidance.next();
  }

  reconcile(proposed: PathAction | undefined): void {
    if (this.guidance.reconcile(proposed) === 'abandoned') {
      this.discard('the model chose a different action');
    }
  }

  committed(action: PathAction | undefined): void {
    this.guidance.advance();
    if (action === undefined && this.unrecordable === undefined) {
      this.unrecordable = 'an action exposed nothing storable to replay it by';
    }
    this.recorded.push(action);
  }

  async write(): Promise<void> {
    const store = this.context.store;
    if (!store.writable) return this.notRecorded('the cache is read-only');
    if (this.unrecordable !== undefined) return this.notRecorded(this.unrecordable);
    const actions = this.recorded.filter((action): action is PathAction => action !== undefined);
    if (actions.length === 0) return this.notRecorded('the flow committed no recordable action');
    if (actions.length > MAX_PATH_ACTIONS) {
      return this.notRecorded(`the flow ran ${actions.length} actions, over the ${MAX_PATH_ACTIONS} limit`);
    }
    // A warm run that followed its guidance to the end has nothing new to say.
    // Rewriting identical bytes would also relabel the step `written`, hiding
    // the hit that actually happened.
    if (this.offered !== undefined && sameActions(this.offered, actions)) {
      this.invocation.mergeCache({ reason: 'the recorded path is unchanged' });
      return undefined;
    }
    try {
      const written = await store.write(this.keyHash, {
        kind: 'path',
        payload: { type: 'path', actions },
      });
      if (written === undefined) {
        return this.notRecorded('the entry exceeded the cache byte limit');
      }
      this.invocation.mergeCache({
        kind: 'path',
        status: 'written',
        keyHash: this.keyHash,
        bytes: written.bytes,
        reason: `recorded a ${actions.length}-action path`,
      });
      agentTrace(() => `cache: wrote path ${this.keyHash.slice(0, 12)} (${actions.length} actions)`);
    } catch (cause) {
      // A cache write is never authority, so losing one must not fail a passing
      // test. The next run tries again.
      this.notRecorded(`the write failed: ${errorMessage(cause)}`);
    }
  }

  private discard(reason: string): void {
    this.invocation.setCache({
      kind: 'path',
      status: 'miss',
      keyHash: this.keyHash,
      reason: `guidance discarded: ${reason}`,
    });
    agentTrace(() => `cache: discarded path guidance — ${reason}`);
  }

  private notRecorded(reason: string): undefined {
    this.invocation.mergeCache({ reason: `not recorded: ${reason}` });
    agentTrace(() => `cache: not recording path ${this.keyHash.slice(0, 12)} — ${reason}`);
    return undefined;
  }
}

async function read(
  invocation: Invocation,
  context: AgentCacheContext,
  keyHash: string,
): Promise<readonly PathAction[] | undefined> {
  const result = await context.store.read(keyHash);
  if (result.status === 'invalid') {
    invocation.setCache({
      kind: 'path',
      status: 'invalid',
      keyHash,
      reason: result.reason,
      ...(result.bytes === undefined ? {} : { bytes: result.bytes }),
    });
    invocation.recordPolicy('cache.entry', 'denied', 'CACHE_INVALID');
    return undefined;
  }
  if (result.status === 'miss') {
    invocation.setCache({ kind: 'path', status: 'miss', keyHash, reason: 'no entry for this key' });
    return undefined;
  }
  if (result.entry.kind !== 'path') {
    invocation.setCache({ kind: 'path', status: 'miss', keyHash, bytes: result.bytes, reason: 'the entry is not a path entry' });
    return undefined;
  }
  const actions = result.entry.payload.actions;
  invocation.setCache({
    kind: 'path',
    status: 'hit',
    keyHash,
    bytes: result.bytes,
    reason: `offering a recorded ${actions.length}-action path`,
  });
  invocation.recordPolicy('cache.entry', 'allowed');
  agentTrace(() => `cache: path hit ${keyHash.slice(0, 12)} (${actions.length} actions)`);
  return actions;
}

/**
 * Whether a proposal is the recorded action.
 *
 * Compared field by field with object keys in sorted order, because the two sides
 * are built in different modules: one by the action space from a live call, the
 * other by the cache reader from a file. Plain `JSON.stringify` would make them
 * equal only for as long as both literals happened to list their fields in the
 * same order, and the failure is silent — the guidance is quietly discarded and
 * the run merely looks like a miss.
 *
 * A locator that changed shape is treated as divergence, which before any commit
 * is free: the guidance is simply dropped.
 */
function sameAction(expected: PathAction, proposed: PathAction): boolean {
  return stableStringify(expected) === stableStringify(proposed);
}

function sameActions(expected: readonly PathAction[], actual: readonly PathAction[]): boolean {
  return stableStringify(expected) === stableStringify(actual);
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
