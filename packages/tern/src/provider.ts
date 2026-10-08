import type { EngineAppInfo, EngineCleanupContext } from 'e2e/engine';

/** Identity and budgets of one isolated application launch. */
export interface TernRequest {
  readonly runId: string;
  readonly targetName: string;
  readonly workerSlot: number;
  readonly attemptId: string;
  readonly projectRoot: string;
  readonly app: EngineAppInfo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly artifactsDir: string;
  readonly signal: AbortSignal;
}

/** Compositor-local input, never the operator's globally focused seat. */
export interface TernInput {
  type(text: string, signal: AbortSignal): Promise<void>;
  press(key: string, signal: AbortSignal): Promise<void>;
  tap?(x: number, y: number, signal: AbortSignal): Promise<void>;
}

/** An explicitly addressed native window, or an observation-only terminal pane. */
export interface TernLease {
  readonly id: string;
  readonly pane: string;
  readonly mode: 'native' | 'capture';
  readonly control?: string;
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: TernInput;
  readonly client?: { readonly pid: number; readonly start: string };
  readonly recordPath?: string;
  /** Checks resource ownership before a request; returned callback proves its boundary afterward. */
  readonly guard?: (signal: AbortSignal) => Promise<() => Promise<void>>;
  /** Raw owned-output PNG, private caller use only; not the engine's secret-safe screenshot capability. */
  readonly capture?: (signal: AbortSignal) => Promise<Uint8Array>;
}

/** Resources are acquired in startAttempt and released even after partial setup fails. */
export interface TernProvider {
  readonly name: string;
  readonly mode: 'native' | 'capture';
  readonly borrowed?: boolean;
  acquire(request: TernRequest): Promise<TernLease>;
  release(lease: TernLease, context: EngineCleanupContext): Promise<void>;
  /** Called after all workers; only resources owned by this run and target may be removed. */
  sweep?(request: Pick<TernRequest, 'runId' | 'targetName' | 'env'>, context: EngineCleanupContext): Promise<void>;
}

/** Attach without discovering, focusing, restarting or closing an existing window. */
export function attachedTern(lease: TernLease): TernProvider {
  if (!lease.pane || !lease.binary || (lease.mode === 'native' && !lease.control)) {
    throw new Error('attachedTern requires explicit pane, binary and native control endpoint');
  }
  return {
    name: 'attached', mode: lease.mode, borrowed: true,
    async acquire() { return lease; },
    async release() { /* The caller owns the attached window. */ },
  };
}
