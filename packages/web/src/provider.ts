/**
 * The seam a hosted browser service plugs into: a `BrowserProvider` leases a
 * browser and hands back the CDP endpoint to attach to. In `worker` scope the
 * engine leases one browser per worker slot in `prepare`, attaches each from
 * its worker, and releases them all in `finish`; in `attempt` scope it leases
 * a fresh browser in every `startAttempt` and releases it in `endAttempt`.
 * Nothing here knows any vendor: a cloud browser service, a browser farm, or
 * a Chrome on a machine down the hall are each one small provider in user code.
 */

import { createHash } from 'node:crypto';
import {
  ConfigurationError,
  EngineError,
  obj,
  raceAbort,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
} from 'e2e/engine';
import { message } from './support.ts';

/**
 * How long a lease lives. `worker` (the default) is one browser per worker
 * slot, acquired in `prepare` and released in `finish`; `attempt` is a fresh
 * browser per attempt, acquired in `startAttempt` and released in
 * `endAttempt`, reconnected through the lease's `reconnectEndpoint` after a
 * transport drop.
 */
export type BrowserProviderScope = 'worker' | 'attempt';

/** What the engine asks a provider for: one browser for one worker slot, or for one attempt, of a run. */
export interface BrowserRequest {
  /** The run id, for naming the session at the provider. */
  readonly runId: string;
  /** The target the browser serves. */
  readonly targetName: string;
  /** Worker slot the browser serves, `0` to `slots - 1`; in `worker` scope `slots` leases are acquired at once. */
  readonly slot: number;
  /** Worker slots the run uses for this target, in all. */
  readonly slots: number;
  /** Present only for a per-attempt lease. */
  readonly attemptId?: string | undefined;
  /** The run's environment: where a provider reads its token from, never `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts on interrupt, and when the attempt that needs the browser is cancelled or exceeds its budget. */
  readonly signal: AbortSignal;
  /** Reports one line of progress to the run's reporter (a session URL to watch); discarded in a worker process. */
  readonly log: (line: string) => void;
}

/**
 * One leased browser, as `acquire` returns it and `release` gets it back.
 * JSON data only: a lease travels from the runner process to the worker that
 * attaches to it through the environment.
 */
export interface BrowserLease {
  /**
   * The provider's handle on the lease (a session id); named in progress
   * lines and handed back to `release`. A provider may keep further fields on
   * the object it returns: `release` gets that same object, while only the
   * fields declared here travel to the worker.
   */
  readonly id: string;
  /** `ws://`, `wss://`, or `http://` DevTools endpoint to attach to over CDP. */
  readonly cdpEndpoint: string;
  /**
   * Endpoint to reattach to the same browser after a transport drop, when it
   * differs from `cdpEndpoint`; only meaningful for a per-attempt lease.
   */
  readonly reconnectEndpoint?: string | undefined;
}

/** Handed to `release`, once per lease. */
export interface BrowserReleaseContext {
  readonly runId: string;
  readonly targetName: string;
  /** The run's environment, the same `acquire` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the cleanup budget is spent. */
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
}

/**
 * A source of hosted browsers. In `worker` scope `acquire` is called once per
 * worker slot, for every slot at once, in the runner process; a worker whose
 * browser drops calls it again, from its own process, for a replacement. In
 * `attempt` scope every `startAttempt` calls it from the worker. `release`
 * is called exactly once per lease, by the process that acquired it, also
 * after an `acquire` of another slot failed. A provider must not rely on
 * runner-process state to serve a request from a worker.
 */
export interface BrowserProvider {
  /** Label in progress lines and error messages. */
  readonly name: string;
  /** How long a lease lives; `worker` when absent. */
  readonly scope?: BrowserProviderScope | undefined;
  acquire(request: BrowserRequest): Promise<BrowserLease>;
  release(lease: BrowserLease, context: BrowserReleaseContext): Promise<void>;
}

const SCOPES: ReadonlySet<string> = new Set<BrowserProviderScope>(['worker', 'attempt']);

