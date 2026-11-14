/**
 * `createAgent` from `e2e-core/agent`: the agent over one session, configured
 * in code. `act`, `assert`, `waitFor`, and `extract` behave as they do in a
 * test. With `cache`, `act` replays recorded flows, each keyed by the
 * `cacheKey` the call names. With `guard`, the agent cannot take the actions
 * the program keeps for itself.
 */

import { compileGuard, guardIdentity } from '../agent/guard.ts';
import { createAgentFixture } from '../agent/index.ts';
import type { AgentContext, AgentSelection } from '../agent/invocation.ts';
import { createAgentCacheContext, settleStagedTraces, type AgentCacheContext } from '../cache/context.ts';
import { storedRecordingsFor } from '../cache/rekeyed.ts';
import { resolveAgentConfig } from '../config/agent.ts';
import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { TestError } from '../internal/errors.ts';
import { lazily, lazyBuiltInAgent } from '../run/fixtures.ts';
import { targetIdentity } from '../run/sessions.ts';
import { WorkerModels } from '../run/worker-models.ts';
import type { ActOptions, ActResult, Agent, AgentConfig, CacheStore, Guard } from '../types.ts';
import { sessionInternals } from './internals.ts';
import path from 'node:path';

export type { ActOptions, ActOutcome, ActResult, AssertOptions, ExtractOptions, Guard, GuardDecision, GuardNode, GuardRule, ProposedAction, WaitForOptions } from '../types.ts';
// The project tools and executor seam an agent is built from, as `e2e/agent` has them.
export * from '../agent/public.ts';

/** Where `act` keeps the flows it recorded, and whether it may write new ones. */
export interface AgentCacheOptions {
  /** The file store's directory, from the `launch` `cwd`; ignored with `store`. */
  readonly dir?: string;
  /** `read-write` (the default) replays and records; `read-only` replays and never writes. */
  readonly mode?: 'read-write' | 'read-only';
  /** A custom store in place of the file store, the seam a shared cache plugs into. */
  readonly store?: CacheStore;
  /**
   * Replays only: a recording that no longer replays fails its step with
   * `REPLAY_STALE` instead of calling the model, and nothing is written.
   */
  readonly strict?: boolean;
}

/** The agent's model, budgets, and context, as an `agents` entry of a config takes them, plus what only a program sets. */
export type CreateAgentOptions = AgentConfig & {
  /** What the agent may not do on its own; see `Guard`. */
  readonly guard?: Guard;
  /** Replays recorded `act` flows; every `act` then names its recording with `cacheKey`. */
  readonly cache?: AgentCacheOptions;
};

/** `act` on an agent with a cache: each call names the recording it replays and records. */
export type CachingActOptions = Omit<ActOptions, 'agent'> & (
  | {
      /**
       * The recording this call replays and records, unique within what the
       * program does: `checkout`, `cart-best-coupon`. The key is this name,
       * the instruction, its params, and how many times the session made the
       * same call, so a reworded instruction records afresh.
       */
      readonly cacheKey: string;
      readonly cache?: never;
    }
  | {
      /** Runs this call live, neither replaying nor recording. */
      readonly cache: false;
      readonly cacheKey?: never;
    }
);

/** An agent whose `act` replays recorded flows. */
export interface CachingAgent extends Omit<Agent, 'act'> {
  act(instruction: string, options: CachingActOptions): Promise<ActResult>;
}

/** An agent without a cache: every `act` calls the model. */
export interface CoreAgent extends Omit<Agent, 'act'> {
  act(instruction: string, options?: Omit<ActOptions, 'agent'>): Promise<ActResult>;
}

const AGENT_NAME = 'agent';

