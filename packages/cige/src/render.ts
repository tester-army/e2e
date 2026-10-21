/**
 * What a CIGE case puts in front of the model, and nothing more. Context
 * becomes the test's `agentContext`, which every act turn and every judge
 * reads, so it holds facts only: no guardrail, no instruction, and never the
 * `specRef` or `buildRef` pointers, which stay for the agents that classify
 * a failure. Guardrails ride on each `act` instruction instead, where only
 * the acting agent sees them. The judges decide from Intent and the screen.
 */

import type { CigeCase, CigeExecutionStep } from './schema.ts';

/** `agentContext` holds at most 16 KiB. */
const MAX_AGENT_CONTEXT_BYTES = 16 * 1024;
/** An `agent.act` instruction or `agent.assert` statement holds at most 8192 bytes. */
const MAX_INSTRUCTION_BYTES = 8192;

/** The heading of the guardrail block appended to every `act` instruction. */
export const GUARDRAIL_HEADING = 'Guardrails (never violate one; if the step needs it, stop and conclude the step failed):';

function bytes(text: string): number {
  return Buffer.byteLength(text.normalize('NFC'), 'utf8');
}

/** The test's `agentContext`: the case's operating ground, facts only. */
export function renderAgentContext(testCase: CigeCase): string | undefined {
  const { context } = testCase;
  const lines: string[] = [];
  if (context.system !== undefined) lines.push(`System under test: ${context.system}`);
  if (context.environment !== undefined) lines.push(`Environment: ${context.environment}`);
  if (context.actor !== undefined) lines.push(`Acting as: ${context.actor}`);
  const facts = [
    ...context.preconditions.flatMap((entry) =>
      entry.kind === 'fact' ? [entry.text] : entry.description === undefined ? [] : [entry.description],
    ),
    ...context.facts,
  ];
  if (facts.length > 0) lines.push(['Known state:', ...facts.map((fact) => `- ${fact}`)].join('\n'));
  const parts = [lines.join('\n'), ...context.fragments.map((fragment) => fragment.trim())].filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** The guardrail block every `act` instruction of the case carries; empty without guardrails. */
function renderGuardrails(testCase: CigeCase): string {
  if (testCase.guardrails.length === 0) return '';
  return [GUARDRAIL_HEADING, ...testCase.guardrails.map((rule) => `- [${rule.id}] ${rule.rule}`)].join('\n');
}

/** The instruction one Execution step hands `agent.act`, guardrails included. */
export function actInstruction(testCase: CigeCase, step: CigeExecutionStep): string {
  const guardrails = renderGuardrails(testCase);
  return guardrails === '' ? step.text : `${step.text}\n\n${guardrails}`;
}

/** The statement the final judgment checks: the Intent, with its success and failure criteria. */
export function intentAssertion(testCase: CigeCase): string {
  const { intent } = testCase;
  const parts = [intent.statement];
  if (intent.success.length > 0) parts.push(['All of these hold:', ...intent.success.map((line) => `- ${line}`)].join('\n'));
  if (intent.failure.length > 0) parts.push(['None of these is true:', ...intent.failure.map((line) => `- ${line}`)].join('\n'));
  return parts.join('\n\n');
}

/** `agent.act` params hold at most 64 KiB of JSON, nested at most 32 levels. */
const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_PARAMS_DEPTH = 32;

function depthOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  // reduce, not a spread into Math.max: a wide array would overflow the call stack.
  return 1 + Object.values(value).reduce<number>((deepest, child) => Math.max(deepest, depthOf(child)), 0);
}

/**
 * Every problem the case has against the runner's limits, as messages; empty
 * when it fits: agentContext, each instruction and statement, and each
 * step's params. Load time is the place to find them, not the step that
 * would send them.
 */
export function sizeProblems(testCase: CigeCase): string[] {
  const problems: string[] = [];
  const agentContext = renderAgentContext(testCase);
  // Measured as written: the runner is not documented to normalize context.
  const contextBytes = agentContext === undefined ? 0 : Buffer.byteLength(agentContext, 'utf8');
  if (contextBytes > MAX_AGENT_CONTEXT_BYTES) {
    problems.push(`Context renders to ${contextBytes} bytes of agentContext; the limit is ${MAX_AGENT_CONTEXT_BYTES}`);
  }
  const statement = (label: string, text: string, suffix = ''): void => {
    if (bytes(text) > MAX_INSTRUCTION_BYTES) problems.push(`${label} renders to ${bytes(text)} bytes${suffix}; the limit is ${MAX_INSTRUCTION_BYTES}`);
  };
  for (const step of testCase.execution) {
    if (step.kind === 'verify') {
      statement(`Execution ${step.id}`, step.text);
      continue;
    }
    statement(`Execution ${step.id}`, actInstruction(testCase, step), ' with its guardrails');
    if (step.params === undefined) continue;
    const paramBytes = Buffer.byteLength(JSON.stringify(step.params), 'utf8');
    if (paramBytes > MAX_PARAMS_BYTES) problems.push(`Execution ${step.id}: params are ${paramBytes} bytes of JSON; the limit is ${MAX_PARAMS_BYTES}`);
    if (depthOf(step.params) > MAX_PARAMS_DEPTH) problems.push(`Execution ${step.id}: params nest deeper than ${MAX_PARAMS_DEPTH} levels`);
  }
  for (const item of testCase.intent.evidence) {
    if (item.kind === 'assert') statement(`Intent.evidence ${item.id}`, item.text);
  }
  if (testCase.intent.judge) statement('Intent', intentAssertion(testCase));
  return problems;
}
