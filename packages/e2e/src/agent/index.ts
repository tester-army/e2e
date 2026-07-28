/**
 * The `agent` fixture (spec 02-test-api.md).
 *
 * Test code drives execution: each method below is one bounded invocation with
 * a fresh observation, an explicit deadline, and a model-call budget. The
 * planning tier (`act`, `login`) is not part of this milestone.
 */

import type { SemanticNode } from '../driver/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import { describeExpression } from '../locator/expression.ts';
import { isSecret, validateLongPress } from '../locator/screen.ts';
import type { Agent, Momentum, ScrollDirection, StandardSchemaV1 } from '../types.ts';
import { AgentError, isAgentError } from './error.ts';
import {
  Invocation,
  toAgentError,
  type AgentContext,
  type InvocationOptions,
} from './invocation.ts';
import type { PromptInput } from './prompts.ts';
import { locateOne, observeAndSelect, resolveSelected, type LocatedNode } from './locate.ts';
import { acceptAnyJson, JUDGMENT_SCHEMA, validateJudgmentResponse } from './protocol.ts';
import { EXTRACT_REQUEST, JUDGMENT_REQUEST } from './prompts.ts';
import { deriveJsonSchema } from './model/schema.ts';
import { authorizeSecretFill } from './secrets.ts';

const POLLING_TIMEOUT_MS = 30_000;
const JUDGMENT_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 3_000;
const EXTRACT_MODEL_CALLS = 2;

