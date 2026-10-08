import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EngineError, type OperationContext } from 'e2e/engine';
import type { TernLease } from './provider.ts';
import { requireNativeGate } from './gate.ts';

const exec = promisify(execFile);

/** The account gate and pane owner are both boundaries of every native action. */
export function requireNativeState(state: Record<string, unknown>, pane: string): void {
  requireNativeGate(state);
  const panes = state.panes as { id?: unknown }[] | undefined;
  const focused = state.focused as { id?: unknown } | undefined;
  if (!Array.isArray(panes) || panes.length !== 1 || String(panes[0]?.id) !== pane || String(focused?.id) !== pane) {
    throw new EngineError('NOT_ACTIONABLE', 'Native Tern requires its explicitly leased, focused single-pane window', { retryable: false });
  }
}

/** One encoded scenario; never interpolate text into a shell or disclose it in an error. */
export async function control(lease: TernLease, scenario: string, context: Pick<OperationContext, 'signal' | 'timeoutMs'>, mutation = false): Promise<Record<string, unknown>> {
  if (!lease.control) throw new EngineError('INVALID_STATE', 'Tern has no explicit control endpoint', { retryable: false });
  context.signal.throwIfAborted();
  if(mutation)requireNativeState(await control(lease,'state',context),lease.pane);
  let mutationStarted = false;
  try {
    context.signal.throwIfAborted();
    const after = await lease.guard?.(context.signal);
    try {
    const timeout = Math.max(1, context.timeoutMs);
    mutationStarted = mutation;
    const { stdout } = await exec(lease.binary, ['ctl', '--control', lease.control, scenario], {
      env: lease.env, signal: context.signal, timeout, maxBuffer: 8 * 1024 * 1024,
    });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>).ok !== true) {
      throw new Error('unsuccessful control reply');
    }
    if(mutation)requireNativeState(await control(lease,'state',context),lease.pane);
    return result as Record<string, unknown>;
    } finally { await after?.(); }
  } catch (cause) {
    if (!mutationStarted) {
      if (context.signal.aborted) throw context.signal.reason;
      if (cause instanceof EngineError) throw cause;
    }
    throw new EngineError(mutation ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE',
      mutation ? 'Tern input may have reached the app; do not repeat it' : 'Tern control inspection failed', { retryable: false });
  }
}

/** A terminal capture is incomplete text, never a native control tree. */
export async function capture(lease: TernLease, context: OperationContext): Promise<string> {
  const options = { env: lease.env, signal: context.signal, get timeout() { return Math.max(1, context.timeoutMs); }, maxBuffer: 8 * 1024 * 1024 };
  try {
    const after = await lease.guard?.(context.signal);
    try {
      const surface = await exec(lease.binary, ['capture', '--surfaces', lease.pane], options);
      const scrollback = await exec(lease.binary, ['capture', '--scrollback', lease.pane], options);
      return `${surface.stdout}\n${scrollback.stdout}`;
    } finally { await after?.(); }
  } catch (cause) {
    if (context.signal.aborted) throw context.signal.reason;
    if (cause instanceof EngineError) throw cause;
    throw new EngineError('ENGINE_FAILURE', 'Explicit Tern capture failed', { retryable: false });
  }
}
