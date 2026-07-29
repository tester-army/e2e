/**
 * `--debug` presentation of agent steps, derived entirely from the step
 * records every run already collects for the report. There is no separate
 * debug telemetry channel for agent steps: the timeline is the single account
 * of what happened.
 */

import { formatMs, table } from '../internal/debug.ts';
import type { ResultRecord, SerialGroupRecord } from '../run/records.ts';
import { CACHE_REPLAY_EVENT, type StepCacheInfo, type StepRecord } from '../run/steps.ts';

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

/**
 * Renders the locate cache's account of itself: what each locate did with the
 * cache, why, and what it cost or saved.
 *
 * Only steps that actually consulted the cache appear. A judgment or an
 * extraction never locates anything, so it has no cache dimension, and listing
 * it as "bypassed" would imply the cache could have helped it. Everything here
 * is read back off the step records, so the table can only report what the run
 * recorded.
 */
export function cacheTable(
  results: readonly ResultRecord[],
  serialGroups: readonly SerialGroupRecord[],
): string {
  const located = collectAgentSteps(results, serialGroups).filter(
    (step): step is StepRecord & { cache: StepCacheInfo } => step.cache !== undefined,
  );
  if (located.length === 0) return '';

  const rows = located.map((step) => [
    truncate(step.label === '' ? step.api : `${step.api} ${JSON.stringify(step.label)}`, 44),
    step.cache.status,
    step.cache.keyHash === undefined ? '-' : step.cache.keyHash.slice(0, 12),
    step.cache.bytes === undefined ? '-' : String(step.cache.bytes),
    formatMs(cacheMs(step)),
    formatMs(eventMs(step, 'model')),
    truncate(step.cache.reason ?? '-', 100),
  ]);

  return table(
    `[e2e debug] locate cache (${summary(located)})`,
    ['step', 'cache', 'key', 'bytes', 'cache time', 'model time', 'why'],
    rows,
    '(no locate calls recorded)',
    new Set([1, 6]),
  );
}

/** Wall time one step spent consulting the cache. */
function cacheMs(step: StepRecord): number {
  return step.events
    .filter((event) => event.kind === 'driver' && event.name === CACHE_REPLAY_EVENT)
    .reduce((total, event) => total + event.durationMs, 0);
}

/**
 * One-line verdict: the status mix over locate calls, what consulting the cache
 * cost, and what the hits plausibly saved.
 *
 * The saving is an estimate and says so. A hit avoids exactly one locate model
 * call, but that call never happened, so it is priced at the mean model call the
 * locates in this same run actually measured. Judgments and extractions are
 * excluded from that mean — they are often far more expensive than a locate, and
 * including them would inflate the number. With no locate model call to compare
 * against there is no honest figure and none is printed.
 */
function summary(located: readonly (StepRecord & { cache: StepCacheInfo })[]): string {
  const counts = new Map<StepCacheInfo['status'], number>();
  for (const step of located) {
    counts.set(step.cache.status, (counts.get(step.cache.status) ?? 0) + 1);
  }
  const mix = [...counts.entries()]
    .toSorted((left, right) => right[1] - left[1])
    .map(([status, count]) => `${String(count)} ${status}`)
    .join(', ');
  const scope = `${mix} of ${String(located.length)} locate call${
    located.length === 1 ? '' : 's'
  }`;

  const spent = located.reduce((total, step) => total + cacheMs(step), 0);
  const modelMs = located.reduce((total, step) => total + eventMs(step, 'model'), 0);
  const modelCalls = located.reduce((total, step) => total + (step.model?.calls ?? 0), 0);
  const hits = counts.get('hit') ?? 0;

  const cost = `cache time ${formatMs(spent)}`;
  if (hits === 0 || modelCalls === 0) return `${scope}, ${cost}`;
  const saved = hits * (modelMs / modelCalls);
  const net = `net ${formatMs(Math.abs(saved - spent))} ${saved >= spent ? 'faster' : 'slower'}`;
  return `${scope}, ${cost}, est. ${formatMs(saved)} model time avoided, ${net}`;
}
