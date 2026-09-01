/**
 * `--debug` presentation of agent steps, derived entirely from the step
 * records every run already collects for the report. There is no separate
 * debug telemetry channel for agent steps: the timeline is the single account
 * of what happened.
 */

import { formatMs, table } from '../internal/debug.ts';
import type { ResultRecord, SerialGroupRecord } from '../run/records.ts';
import type { StepRecord } from '../run/steps.ts';

/**
 * Renders one aligned table of every agent step in the run, in execution
 * order, with per-phase splits summed from the step's child events. Returns
 * the empty string when the run performed no agent steps.
 */
export function agentStepTable(
  results: readonly ResultRecord[],
  serialGroups: readonly SerialGroupRecord[],
): string {
  const steps = collectAgentSteps(results, serialGroups);
  if (steps.length === 0) return '';

  const models = new Set(
    steps
      .map((step) => (step.model === undefined ? undefined : `${step.model.provider}/${step.model.model}`))
      .filter((model): model is string => model !== undefined),
  );
  const mixedModels = models.size > 1;

  const rows = steps.map((step) => [
    truncate(step.label === '' ? step.api : `${step.api} ${JSON.stringify(step.label)}`, 64),
    ...(mixedModels
      ? [step.model === undefined ? '-' : `${step.model.provider}/${step.model.model}`]
      : []),
    formatMs(step.durationMs),
    formatMs(eventMs(step, 'model')),
    formatMs(eventMs(step, 'observation')),
    formatMs(eventMs(step, 'driver')),
    String(step.model?.calls ?? 0),
    `${String(step.model?.inputTokens ?? 0)}/${String(step.model?.outputTokens ?? 0)}`,
    step.model?.estimatedCostUsd === undefined ? '-' : formatUsd(step.model.estimatedCostUsd),
  ]);

  const knownCosts = steps
    .map((step) => step.model?.estimatedCostUsd)
    .filter((cost): cost is number => cost !== undefined);
  const total =
    knownCosts.length === 0
      ? ''
      : `, total ${formatUsd(knownCosts.reduce((sum, cost) => sum + cost, 0))}${
          knownCosts.length < steps.length ? '+' : ''
        }`;
  const sharedModel = mixedModels || models.size === 0 ? '' : `, model ${[...models][0] ?? ''}`;

  return table(
    `[e2e debug] agent steps (execution order${sharedModel}${total})`,
    [
      'step',
      ...(mixedModels ? ['via'] : []),
      'total',
      'model',
      'observe',
      'action',
      'calls',
      'tokens in/out',
      'cost',
    ],
    rows,
    '(no agent steps recorded)',
  );
}

/** Agent steps from every attempt and serial member, in record order. */
function collectAgentSteps(
  results: readonly ResultRecord[],
  serialGroups: readonly SerialGroupRecord[],
): StepRecord[] {
  const steps: StepRecord[] = [];
  for (const result of results) {
    for (const attempt of result.attempts) {
      steps.push(...attempt.steps.filter((step) => step.kind === 'agent'));
    }
  }
  for (const group of serialGroups) {
    for (const attempt of group.attempts) {
      for (const member of attempt.members) {
        steps.push(...member.steps.filter((step) => step.kind === 'agent'));
      }
    }
  }
  return steps;
}

function eventMs(step: StepRecord, kind: 'model' | 'observation' | 'driver'): number {
  return step.events
    .filter((event) => event.kind === kind)
    .reduce((total, event) => total + event.durationMs, 0);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatUsd(value: number): string {
  const digits = value >= 0.1 ? 2 : 6;
  const trimmed = value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `$${trimmed}`;
}