/** Builds the agent fixture for one attempt. */
export function createAgent(runtime: AgentContext): Agent {
  const testIdAttribute = runtime.config.testIdAttribute;

  /** Runs one agent method as a top-level step carrying agent metrics. */
  const step = async <Value>(
    options: InvocationOptions,
    label: string,
    body: (invocation: Invocation) => Promise<Value>,
  ): Promise<Value> =>
    runtime.steps.run('agent', options.api, label, async () => {
      const invocation = new Invocation(runtime, { ...options, label });
      try {
        return await body(invocation);
      } catch (cause) {
        throw toAgentError(cause);
      } finally {
        invocation.finish();
      }
    });

  /** Locates one node and performs exactly one predetermined driver action. */
  const instant = (
    api: string,
    target: string,
    options: { timeout?: number; cache?: boolean } | undefined,
    action: (invocation: Invocation, located: LocatedNode) => Promise<void>,
  ): Promise<void> =>
    step(
      {
        api,
        task: `select one node for ${api}`,
        timeoutMs: resolveTimeout(options?.timeout, runtime.config.actionTimeout),
        maxModelCalls: 1,
        maxActionSteps: 1,
        cache: options?.cache ?? true,
      },
      target,
      async (invocation) => {
        const located = await locateOne(invocation, target, { testIdAttribute });
        invocation.note({ observationRevision: located.observation.revision });
        try {
          await action(invocation, located);
        } catch (cause) {
          throw explainActionFailure(invocation, api, target, located, cause);
        }
      },
    );

  const planningTierUnavailable = (api: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `${api} is the planning tier and is not implemented yet; use the located-action and judgment methods`,
    );
  };

  const agent: Agent = {
    act: ((): never => planningTierUnavailable('agent.act')) as Agent['act'],
    login: ((): never => planningTierUnavailable('agent.login')) as Agent['login'],

    tap(target, options) {
      return instant('agent.tap', target, options, (invocation, located) =>
        invocation.commit('tap', () =>
          invocation.session.actions.tap({ ref: located.ref }, invocation.operation()),
        ),
      );
    },

    click(target, options) {
      return instant('agent.click', target, options, (invocation, located) =>
        invocation.commit('tap', () =>
          invocation.session.actions.tap({ ref: located.ref }, invocation.operation()),
        ),
      );
    },

    type(target, value, options) {
      const sensitive = isSecret(value);
      if (!sensitive && typeof value !== 'string') {
        throw new TestError('INVALID_ARGUMENT', 'agent.type value must be a string or a Secret');
      }
      return instant('agent.type', target, options, async (invocation, located) => {
        const plaintext = sensitive
          ? await authorizeSecretFill(invocation, runtime, value, located.node)
          : value;
        await invocation.commit('type', () =>
          invocation.session.actions.type(
            { ref: located.ref },
            plaintext,
            sensitive,
            invocation.operation(),
          ),
        );
      });
    },

    longPress(target, options) {
      const durationMs = validateLongPress(options?.durationMs);
      return instant('agent.longPress', target, options, (invocation, located) =>
        invocation.commit('longPress', () =>
          invocation.session.actions.longPress(
            { ref: located.ref },
            durationMs,
            invocation.operation(),
          ),
        ),
      );
    },

    scroll(options) {
      const direction = validateDirection(options.direction);
      const momentum = validateMomentum(options.momentum);
      const within = options.within;
      return step(
        {
          api: 'agent.scroll',
          task: 'select one scrollable container',
          timeoutMs: resolveTimeout(options.timeout, runtime.config.actionTimeout),
          maxModelCalls: within === undefined ? 0 : 1,
          maxActionSteps: 1,
          cache: options.cache ?? true,
        },
        within === undefined ? direction : `${direction} within ${within}`,
        async (invocation) => {
          const momentumOption = momentum === undefined ? {} : { momentum };
          if (within === undefined) {
            await invocation.commit('scroll', () =>
              invocation.session.actions.scroll(direction, momentumOption, invocation.operation()),
            );
            return;
          }
          const located = await locateOne(invocation, within, { testIdAttribute });
          invocation.note({ observationRevision: located.observation.revision });
          await invocation.commit('scroll', () =>
            invocation.session.actions.scroll(
              direction,
              { target: located.ref, ...momentumOption },
              invocation.operation(),
            ),
          );
        },
      );
    },

    scrollTo(target, options) {
      const direction = validateDirection(options?.direction ?? 'down');
      return step(
        {
          api: 'agent.scrollTo',
          task: 'select one node while scrolling toward it',
          timeoutMs: resolveTimeout(options?.timeout, POLLING_TIMEOUT_MS),
          maxModelCalls: runtime.config.agent.maxModelCalls,
          maxActionSteps: runtime.config.agent.maxSteps,
          cache: options?.cache ?? true,
        },
        target,
        async (invocation) => {
          let lastExplanation = '';
          for (let round = 1; ; round += 1) {
            invocation.recordPoll('scrollTo', round);
            const selection = await observeAndSelect(invocation, target);
            invocation.note({ observationRevision: selection.observation.revision });
            if (selection.declined) lastExplanation = selection.explanation;
            if (selection.selected !== null) {
              const located = await resolveSelected(
                invocation,
                {
                  observation: selection.observation,
                  selected: selection.selected,
                  explanation: selection.explanation,
                },
                { testIdAttribute },
              );
              await invocation.commit('scrollIntoView', () =>
                invocation.session.screen.perform(
                  located.ref,
                  { kind: 'scrollIntoView' },
                  invocation.operation(),
                ),
              );
              return;
            }
            if (invocation.deadline.expired() || !invocation.canAsk()) {
              if (lastExplanation !== '') invocation.note({ explanation: lastExplanation });
              throw new AgentError(
                'LOCATOR_NOT_FOUND',
                `scrollTo did not reach ${JSON.stringify(target)} within its budget${
                  lastExplanation === '' ? '' : `; the model reported: ${lastExplanation}`
                }`,
              );
            }
            await invocation.commit('scroll', () =>
              invocation.session.actions.scroll(direction, {}, invocation.operation()),
            );
          }
        },
      );
    },

    waitFor(condition, options) {
      const intervalMs = validateInterval(options?.intervalMs);
      return step(
        {
          api: 'agent.waitFor',
          task: 'judge whether a condition holds',
          timeoutMs: resolveTimeout(options?.timeout, POLLING_TIMEOUT_MS),
          maxModelCalls: resolveModelCalls(
            options?.maxModelCalls,
            runtime.config.agent.maxModelCalls,
          ),
          maxActionSteps: 0,
          cache: false,
        },
        condition,
        async (invocation) => {
          let lastExplanation = 'no judgment was produced';
          for (let round = 1; ; round += 1) {
            invocation.recordPoll('waitFor', round);
            const observation = await invocation.observe();
            const judgment = await invocation.ask({
              schemaName: 'agent-judgment-1',
              schema: JUDGMENT_SCHEMA,
              validate: validateJudgmentResponse,
              prompt: { request: JUDGMENT_REQUEST, instruction: condition, observation },
            });
            lastExplanation = judgment.explanation;
            invocation.note({
              observationRevision: observation.revision,
              explanation: judgment.explanation,
            });
            if (judgment.result) return;
            if (invocation.deadline.expired()) {
              throw new AgentError(
                'STEP_TIMEOUT',
                `waitFor timed out; last judgment: ${lastExplanation}`,
              );
            }
            if (!invocation.canAsk()) {
              throw new AgentError(
                'STEP_BUDGET_EXHAUSTED',
                `waitFor exhausted its model-call budget; last judgment: ${lastExplanation}`,
              );
            }
            await sleep(
              Math.min(intervalMs, Math.max(1, invocation.deadline.remaining())),
              runtime.signal,
            );
          }
        },
      );
    },

    extract(instruction, options) {
      requireStandardSchema(options.schema);
      const schema = options.schema;
      return step(
        {
          api: 'agent.extract',
          task: 'extract structured data from the observation',
          timeoutMs: resolveTimeout(options.timeout, EXTRACT_TIMEOUT_MS),
          maxModelCalls: resolveModelCalls(options.maxModelCalls, EXTRACT_MODEL_CALLS),
          maxActionSteps: 0,
          cache: false,
        },
        instruction,
        async (invocation) => {
          // A projection of the caller's schema lets the provider enforce the
          // shape; without one the repair loop is the only shape signal.
          const projected = await deriveJsonSchema(schema);
          const observation = await invocation.observe();
          invocation.note({ observationRevision: observation.revision });
          let repair: PromptInput['repair'];
          for (;;) {
            const candidate = await invocation.ask({
              schemaName: 'agent-extract-1',
              schema: projected,
              validate: acceptAnyJson,
              prompt: {
                request: EXTRACT_REQUEST,
                instruction,
                observation,
                ...(repair === undefined ? {} : { repair }),
              },
            });
            const validation = await schema['~standard'].validate(candidate);
            if (validation.issues === undefined) return validation.value;
            const issue = validation.issues.map(describeIssue).join('; ');
            invocation.recordPolicy('extract.schema', 'denied', 'MODEL_OUTPUT_INVALID');
            if (!invocation.canAsk()) {
              throw new AgentError(
                'MODEL_OUTPUT_INVALID',
                `extracted data failed schema validation: ${issue}`,
              );
            }
            repair = {
              issue,
              rawText: safeJson(candidate),
              requiredFields: requiredFields(validation.issues),
            };
          }
        },
      );
    },

    assert(assertion, options) {
      return step(
        {
          api: 'agent.assert',
          task: 'judge whether an assertion holds',
          timeoutMs: resolveTimeout(options?.timeout, JUDGMENT_TIMEOUT_MS),
          maxModelCalls: 1,
          maxActionSteps: 0,
          cache: false,
        },
        assertion,
        async (invocation) => {
          const observation = await invocation.observe();
          invocation.note({ observationRevision: observation.revision });
          const judgment = await invocation.ask({
            schemaName: 'agent-judgment-1',
            schema: JUDGMENT_SCHEMA,
            validate: validateJudgmentResponse,
            prompt: { request: JUDGMENT_REQUEST, instruction: assertion, observation },
          });
          invocation.note({ explanation: judgment.explanation });
          const screenshot = await captureEvidence(invocation, options?.screenshot);
          if (judgment.result) return;
          throw new AgentError('ASSERTION_FAILED', judgment.explanation, (screenshot === undefined ? {} : { screenshot }));
        },
      );
    },
  };

  /**
   * Captures redacted judgment evidence. Pixel evidence is omitted for the rest
   * of the attempt once any secret has been filled: an untrusted app may mirror
   * a secret anywhere on screen, so rectangle masking cannot prove redaction.
   */
  async function captureEvidence(
    invocation: Invocation,
    requested: boolean | undefined,
  ): Promise<string | undefined> {
    if (requested === false) return undefined;
    if (runtime.taint.value) {
      invocation.recordPolicy('assert.screenshot', 'denied', 'PIXEL_TAINTED');
      return undefined;
    }
    try {
      const relative = await invocation.session.artifacts.screenshot(
        'assert',
        invocation.operation(),
      );
      runtime.steps.attachArtifact(runtime.artifacts.register('screenshot', relative));
      return relative;
    } catch {
      return undefined;
    }
  }

  return agent;
}