/** Narrows an intended provider, or names what it is missing. */
export function asBrowserProvider(browser: object): BrowserProvider {
  const candidate = browser as Partial<Record<keyof BrowserProvider, unknown>>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web: a `browser` provider needs a non-empty `name`');
  }
  for (const member of ['acquire', 'release'] as const) {
    if (typeof candidate[member] !== 'function') {
      throw new ConfigurationError('INVALID_CONFIG', `web: browser provider "${candidate.name}" must implement ${member}()`);
    }
  }
  if (candidate.scope !== undefined && (typeof candidate.scope !== 'string' || !SCOPES.has(candidate.scope))) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web: browser provider "${candidate.name}" has scope ${JSON.stringify(candidate.scope)}; use "worker" or "attempt"`,
    );
  }
  return browser as BrowserProvider;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A lease as a provider returned it or as JSON parsed it back, checked field by field: the engine trusts nothing it did not write. */
function isBrowserLease(value: unknown): value is BrowserLease {
  if (typeof value !== 'object' || value === null) return false;
  const { id, cdpEndpoint, reconnectEndpoint } = value as Record<keyof BrowserLease, unknown>;
  return isNonEmptyString(id) && isNonEmptyString(cdpEndpoint) && (reconnectEndpoint === undefined || isNonEmptyString(reconnectEndpoint));
}

/**
 * What `prepare` hands the workers of one target: the slots the run uses,
 * and in `worker` scope the lease each slot attaches to.
 */
interface Handoff {
  readonly slots: number;
  readonly leases: readonly BrowserLease[];
}

/**
 * The most the serialized hand-off of one target may occupy in a worker's
 * environment: a lease comes from third-party code, and an oversized
 * environment fails the worker spawn with an opaque error.
 */
const MAX_HANDOFF_ENV_BYTES = 16 * 1024;

/**
 * The environment variable a target's hand-off travels to the workers in:
 * the name made environment-safe for reading, plus a digest of the exact
 * name so `web-a` and `web.a` never share a key.
 */
function handoffVariable(targetName: string): string {
  const readable = targetName.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  const digest = createHash('sha256').update(targetName).digest('hex').slice(0, 8).toUpperCase();
  return `E2E_WEB_BROWSERS_${readable}_${digest}`;
}

/** Serializes the hand-off for the environment: declared lease fields only, bounded. */
function encodeHandoff(handoff: Handoff): string {
  const encoded = JSON.stringify({
    slots: handoff.slots,
    leases: handoff.leases.map((lease) => obj({ id: lease.id, cdpEndpoint: lease.cdpEndpoint, reconnectEndpoint: lease.reconnectEndpoint })),
  });
  const bytes = Buffer.byteLength(encoded);
  if (bytes > MAX_HANDOFF_ENV_BYTES) {
    throw new EngineError(
      'ENGINE_FAILURE',
      `the browser leases take ${bytes} bytes; the worker environment carries at most ${MAX_HANDOFF_ENV_BYTES}`,
      { retryable: false },
    );
  }
  return encoded;
}

/** The hand-off a `prepare` left in the environment, or `undefined` when there is none it can read. */
function decodeHandoff(raw: string | undefined): Handoff | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { slots, leases } = parsed as Record<keyof Handoff, unknown>;
    if (Number.isInteger(slots) && (slots as number) >= 0 && Array.isArray(leases) && leases.every(isBrowserLease)) {
      return { slots: slots as number, leases };
    }
  } catch {
    // Not ours to read.
  }
  return undefined;
}

/** Runs every task, then reports the first failure: nothing is skipped because a sibling failed. */
async function allOrFirstFailure<T>(tasks: readonly (() => Promise<T>)[], describe: string): Promise<T[]> {
  // `async` so a task that throws before its first await is a rejection like any other, not an escape.
  const settled = await Promise.allSettled(tasks.map(async (task) => task()));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) {
    if (failed.reason instanceof EngineError) throw failed.reason;
    throw new EngineError('ENGINE_FAILURE', `${describe}: ${message(failed.reason)}`, { retryable: false, cause: failed.reason });
  }
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/** The run a worker serves, as `init` reported it: what every request and release from the worker names. */
interface WorkerRun {
  readonly runId: string;
  readonly targetName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly slot: number;
  /** Worker slots the run uses for the target, as `prepare` saw them; the request's `slots`. */
  readonly slots: number;
}

/** A lease a worker attaches to, and whether the worker (not the runner's `prepare`) acquired it. */
interface WorkerLease {
  readonly lease: BrowserLease;
  readonly owned: boolean;
}

const discard = (): void => undefined;

/**
 * Browsers a provider leases for one target, on both sides of the worker
 * boundary. In the runner, `prepare` leases one per slot, all at once (hosted
 * browsers start in parallel and are billed from the moment they do), and
 * holds every lease granted for `finish` before the outcome is known, so a
 * slot that fails to lease fails the run and the others are still released.
 * In a worker, `init` reads the slot's lease from the environment; a browser
 * that drops is replaced by a lease the worker acquires itself, and
 * per-attempt leases come and go with the attempt. Each lease is released
 * exactly once, by the side that acquired it.
 */
export class LeasedBrowsers {
  readonly scope: BrowserProviderScope;
  /** Leases granted so far, per target, filled as each `acquire` settles. */
  private readonly held = new Map<string, BrowserLease[]>();
  private run: WorkerRun | undefined;
  /** The lease the worker's shared browser attaches to, and whether `endpoint` has handed it out yet. */
  private current: WorkerLease | undefined;
  private attached = false;
  private attempt: BrowserLease | undefined;

  constructor(private readonly provider: BrowserProvider) {
    this.scope = provider.scope ?? 'worker';
  }

  // --- runner side ---

  /**
   * Leases one browser per worker slot the run will use, in `worker` scope,
   * and hands the leases to the workers through the environment; `attempt`
   * scope leases per attempt instead and hands over the slot count alone. A
   * target nothing runs on leases nothing.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (info.slots === 0) return {};
    const variable = handoffVariable(info.targetName);
    if (this.scope === 'attempt') return { env: { [variable]: encodeHandoff({ slots: info.slots, leases: [] }) } };
    const { provider } = this;
    const held: BrowserLease[] = [];
    this.held.set(info.targetName, held);
    info.log(`leasing ${info.slots} browser(s) from ${provider.name}`);
    const leases = await allOrFirstFailure(
      Array.from({ length: info.slots }, (_, slot) => async () => {
        const lease = await this.acquire({
          runId: info.runId,
          targetName: info.targetName,
          slot,
          slots: info.slots,
          env: info.env,
          signal: info.signal,
          log: (line) => info.log(`${provider.name} (${slot + 1} of ${info.slots}): ${line}`),
        });
        held.push(lease);
        info.log(`${provider.name}: leased ${lease.id}`);
        return lease;
      }),
      `browser provider "${provider.name}" could not lease a browser`,
    );
    return { workers: leases.length, env: { [variable]: encodeHandoff({ slots: leases.length, leases }) } };
  }

  /** Releases what `prepare` leased for the target, every lease before the first failure is reported. */
  async finish(info: EngineFinishInfo): Promise<void> {
    const { provider } = this;
    const leases = this.held.get(info.targetName);
    this.held.delete(info.targetName);
    if (leases === undefined || leases.length === 0) return;
    const context = { runId: info.runId, targetName: info.targetName, env: info.env, signal: info.signal, log: (line: string) => info.log(`${provider.name}: ${line}`) };
    await allOrFirstFailure(
      leases.map((lease) => () => provider.release(lease, context)),
      `browser provider "${provider.name}" could not release a browser`,
    );
    info.log(`${provider.name}: released ${leases.length} browser(s)`);
  }

  // --- worker side ---

  /**
   * Records the run this worker serves and, in `worker` scope, the lease its
   * slot was handed. A missing hand-off is a broken invariant: the runner
   * prepares every target before it starts a worker, and caps the slots at
   * the workers `prepare` reported.
   */
  init(info: EngineInitInfo): void {
    const { provider } = this;
    this.current = undefined;
    this.attached = false;
    const handoff = decodeHandoff(info.env[handoffVariable(info.targetName)]);
    if (handoff === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `browser provider "${provider.name}" prepared nothing for target "${info.targetName}"; the runner must prepare the target before a worker starts`,
        { retryable: false },
      );
    }
    this.run = { runId: info.runId, targetName: info.targetName, env: info.env, slot: info.workerSlot, slots: handoff.slots };
    if (this.scope === 'attempt') return;
    const lease = handoff.leases[info.workerSlot];
    if (lease === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `worker slot ${info.workerSlot} is outside the ${handoff.leases.length} browser(s) "${provider.name}" leased; the runner must cap the target at the engine's reported workers`,
        { retryable: false },
      );
    }
    this.current = { lease, owned: false };
  }

  /**
   * The endpoint the worker's shared browser attaches to, in `worker` scope:
   * the slot's lease the first time, and a replacement the worker leases
   * itself every time after, since the connection only asks again once the
   * browser it had dropped. A dead lease is released by the side that
   * acquired it: the worker here, best effort, or the runner in `finish`.
   */
  async endpoint(signal: AbortSignal): Promise<string> {
    const run = this.requireRun();
    const previous = this.current;
    if (previous !== undefined && !this.attached) {
      this.attached = true;
      return previous.lease.cdpEndpoint;
    }
    const lease = await this.acquire({ runId: run.runId, targetName: run.targetName, slot: run.slot, slots: run.slots, env: run.env, signal, log: discard });
    this.current = { lease, owned: true };
    this.attached = true;
    if (previous?.owned === true) await this.provider.release(previous.lease, this.releaseContext(run, signal)).catch(discard);
    return lease.cdpEndpoint;
  }

  /** Leases a fresh browser for the attempt, in `attempt` scope; `endAttempt` releases it on every path. */
  async startAttempt(context: EngineAttemptContext): Promise<BrowserLease> {
    const run = this.requireRun();
    const lease = await this.acquire({
      runId: run.runId,
      targetName: run.targetName,
      slot: run.slot,
      slots: run.slots,
      attemptId: context.attemptId,
      env: run.env,
      signal: context.signal,
      log: discard,
    });
    this.attempt = lease;
    return lease;
  }

  /** Releases the attempt's lease, when one was granted; idempotent, and safe after a failed `startAttempt`. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const lease = this.attempt;
    this.attempt = undefined;
    if (lease === undefined) return;
    await this.release(lease, context);
  }

  /** Releases the replacement lease the worker acquired for itself; what `prepare` leased is the runner's to release. */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const current = this.current;
    this.current = undefined;
    this.attached = false;
    if (current === undefined || !current.owned) return;
    await this.release(current.lease, context);
  }

  private requireRun(): WorkerRun {
    if (this.run === undefined) {
      throw new EngineError('ENGINE_FAILURE', `browser provider "${this.provider.name}" was asked for a browser before init`, { retryable: false });
    }
    return this.run;
  }

  /** One `acquire`, its result checked field by field; a failure is named after the provider. */
  private async acquire(request: BrowserRequest): Promise<BrowserLease> {
    const { provider } = this;
    let lease: unknown;
    try {
      lease = await provider.acquire(request);
    } catch (cause) {
      throw new EngineError('ENGINE_FAILURE', `browser provider "${provider.name}" could not lease a browser: ${message(cause)}`, { retryable: false, cause });
    }
    if (!isBrowserLease(lease)) {
      throw new EngineError('ENGINE_FAILURE', `browser provider "${provider.name}" returned a lease without an id and a cdpEndpoint`, { retryable: false });
    }
    return lease;
  }

  /** One `release` from the worker, bounded by the cleanup budget; a failure is a cleanup error named after the provider. */
  private async release(lease: BrowserLease, budget: EngineCleanupContext): Promise<void> {
    const run = this.requireRun();
    try {
      await raceAbort(this.provider.release(lease, this.releaseContext(run, budget.signal)), budget.signal, `releasing browser ${lease.id}`);
    } catch (cause) {
      if (cause instanceof EngineError) throw cause;
      throw new EngineError('ENGINE_FAILURE', `browser provider "${this.provider.name}" could not release browser ${lease.id}: ${message(cause)}`, { retryable: false, cause });
    }
  }

  private releaseContext(run: WorkerRun, signal: AbortSignal): BrowserReleaseContext {
    return { runId: run.runId, targetName: run.targetName, env: run.env, signal, log: discard };
  }
}
