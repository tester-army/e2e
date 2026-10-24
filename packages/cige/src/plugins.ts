/**
 * Plugins: a customer's own behavior, declared in `cige.config.ts` beside
 * the cases. A plugin can add model-visible context (the one way an `x-`
 * field reaches the model), stop an act step on an action the built-in
 * `deny` rules can't express, adjust the reporter's first classification,
 * add fields to a run summary, report readiness gaps, and register step
 * kinds an Execution entry runs with `"use"`. Plugins are your code, with
 * the runner's full OS authority, as hooks are.
 */

import type { ActionEvent, Report, TestFixtures } from 'e2e';

import type { CigeClassification, CigeFailureType } from './classify.ts';
import type { CigeRunSummary } from './reporter.ts';
import { CigeValidationError, ID_PATTERN, type CigeCase, type CigeExecutionStep } from './schema.ts';

/** A step a plugin runs, as the case resolved it: `with` has the variant's values filled in. */
export type CigeUseStep = Extract<CigeExecutionStep, { readonly kind: 'use' }>;

/** What a plugin's step runs with: the test's fixtures, the resolved case, and the step. */
export interface CigeStepContext<Fixtures = TestFixtures> {
  readonly fixtures: Fixtures;
  readonly testCase: CigeCase;
  readonly step: CigeUseStep;
}

/**
 * A step kind's code. Return to pass. Throw an e2e error (an `AgentError`
 * such as `ASSERTION_FAILED` for a check that failed) to keep its code; any
 * other throw fails the step as `ACTION_FAILED`, naming it.
 */
export type CigeStepRunner<Fixtures = TestFixtures> = (context: CigeStepContext<Fixtures>) => unknown;

/** An action a plugin refuses: the guardrail it breaks, by id, and why. */
export interface CigeGuardrailViolation {
  readonly guardrail: string;
  readonly reason: string;
}

/** What a plugin's `classify` changes: a failure type (`null` clears it), and signals to add. */
export interface CigeClassificationChange {
  readonly failureType?: CigeFailureType | null;
  readonly signals?: readonly string[];
}

export interface CigePlugin<Fixtures = TestFixtures> {
  /** Lowercase letters, digits, and dashes; unique among the config's plugins. Names its summary fields and gaps. */
  readonly name: string;
  /** Lines added to the case's `agentContext`, which every agent step reads. */
  readonly context?: (testCase: CigeCase) => string | readonly string[] | undefined;
  /** Called after every action of an `act` step, beside the `deny` rules; a violation stops the step with `POLICY_DENIED`. */
  readonly onAction?: (event: ActionEvent, testCase: CigeCase) => CigeGuardrailViolation | undefined;
  /** Adjusts the reporter's first classification of a result. */
  readonly classify?: (input: {
    readonly testCase: CigeCase;
    readonly result: Report['run']['results'][number];
    readonly classification: CigeClassification;
  }) => CigeClassificationChange | undefined;
  /** Fields added to a run summary, under `extensions.<plugin name>`. */
  readonly summarize?: (input: { readonly testCase: CigeCase; readonly summary: CigeRunSummary }) => Readonly<Record<string, unknown>> | undefined;
  /** Readiness gaps for `e2e-cige check` and the `CIGE gaps` row: a message, a list of them, or none. */
  readonly readiness?: (testCase: CigeCase) => string | readonly string[] | undefined;
  /** Step kinds an Execution entry runs with `{ "use": "<kind>", "with": {...} }`. */
  readonly steps?: Readonly<Record<string, CigeStepRunner<Fixtures>>>;
}

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every problem with a set of plugins: a malformed or repeated name, or a step kind two plugins register. */
export function pluginProblems(plugins: readonly CigePlugin<never>[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const kinds = new Map<string, string>();
  for (const plugin of plugins) {
    if (!PLUGIN_NAME.test(plugin.name)) problems.push(`plugin name ${JSON.stringify(plugin.name)}: use lowercase letters, digits, and dashes`);
    if (names.has(plugin.name)) problems.push(`plugin "${plugin.name}" is listed twice`);
    names.add(plugin.name);
    for (const kind of Object.keys(plugin.steps ?? {})) {
      if (!ID_PATTERN.test(kind)) problems.push(`plugin "${plugin.name}": step kind ${JSON.stringify(kind)} is not an id a case's "use" can name`);
      const other = kinds.get(kind);
      if (other !== undefined) problems.push(`step kind "${kind}" is registered by both "${other}" and "${plugin.name}"`);
      kinds.set(kind, plugin.name);
    }
  }
  return problems;
}

/** The runner a plugin registered for a step kind. */
export function stepRunnerOf<Fixtures>(plugins: readonly CigePlugin<Fixtures>[], kind: string): CigeStepRunner<Fixtures> | undefined {
  for (const plugin of plugins) {
    const steps = plugin.steps ?? {};
    if (Object.hasOwn(steps, kind)) return steps[kind];
  }
  return undefined;
}

/** The context lines every plugin adds for a case. A plugin that throws fails collection, naming it. */
export function pluginContext(plugins: readonly CigePlugin<never>[], testCase: CigeCase): string[] {
  return plugins.flatMap((plugin) => {
    if (plugin.context === undefined) return [];
    let lines: string | readonly string[] | undefined;
    try {
      lines = plugin.context(testCase);
    } catch (cause) {
      throw new CigeValidationError(testCase.file ?? testCase.id, [`plugin "${plugin.name}" context failed: ${cause instanceof Error ? cause.message : String(cause)}`]);
    }
    if (lines === undefined) return [];
    return (typeof lines === 'string' ? [lines] : [...lines]).filter((line) => line.trim() !== '');
  });
}