function resolveTimeout(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', 'timeout must be a positive integer');
  }
  return requested;
}

function resolveModelCalls(requested: number | undefined, limit: number): number {
  if (requested === undefined) return limit;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new TestError('INVALID_ARGUMENT', 'maxModelCalls must be a positive integer');
  }
  if (requested > limit) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `maxModelCalls ${requested} exceeds the resolved limit ${limit}`,
    );
  }
  return requested;
}

function validateInterval(intervalMs: number | undefined): number {
  const value = intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `intervalMs must be an integer from 100 through 60000, got ${String(intervalMs)}`,
    );
  }
  return value;
}

function validateDirection(direction: ScrollDirection): ScrollDirection {
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new TestError('INVALID_ARGUMENT', `invalid scroll direction "${direction}"`);
  }
  return direction;
}

function validateMomentum(momentum: Momentum | undefined): Momentum | undefined {
  if (momentum === undefined) return undefined;
  if (!['none', 'slow', 'fast'].includes(momentum)) {
    throw new TestError('INVALID_ARGUMENT', `invalid momentum "${momentum}"`);
  }
  return momentum;
}

function requireStandardSchema(schema: unknown): void {
  const props = (schema as StandardSchemaV1 | undefined)?.['~standard'];
  if (props === undefined || props.version !== 1 || typeof props.validate !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'schema must implement Standard Schema v1');
  }
}