/** Creates an agent over `session` whose `act` replays flows from `cache`, each named by its `cacheKey`. */
export function createAgent(session: object, options: CreateAgentOptions & { readonly cache: AgentCacheOptions }): CachingAgent;
/** Creates an agent over `session`. */
export function createAgent(session: object, options: CreateAgentOptions): CoreAgent;
export function createAgent(session: object, options: CreateAgentOptions): CachingAgent | CoreAgent {
  const internals = sessionInternals(session, 'createAgent');
  if (typeof options !== 'object' || options === null) throw new TestError('INVALID_ARGUMENT', 'createAgent options must be an object with a model');
  const { guard, cache, ...entry } = options;
  const resolved = resolveAgentConfig(entry as AgentConfig, 'createAgent');
  const compiledGuard = guard === undefined ? undefined : compileGuard(guard, 'createAgent guard');
  const { config, attempt, target } = internals;
  const cacheConfig = cache === undefined ? undefined : resolveAgentCache(cache, config.projectRoot);
  // A missing model fails the first call that needs one, as `MODEL_UNAVAILABLE`, never the construction.
  const models = new WorkerModels(() => undefined);
  const selection: AgentSelection = {
    // The name keys recordings: one made under one guard never replays under another.
    name: guard === undefined ? AGENT_NAME : `${AGENT_NAME}-guarded-${guardIdentity(guard).slice(0, 12)}`,
    config: resolved,
    executor: resolved.executor ?? lazyBuiltInAgent(resolved),
    customExecutor: resolved.executor !== undefined,
    judge: lazily(() => models.build(resolved.judge, AGENT_NAME)),
    agentContext: resolved.context,
  };
  const base: AgentContext = {
    ...attempt.agentRuntime,
    select: (requested) => {
      if (requested !== undefined) throw new TestError('INVALID_ARGUMENT', 'an e2e-core agent takes no agent option: create another agent for another configuration');
      models.preflight(resolved, AGENT_NAME);
      return selection;
    },
    reportUnservedModel: models.unservedModel,
    ...(compiledGuard === undefined ? {} : { guard: compiledGuard }),
  };
  const live = createAgentFixture(base);

  // One cache context per key, each its own occurrence count; all settle when the session closes.
  const caches = new Map<string, AgentCacheContext>();
  const cacheFor = (cacheKey: string): AgentCacheContext | undefined => {
    if (cacheConfig === undefined) return undefined;
    let context = caches.get(cacheKey);
    if (context === undefined) {
      context = createAgentCacheContext({
        cache: cacheConfig, projectRoot: config.projectRoot, projectId: config.projectId,
        testId: `core:${cacheKey}`, target: targetIdentity(target), attemptIndex: 0,
        recordings: storedRecordingsFor(cacheConfig),
      });
      if (context !== undefined) caches.set(cacheKey, context);
    }
    return context;
  };
  if (cacheConfig !== undefined) {
    internals.closers.push(async () => {
      const settlement = internals.settlement();
      for (const context of caches.values()) await settleStagedTraces(context, settlement);
    });
  }

  const act = (instruction: string, actOptions?: CachingActOptions | Omit<ActOptions, 'agent'>): Promise<ActResult> => {
    const { cacheKey, cache: perCall, ...rest } = (actOptions ?? {}) as Partial<{ cacheKey: unknown; cache: unknown }> & ActOptions;
    if (cacheConfig === undefined) {
      if (cacheKey !== undefined || perCall !== undefined) {
        return Promise.reject(new TestError('INVALID_ARGUMENT', 'act cacheKey and cache need an agent created with createAgent({ cache })'));
      }
      return live.act(instruction, rest);
    }
    if (perCall === false && cacheKey === undefined) return live.act(instruction, rest);
    if (typeof cacheKey !== 'string' || cacheKey.trim() === '' || perCall !== undefined) {
      return Promise.reject(new TestError('INVALID_ARGUMENT', 'act on an agent with a cache names its recording: pass { cacheKey: "<name>" }, or { cache: false } to run live'));
    }
    const context = cacheFor(cacheKey);
    return createAgentFixture(context === undefined ? base : { ...base, cache: context }).act(instruction, rest);
  };

  return {
    act,
    assert: (assertion, assertOptions) => live.assert(assertion, assertOptions),
    waitFor: (condition, waitOptions) => live.waitFor(condition, waitOptions),
    extract: (instruction, extractOptions) => live.extract(instruction, extractOptions),
  } as CachingAgent | CoreAgent;
}

/** The cache options as the replay cache reads them: the file store under the project root unless a store replaces it. */
function resolveAgentCache(cache: AgentCacheOptions, projectRoot: string): ResolvedCacheConfig {
  if (typeof cache !== 'object' || cache === null) throw new TestError('INVALID_ARGUMENT', 'createAgent cache must be an object such as { dir: ".e2e/cache" }');
  for (const key of Object.keys(cache)) {
    if (!['dir', 'mode', 'store', 'strict'].includes(key)) throw new TestError('INVALID_ARGUMENT', `createAgent cache has an unknown key "${key}"; expected dir, mode, store, or strict`);
  }
  const mode = cache.mode ?? 'read-write';
  if (mode !== 'read-write' && mode !== 'read-only') throw new TestError('INVALID_ARGUMENT', 'createAgent cache.mode must be "read-write" or "read-only"');
  if (cache.dir !== undefined && (typeof cache.dir !== 'string' || cache.dir.trim() === '')) throw new TestError('INVALID_ARGUMENT', 'createAgent cache.dir must be a non-empty path');
  if (cache.strict !== undefined && typeof cache.strict !== 'boolean') throw new TestError('INVALID_ARGUMENT', 'createAgent cache.strict must be a boolean');
  return {
    mode,
    store: cache.store,
    dir: path.resolve(projectRoot, cache.dir ?? path.join('.e2e', 'cache')),
    strict: cache.strict === true ? { config: true, flag: false } : false,
  };
}
