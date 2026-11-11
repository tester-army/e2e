/** Test recording storage. Confirmed updates merge under a file lock and publish atomically. */
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { canonicalJson, sha256Hex } from '../internal/ids.ts';
import { errorMessage } from '../internal/errors.ts';
import { buildTraceEntry, type ActionTrace } from './trace.ts';
import type { TraceEntry } from './trace.ts';
import type { ReplayStep, ReplayTest, ReplayVariant } from './test-file.ts';
import { encodeTestReplayCode, readTestReplayCode, cacheFileName } from './code.ts';
import { withCacheLock } from './file-lock.ts';

/** Hard wire ceiling for one complete test recording. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;
const KEY_HASH = /^[a-f0-9]{64}$/u;

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: TraceEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

/** Where the replay cache keeps its entries: the file store by default, or a host's own through `cache.store`. */
export interface CacheStore {
  readonly writable: boolean;
  read(keyHash: string): Promise<CacheReadResult>;
  /** Persists one trace, returning its size, or undefined when not written. */
  write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined>;
  /**
   * Evicts one entry, best-effort. Called when a replayed or just-recorded
   * flow is implicated in a failed attempt: the entry re-records on the next
   * pass instead of replaying a poisoned flow forever. Optional — a store
   * without eviction merely stays stale until the next confirmed write.
   * Resolves when the entry is absent; rejects when deletion fails so the
   * best-effort caller can avoid reporting a successful eviction.
   */
  delete?(keyHash: string): Promise<void>;
}

export interface FileCacheStoreOptions {
  readonly directory: string;
  readonly testId: string;
  readonly variant?: ReplayVariant;
  readonly maxBytes: number;
  readonly writable: boolean;
  /** Attempts stage changes until their verification boundary settles. */
  readonly deferred?: boolean;
}

/** One test's step lookup facade, retaining the custom store's per-step contract. */
export class FileCacheStore implements CacheStore {
  readonly writable: boolean;
  private readonly path: string;
  private readonly variant: ReplayVariant | undefined;
  private readonly pending = new Map<string, ActionTrace | null>();
  private readonly order = new Map<string, number>();

  constructor(private readonly options: FileCacheStoreOptions) {
    this.writable = options.writable;
    this.variant = options.variant === undefined ? undefined : variantIdentity(options.variant);
    this.path = join(options.directory, cacheFileName(options.testId));
  }

  /** Records encounter order independently of the step's signature-based lookup key. */
  claim(key: string): void { if (!this.order.has(key)) this.order.set(key, this.order.size); }

  /** Loads and validates the whole container before exposing any of its steps. */
  async recording(): Promise<{ readonly recording: ReplayTest; readonly bytes: number } | undefined> {
    let size: number;
    try { size = (await stat(this.path)).size; }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
    if (size > Math.min(this.options.maxBytes, MAX_CACHE_WIRE_BYTES)) throw new Error('test recording exceeds its byte limit');
    const source = await readFile(this.path, 'utf8');
    if (Buffer.byteLength(source) > Math.min(this.options.maxBytes, MAX_CACHE_WIRE_BYTES)) throw new Error('test recording exceeds its byte limit');
    const recording = readTestReplayCode(source);
    if (recording.id !== sha256Hex(this.options.testId)) throw new Error('test recording identity does not match its filename');
    return { recording, bytes: Buffer.byteLength(source) };
  }

  /** Reads a matching act call without treating a different call as a hit. */
  async read(keyHash: string): Promise<CacheReadResult> {
    if (!KEY_HASH.test(keyHash)) return { status: 'invalid', reason: 'key hash is not a SHA-256 digest' };
    try {
      const loaded = await this.recording();
      const step = loaded?.recording.steps.find((candidate) => candidate.key === keyHash && this.owns(candidate));
      return step === undefined ? { status: 'miss' } : { status: 'hit', entry: { ...buildTraceEntry(step.trace), createdAt: '1970-01-01T00:00:00.000Z' }, bytes: loaded!.bytes };
    } catch (cause) { return { status: 'invalid', reason: `cache entry is unreadable: ${errorMessage(cause)}` }; }
  }

