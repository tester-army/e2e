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

/** Every size problem the case has against the runner's limits, as messages; empty when it fits. */
export function sizeProblems(testCase: CigeCase): string[] {
  const problems: string[] = [];
  const agentContext = renderAgentContext(testCase);
  if (agentContext !== undefined && bytes(agentContext) > MAX_AGENT_CONTEXT_BYTES) {
    problems.push(`Context renders to ${bytes(agentContext)} bytes of agentContext; the limit is ${MAX_AGENT_CONTEXT_BYTES}`);
  }
  for (const step of testCase.execution) {
    const text = step.kind === 'act' ? actInstruction(testCase, step) : step.text;
    if (bytes(text) > MAX_INSTRUCTION_BYTES) {
      problems.push(`Execution ${step.id} renders to ${bytes(text)} bytes with its guardrails; the limit is ${MAX_INSTRUCTION_BYTES}`);
    }
  }
  if (testCase.intent.judge && bytes(intentAssertion(testCase)) > MAX_INSTRUCTION_BYTES) {
    problems.push(`Intent renders to ${bytes(intentAssertion(testCase))} bytes; the limit is ${MAX_INSTRUCTION_BYTES}`);
  }
  return problems;
}
