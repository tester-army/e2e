/** Live attempt redaction for executor helpers without exposing secret values. */
import { realmSlot } from '../internal/realm-slot.ts';
import type { StepExecutorContext } from './executor.ts';

export const executorRedactors = realmSlot<(text: string) => string>('e2e.executor-redactor.v1');

/** Redacts every text field and key before a tool result enters model history. */
export function redactToolResult<T>(context: StepExecutorContext, value: T): T {
  const redact = executorRedactors.get(context);
  if (redact === undefined) return value;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redact(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry !== null && typeof entry === 'object' && Object.getPrototypeOf(entry) === Object.prototype) {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [redact(key), visit(item)]));
    }
    return entry;
  };
  return visit(value) as T;
}