  /** Stages a verified trace, or publishes it immediately for a direct store caller. */
  async write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return undefined;
    try {
      const bytes = Buffer.byteLength(encodeTestReplayCode({ id: sha256Hex(this.options.testId), testId: payload.recordedFor?.testId ?? this.options.testId, steps: [this.step(keyHash, payload, this.order.get(keyHash) ?? 0)] }));
      if (bytes > Math.min(this.options.maxBytes, MAX_CACHE_WIRE_BYTES)) return undefined;
      this.pending.set(keyHash, payload);
      if (!this.options.deferred) await this.flush(false);
      return { bytes };
    } catch { return undefined; }
  }

  /** Evicts only the implicated act call, preserving other steps and variants. */
  async delete(keyHash: string): Promise<void> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return;
    if (!this.pending.has(keyHash) && (await this.read(keyHash)).status === 'miss') return;
    this.pending.set(keyHash, null);
    if (!this.options.deferred) await this.flush(false);
  }

  /** Returns the keys in this test, used by strict stale-key detection. */
  async keyHashes(): Promise<string[]> {
    return (await this.recording())?.recording.steps.filter((step) => this.owns(step)).map((step) => step.key) ?? [];
  }

  /** Atomically merges this attempt; a completed body replaces its variant's encountered step set. */
  async flush(completed: boolean): Promise<void> {
    if (!this.writable || (this.pending.size === 0 && !completed)) return;
    if (this.pending.size === 0 && !(await stat(this.path).then(() => true, (cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return false; throw cause; }))) return;
    await mkdir(this.options.directory, { recursive: true });
    await withCacheLock(this.path, async () => {
      // Invalid data is disposable, but never salvage a subset of an invalid file for replay.
      const existing = await this.recording().catch(() => undefined);
      let steps = [...(existing?.recording.steps ?? [])];
      if (completed) steps = steps.filter((step) => !this.owns(step) || this.order.has(step.key));
      for (const [key, trace] of this.pending) {
        const old = steps.find((step) => step.key === key && this.owns(step));
        steps = steps.filter((step) => step.key !== key || !this.owns(step));
        if (trace !== null) steps.push(this.step(key, trace, this.order.get(key) ?? old?.order ?? steps.length));
      }
      steps = steps.map((step) => this.owns(step) && this.order.has(step.key) ? { ...step, order: this.order.get(step.key)! } : step);
      if (steps.length === 0) { await unlink(this.path).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== 'ENOENT') throw cause; }); return; }
      const source = encodeTestReplayCode({ id: sha256Hex(this.options.testId), testId: steps[0]!.trace.recordedFor?.testId ?? existing?.recording.testId ?? this.options.testId, steps });
      if (Buffer.byteLength(source) > Math.min(this.options.maxBytes, MAX_CACHE_WIRE_BYTES)) throw new Error('test recording exceeds its byte limit');
      if (existing !== undefined && canonicalJson(readTestReplayCode(source)) === canonicalJson(existing.recording)) return;
      await writeFileAtomic(this.path, source, { mode: 0o600 });
    });
    this.pending.clear();
  }

  /** Identifies the execution variant this writer may replace. */
  private owns(step: ReplayStep): boolean {
    return this.variant === undefined || canonicalJson(step.variant) === canonicalJson(this.variant);
  }

  /** Builds one test step while retaining its recorded target and agent provenance. */
  private step(key: string, trace: ActionTrace, order: number): ReplayStep {
    const variant = this.variant ?? variantIdentity({ project: trace.keyedBy?.project ?? '', target: trace.recordedFor?.targetId ?? '', agent: trace.recordedFor?.agent ?? '' });
    return { key, order, variant, trace };
  }
}

/** Ownership must remain stable without publishing secret-bearing target or agent names. */
function variantIdentity(variant: ReplayVariant): ReplayVariant {
  return { project: variant.project, target: sha256Hex(variant.target), agent: sha256Hex(variant.agent) };
}