/**
 * Top-level fields the caller's schema requires, derived from issue paths. This
 * is the only shape signal Standard Schema exposes, and it is what lets one
 * repair attempt converge.
 */
function requiredFields(issues: readonly StandardSchemaV1.Issue[]): readonly string[] {
  const fields = new Set<string>();
  for (const issue of issues) {
    const first = issue.path?.[0];
    if (first === undefined) continue;
    const key = typeof first === 'object' ? first.key : first;
    if (typeof key === 'string') fields.add(key);
  }
  return [...fields];
}

/** Serializes a rejected value for the repair prompt without throwing. */
function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function describeIssue(issue: StandardSchemaV1.Issue): string {
  const path = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
    .join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

/**
 * An action that fails on the node the model selected usually means the
 * instruction matched nothing on screen and the model picked the closest
 * candidate. Naming that node makes the failure explain itself instead of
 * surfacing a bare driver error.
 */
function explainActionFailure(
  invocation: Invocation,
  api: string,
  target: string,
  located: LocatedNode,
  cause: unknown,
): Error {
  const error = toAgentError(cause);
  if (!isAgentError(error) || error.code !== 'ACTION_FAILED') return error;
  const reasoning =
    located.explanation === '' ? '' : ` The model explained: ${located.explanation}`;
  const explanation =
    `the model selected ${describeNode(located.node)} (${describeExpression(located.expression)}) ` +
    `as ${JSON.stringify(target)}, but that node rejected the action: ${driverReason(error.message)}.` +
    `${reasoning} Check that the current screen actually shows ${JSON.stringify(target)}.`;
  invocation.note({ explanation });
  return new AgentError('ACTION_FAILED', `${api} failed: ${explanation}`, { cause: error });
}

function describeNode(node: SemanticNode): string {
  const name = (node.name ?? node.text ?? '').replace(/\s+/g, ' ').trim();
  const role = node.role ?? 'node';
  return name === '' ? `a ${role}` : `the ${role} "${name}"`;
}

/** Keeps the driver's one-line reason and drops the multi-line call log. */
function driverReason(text: string): string {
  return (text.split(/\n\s*Call log:/i)[0] ?? text).trim();
}
