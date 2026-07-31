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
import { describeExpression } from '../locator/expression.ts';
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
  /** Advances the recorded path, or drops it when the model chose otherwise. */
  reconcile(proposed: PathAction | undefined): void;
  /** Notes that an action ran, so the recorded path reflects what happened. */
  observed(action: PathAction | undefined): void;
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

class PathCache implements OpenPathCache {
  private cursor = 0;
  private guidance: readonly PathAction[] | undefined;
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
    this.guidance = guidance;
    this.offered = guidance;
  }

  next(): PathAction | undefined {
    return this.guidance?.[this.cursor];
  }

  reconcile(proposed: PathAction | undefined): void {
    const expected = this.next();
    if (expected === undefined) return;
    if (proposed !== undefined && sameAction(expected, proposed)) {
      this.cursor += 1;
      return;
    }
    // The page moved, or the model read it differently. Either way the recorded
    // route no longer describes this run, so forget it and reason freely for the
    // rest of the invocation.
    this.discard('the model chose a different action');
  }

  observed(action: PathAction | undefined): void {
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
    if (this.guidance === undefined) return;
    this.guidance = undefined;
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
 * Renders one recorded action as the suggestion the model is shown.
 *
 * Prose rather than JSON, and framed as the previous route rather than as an
 * instruction, because the model has to be free to reject it: the whole point of
 * re-observing is that the page may no longer support it.
 */
export function describeGuidance(action: PathAction): string {
  switch (action.kind) {
    case 'tap':
      return `tap ${describeExpression(action.target)}`;
    case 'type':
      return 'sensitiveName' in action
        ? `fill ${describeExpression(action.target)} with the secret "${action.sensitiveName}"`
        : `type the value it needs into ${describeExpression(action.target)}`;
    case 'scroll':
      return action.target === undefined
        ? `scroll ${action.direction}`
        : `scroll ${action.direction} within ${describeExpression(action.target)}`;
    case 'press':
      return `press ${action.key}`;
    case 'longPress':
      return `long-press ${describeExpression(action.target)}`;
    default:
      return `navigate to ${action.url}`;
  }
}

/**
 * Whether a proposal is the recorded action.
 *
 * Compared on the kind and the arguments that decide what happens, with the
 * target compared structurally. A locator that changed shape is treated as
 * divergence, which before any commit is free — the guidance is simply dropped.
 */
function sameAction(expected: PathAction, proposed: PathAction): boolean {
  return JSON.stringify(expected) === JSON.stringify(proposed);
}

function sameActions(expected: readonly PathAction[], actual: readonly PathAction[]): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
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
