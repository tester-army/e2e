/** Source-aware model turns passed between the built-in executor and its step recorder. */

import type { StepExecutorContext } from './executor.ts';
import type { StepTurnRecord } from '../run/steps.ts';

const recordSinks = new WeakMap<StepExecutorContext, (turns: readonly StepTurnRecord[]) => void>();

/** Registers the built-in executor's private turn source sink for one step context. */
export function registerStepTurnRecordSink(
  context: StepExecutorContext,
  sink: (turns: readonly StepTurnRecord[]) => void,
): void {
  recordSinks.set(context, sink);
}

/** Attaches source-aware turns when the context belongs to the built-in runner. */
export function attachStepTurnRecords(context: StepExecutorContext, turns: readonly StepTurnRecord[]): boolean {
  const sink = recordSinks.get(context);
  if (sink === undefined) return false;
  sink(turns);
  return true;
}
