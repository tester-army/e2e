/**
 * The `agent` fixture (spec 02-test-api.md).
 *
 * Two tiers, deliberately few methods. `act` plans and executes a flow on the
 * executor socket; `assert`, `waitFor`, and `extract` are the judgment tier —
 * each one bounded invocation with a fresh observation, an explicit deadline,
 * and a model-call budget. The located action verbs of v1 were retired: an
 * action either has an exact deterministic address (`screen.*`) or it is part
 * of a planned flow (`agent.act`), and one cache design serves the latter.
 */

import { isVisionMode } from '../config/agent.ts';
import { TestError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import type { StepRunOptions } from '../run/steps.ts';
import type { Agent, StandardSchemaV1, VisionMode } from '../types.ts';
import { AgentError, isAgentError, toAgentError } from './error.ts';
import { resolveBoundedBudget, resolveTimeout } from './call-options.ts';
import { runActStep, runAssertStep } from './act.ts';
import { observationShape, type AgentObservation } from './observation.ts';
import {
  Invocation,
  type AgentContext,
  type InvocationOptions,
} from './invocation.ts';
import type { PromptInput } from './prompts.ts';
import { acceptAnyJson, JUDGMENT_SCHEMA, validateJudgmentResponse } from './protocol.ts';
import { EXTRACT_REQUEST, JUDGMENT_REQUEST } from './prompts.ts';
import { deriveJsonSchema } from './model/schema.ts';

const MIN_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 3_000;

/**
 * How often `waitFor` looks at the screen between judgments.
 *
 * An observation is backend-only work, so it is far cheaper than a model call —
 * but it is not free: it walks the document and swaps the session's reference
 * generation, which invalidates any node reference taken from the previous one.
 * That is safe here because a judgment reads only the observation text, and it
 * is the reason this interval is not shorter.
 */
const CHANGE_POLL_MS = 500;
const EXTRACT_MODEL_CALLS = 2;

/** Builds the agent fixture for one attempt. */
export function createAgentFixture(runtime: AgentContext): Agent {
  /**
   * Default budget for polling, judgment, and extraction steps: the action
   * timeout expresses the suite's model-latency headroom in one place, with a
   * 30 s floor (spec 02-test-api.md). Tests then rarely need per-call
   * timeouts.
   */
  const stepTimeout = Math.max(MIN_STEP_TIMEOUT_MS, runtime.config.actionTimeout);

  /** A per-call `vision` value always wins over the project default. */
  const resolveVision = (requested: VisionMode | undefined): VisionMode => {
    if (requested === undefined) return runtime.config.agent.vision;
    if (!isVisionMode(requested)) {
      throw new TestError('INVALID_ARGUMENT', "vision must be true, false, 'fallback', or 'only'");
    }
    return requested;
  };

  /**
   * Runs one agent method as a top-level step carrying agent metrics. A
   * judgment (`assert`, `waitFor`) is a verification step: its passing is what
   * confirms the action traces staged before it (cache/context.ts).
   */
  const step = async <Value>(
    options: InvocationOptions,
    label: string,
    body: (invocation: Invocation) => Promise<Value>,
    stepOptions: StepRunOptions = {},
  ): Promise<Value> =>
    runtime.steps.run(
      'agent',
      options.api,
      label,
      async () => {
        const invocation = new Invocation(runtime, { ...options, label });
        try {
          return await body(invocation);
        } catch (cause) {
          throw toAgentError(cause);
        } finally {
          invocation.finish();
        }
      },
      stepOptions,
    );

  /** One judgment call against a fresh observation. */
  const askJudgment = (invocation: Invocation, instruction: string, observation: AgentObservation) =>
    invocation.ask({
      schemaName: 'agent-judgment-1',
      schema: JUDGMENT_SCHEMA,
      validate: validateJudgmentResponse,
      prompt: { request: JUDGMENT_REQUEST, instruction, observation },
    });

  const agent: Agent = {
    act: ((instruction: string, params?: Parameters<Agent['act']>[1], options?: Parameters<Agent['act']>[2]) =>
      runActStep(runtime, instruction, params, options)) as Agent['act'],
    waitFor(condition, options) {
      const intervalMs = validateInterval(options?.intervalMs);
      return step(
        {
          api: 'agent.waitFor',
          task: 'judge whether a condition holds',
          timeoutMs: resolveTimeout(options?.timeout, stepTimeout),
          maxModelCalls: resolveBoundedBudget(
            options?.maxModelCalls,
            runtime.config.agent.maxModelCalls,
            'maxModelCalls',
          ),
          vision: resolveVision(options?.vision),
        },
        condition,
        async (invocation) => {
          let observation = await invocation.observe();
          for (let round = 1; ; round += 1) {
            invocation.recordPoll('waitFor', round);
            const judgment = await askJudgment(invocation, condition, observation);
            invocation.note({ explanation: judgment.explanation });
            if (judgment.result) return;
            observation = await waitForNextJudgment(invocation, {
              since: observation,
              intervalMs,
              lastExplanation: judgment.explanation,
              signal: runtime.signal,
            });
          }
        },
        { verifies: true },
      );
    },

    extract(instruction, options) {
      requireStandardSchema(options.schema);
      const schema = options.schema;
      return step(
        {
          api: 'agent.extract',
          task: 'extract structured data from the observation',
          timeoutMs: resolveTimeout(options.timeout, stepTimeout),
          maxModelCalls: resolveBoundedBudget(options.maxModelCalls, EXTRACT_MODEL_CALLS, 'maxModelCalls'),
          vision: resolveVision(options.vision),
        },
        instruction,
        async (invocation) => {
          // A projection of the caller's schema lets the provider enforce the
          // shape; without one the repair loop is the only shape signal.
          const projected = await deriveJsonSchema(schema);
          const observation = await invocation.observe();
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
            invocation.recordSchemaRejection('agent-extract-1');
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
      // A custom executor judges assertions through the socket: swapping
      // brains swaps all the thinking. The built-in path keeps the optimized
      // single-judgment tier below (one model call, vision-capable).
      if (runtime.customExecutor) {
        return runAssertStep(runtime, assertion, options);
      }
      return step(
        {
          api: 'agent.assert',
          task: 'judge whether an assertion holds',
          timeoutMs: resolveTimeout(options?.timeout, stepTimeout),
          maxModelCalls: 1,
          vision: resolveVision(options?.vision),
        },
        assertion,
        async (invocation) => {
          const observation = await invocation.observe();
          const judgment = await askJudgment(invocation, assertion, observation);
          invocation.note({ explanation: judgment.explanation });
          // Spec 03-assertions.md: the report keeps the redacted screenshot
          // whenever `screenshot` allows it, on a passing judgment too.
          const screenshot = evidenceAllowed(invocation, options?.screenshot)
            ? await captureEvidence(invocation)
            : undefined;
          if (judgment.result) return;
          throw new AgentError('ASSERTION_FAILED', judgment.explanation, (screenshot === undefined ? {} : { screenshot }));
        },
        { verifies: true },
      );
    },
  };

  /**
   * Whether judgment evidence may be captured. Pixel evidence is omitted for
   * the rest of the attempt once any secret has been filled: an untrusted app
   * may mirror a secret anywhere on screen, so rectangle masking cannot prove
   * redaction. The denial is recorded whether or not a capture follows.
   */
  function evidenceAllowed(invocation: Invocation, requested: boolean | undefined): boolean {
    if (requested === false) return false;
    if (runtime.taint.value) {
      invocation.recordPolicy('assert.screenshot', 'denied', 'PIXEL_TAINTED');
      return false;
    }
    return true;
  }

  /** Captures redacted judgment evidence; best-effort, never fails the step. */
  async function captureEvidence(invocation: Invocation): Promise<string | undefined> {
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

/**
 * Waits until the next judgment is worth spending, and returns the observation
 * to spend it on.
 *
 * A judgment reads the observation and nothing else, so while the screen looks the
 * same the answer is the same and re-asking is a model call that can only repeat
 * itself. So a false judgment is followed by backend-only observations until the
 * screen actually changes, which is also what makes a condition that came true two
 * seconds ago cost two seconds rather than a full interval.
 *
 * `intervalMs` stays the rate limit it always was: at most one judgment per
 * interval, so a screen that changes continuously — a spinner, a countdown —
 * cannot spend the budget in a second.
 *
 * A vision call waits on the interval alone. An animation the tree cannot see is
 * still a real change, so there is nothing to compare and nothing to gain.
 *
 * Throws rather than returning on exhaustion, and checks before every
 * observation, so a timeout reports the caller's last judgment instead of a bare
 * deadline error.
 */
async function waitForNextJudgment(
  invocation: Invocation,
  options: {
    readonly since: AgentObservation;
    readonly intervalMs: number;
    readonly lastExplanation: string;
    readonly signal: AbortSignal;
  },
): Promise<AgentObservation> {
  const watchTree = !invocation.pixelTier;
  const tickMs = Math.min(options.intervalMs, CHANGE_POLL_MS);
  const judgedAt = Date.now();
  const judgedShape = observationShape(options.since);
  const timedOut = (cause?: unknown): AgentError =>
    new AgentError(
      'STEP_TIMEOUT',
      `waitFor timed out; last judgment: ${options.lastExplanation}`,
      cause === undefined ? {} : { cause },
    );
  for (;;) {
    if (invocation.deadline.expired()) throw timedOut();
    if (!invocation.canAsk()) {
      throw new AgentError(
        'STEP_BUDGET_EXHAUSTED',
        `waitFor exhausted its model-call budget; last judgment: ${options.lastExplanation}`,
      );
    }
    // Nothing is judged before the interval elapses, so nothing is observed
    // before it either: the first wait covers what remains of the interval,
    // and only then does the loop poll the tree at the change cadence.
    const untilInterval = options.intervalMs - (Date.now() - judgedAt);
    const wait = untilInterval > 0 ? untilInterval : tickMs;
    const remainder = Math.min(wait, invocation.deadline.remaining());
    if (remainder > 0) await sleep(remainder, options.signal);
    // An observation can outlive the deadline it was bounded by, and the bare
    // timeout it then reports would drop the judgment the author needs. The
    // wait owns that message whether the clock runs out between rounds or
    // during one.
    const observation = await invocation.observe().catch((cause: unknown) => {
      if (isAgentError(cause) && cause.code === 'STEP_TIMEOUT') throw timedOut(cause);
      throw cause;
    });
    if (Date.now() - judgedAt < options.intervalMs) continue;
    if (!watchTree || observationShape(observation) !== judgedShape) return observation;
  }
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
  const fieldPath = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
    .join('.');
  return fieldPath === '' ? issue.message : `${fieldPath}: ${issue.message}`;
}
