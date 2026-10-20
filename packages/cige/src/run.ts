/**
 * Runs one CIGE case inside a test body, in the order the standard reveals
 * it: preconditions, then each Execution step as its own `agent.act` goal
 * (or `agent.assert` check) with the guardrails on its instruction and the
 * structured ones checked after every action, then every piece of evidence
 * the Intent requires, then the Intent itself, judged on the screen. A pass
 * means each of those held: an Execution that merely ran is not a pass.
 */

import { AgentError, isAgentError, type ActOptions, type AgentParams, type TestFixtures } from 'e2e';

import { createGuardrailMonitor } from './guardrails.ts';
import { actInstruction, intentAssertion } from './render.ts';
import type { CigeCase } from './schema.ts';

/**
 * A precondition or evidence hook: your code, named from the CIGE file.
 * Resolve to `false` to fail an evidence item; throw to fail it with your
 * own message. An `AgentError` you throw keeps its code, so a hook that
 * finds the environment down can say so with `ENVIRONMENT_UNAVAILABLE`.
 */
export type CigeHook<Fixtures = TestFixtures> = (fixtures: Fixtures, testCase: CigeCase) => unknown;

export type CigeHooks<Fixtures = TestFixtures> = Readonly<Record<string, CigeHook<Fixtures>>>;

export interface RunCigeOptions<Fixtures = TestFixtures> {
  /** The hooks the case's preconditions and evidence name. */
  readonly hooks?: CigeHooks<Fixtures>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every hook name the case refers to that `hooks` does not define. */
export function missingHooks(testCase: CigeCase, hooks: Readonly<Record<string, unknown>> = {}): string[] {
  const names = [
    ...testCase.context.preconditions.flatMap((entry) => (entry.kind === 'hook' ? [entry.hook] : [])),
    ...testCase.intent.evidence.flatMap((item) => (item.kind === 'hook' ? [item.hook] : [])),
  ];
  return [...new Set(names)].filter((name) => !Object.hasOwn(hooks, name));
}

function hookOf<Fixtures>(hooks: CigeHooks<Fixtures>, name: string): CigeHook<Fixtures> {
  const hook = Object.hasOwn(hooks, name) ? hooks[name] : undefined;
  if (hook === undefined) throw new AgentError('TEST_SETUP_FAILED', `CIGE hook "${name}" is not defined; pass it in hooks`);
  return hook;
}

/** Runs one CIGE case against the test's fixtures. Throws on the first step that does not hold. */
export async function runCige<Fixtures extends TestFixtures>(
  testCase: CigeCase,
  fixtures: Fixtures,
  options: RunCigeOptions<Fixtures> = {},
): Promise<void> {
  const hooks = options.hooks ?? {};
  const { agent, app } = fixtures;

  if (testCase.context.open !== undefined) await app.open(testCase.context.open);

  for (const precondition of testCase.context.preconditions) {
    if (precondition.kind !== 'hook') continue;
    const hook = hookOf(hooks, precondition.hook);
    try {
      await hook(fixtures, testCase);
    } catch (cause) {
      if (isAgentError(cause)) throw cause;
      throw new AgentError('TEST_SETUP_FAILED', `CIGE precondition ${precondition.hook} failed: ${messageOf(cause)}`, { cause });
    }
  }

  const onAction = createGuardrailMonitor(testCase.guardrails);
  for (const step of testCase.execution) {
    if (step.kind === 'verify') {
      await agent.assert(step.text, step.vision === true ? { vision: true } : {});
      continue;
    }
    const actOptions: ActOptions = {
      ...(step.params === undefined ? {} : { params: step.params as AgentParams }),
      ...(onAction === undefined ? {} : { onAction }),
    };
    await agent.act(actInstruction(testCase, step), actOptions);
  }

  for (const item of testCase.intent.evidence) {
    if (item.kind === 'assert') {
      await agent.assert(item.text, item.vision === true ? { vision: true } : {});
      continue;
    }
    const hook = hookOf(hooks, item.hook);
    let held: unknown;
    try {
      held = await hook(fixtures, testCase);
    } catch (cause) {
      if (isAgentError(cause)) throw cause;
      throw new AgentError('ASSERTION_FAILED', `CIGE evidence ${item.id} not satisfied: ${messageOf(cause)}`, { cause });
    }
    if (held === false) {
      throw new AgentError('ASSERTION_FAILED', `CIGE evidence ${item.id} not satisfied: hook ${item.hook} returned false`);
    }
  }

  if (testCase.intent.judge) await agent.assert(intentAssertion(testCase));
}
