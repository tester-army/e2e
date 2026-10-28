import type { RedactedNode } from '../agent/observation.ts';
import type { TracePosition, TraceTargetDescriptor } from './trace.ts';
import { TestError } from '../internal/errors.ts';

/** An explicit edge carries identity without the row's content or recorded count. */
export type EdgeDescriptor = Pick<TraceTargetDescriptor, 'role'> & { readonly testId: string; readonly ordinal: 'first' | 'last' };

/** Builds an edge only for the named repeated control. */
export function edgeDescriptor(node: Pick<RedactedNode, 'role' | 'testId'>, ordinal: EdgeDescriptor['ordinal'] | undefined, testId = node.testId): EdgeDescriptor | undefined {
  if (ordinal === undefined || node.testId === undefined || node.testId !== testId) return undefined;
  return { ...(node.role === undefined ? {} : { role: node.role }), testId: node.testId, ordinal };
}

/** Edge descriptors have one closed shape for decoding and relocation alike. */
export function isEdgeDescriptor(value: object): value is EdgeDescriptor {
  const ordinal: unknown = Reflect.get(value, 'ordinal');
  const testId: unknown = Reflect.get(value, 'testId');
  const role: unknown = Reflect.get(value, 'role');
  return (ordinal === 'first' || ordinal === 'last') && typeof testId === 'string' && testId !== '' &&
    (role === undefined || typeof role === 'string') && Object.keys(value).every(field => field === 'role' || field === 'testId' || field === 'ordinal');
}

/** A partial observation cannot establish an edge for either endpoint. */
export function edgeObservable(screen: { readonly truncated?: boolean }, ...descriptors: readonly TraceTargetDescriptor[]): boolean {
  return !screen.truncated || descriptors.every(descriptor => descriptor.ordinal === undefined);
}

/** Live actions refuse incomplete edge evidence before sending input. */
export function requireEdgeObservable(descriptor: TraceTargetDescriptor, screen: { readonly truncated?: boolean }): void {
  if (!edgeObservable(screen, descriptor)) throw new TestError('UNSUPPORTED_CAPABILITY', 'agent.act position requires a complete semantic observation');
}

/** Most twins a recording distinguishes; beyond it a list is data, not a control set. */
const MAX_TRACE_POSITION_OF = 1000;

/** Reads a counted position without changing the same-count replay contract. */
export function readTracePosition(document: unknown): TracePosition | undefined {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
  const { index, of } = document as Record<string, unknown>;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(of)) return undefined;
  // `of: 1` counts an anonymous target alone; named targets record a position only among twins.
  if ((of as number) < 1 || (of as number) > MAX_TRACE_POSITION_OF) return undefined;
  if ((index as number) < 0 || (index as number) >= (of as number)) return undefined;
  return { index: index as number, of: of as number };
}
