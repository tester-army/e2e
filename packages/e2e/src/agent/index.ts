/**
 * The `agent` fixture (spec 02-test-api.md).
 *
 * Test code drives execution: each method below is one bounded invocation with
 * a fresh observation, an explicit deadline, and a model-call budget. The
 * planning tier (`act`, `login`) is not part of this milestone.
 */

import path from 'node:path';
import { isVisionMode } from '../config/agent.ts';
import type { SemanticNode } from '../driver/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { sleep } from '../internal/time.ts';
import { describeExpression } from '../locator/expression.ts';
import { isSecret, validateLongPress } from '../locator/screen.ts';
import type {
  Agent,
  InstantActionOptions,
  Momentum,
  ScrollDirection,
  SelectOption,
  StandardSchemaV1,
  VisionMode,
} from '../types.ts';
import { AgentError } from './error.ts';
import { observationShape, type AgentObservation } from './observation.ts';
import {
  Invocation,
  toAgentError,
  type AgentContext,
  type InvocationOptions,
} from './invocation.ts';
import type { PromptInput } from './prompts.ts';
import {
  locateOne,
  locateByScrolling,
  NODE_ONLY,
  type Located,
  type LocatedNode,
  type LocatedPoint,
  type PointPolicy,
} from './locate.ts';
import { acceptAnyJson, JUDGMENT_SCHEMA, validateJudgmentResponse } from './protocol.ts';
import { EXTRACT_REQUEST, JUDGMENT_REQUEST } from './prompts.ts';
import { deriveJsonSchema } from './model/schema.ts';
import { authorizeSecretFill } from './secrets.ts';

const MIN_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INTERVAL_MS = 3_000;

/**
 * How often `waitFor` looks at the page between judgments.
 *
 * An observation is driver-only work, so it is far cheaper than a model call —
 * but it is not free: it walks the document and swaps the session's reference
 * generation, which invalidates any node reference taken from the previous one.
 * That is safe here because a judgment reads only the observation text, and it
 * is the reason this interval is not shorter.
 */
const CHANGE_POLL_MS = 500;
const EXTRACT_MODEL_CALLS = 2;

/** Builds the agent fixture for one attempt. */
export function createAgent(runtime: AgentContext): Agent {
  const testIdAttribute = runtime.config.testIdAttribute;
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
   * The model-call budget of a locating method under one vision mode.
   *
   * `'fallback'` can run the locate twice — once on the tree, once on pixels —
   * so it needs room for both tiers. It is a doubling rather than a separate
   * number because each tier is the same locate with the same repair round.
   */
  const locateCalls = (perTier: number, vision: VisionMode): number =>
    vision === 'fallback' ? perTier * 2 : perTier;

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

  /** Runs one action, translating a driver failure into agent prose. */
  const dispatch = async (
    invocation: Invocation,
    api: string,
    target: string,
    located: Located,
    body: () => Promise<void>,
  ): Promise<void> => {
    try {
      await body();
    } catch (cause) {
      throw explainActionFailure(invocation, api, target, located, cause);
    }
  };

  /**
   * Locates one node and performs exactly one predetermined driver action.
   *
   * `pointAction` opts the method into the vision pointing tier. Supplying it
   * is what shows the model the pointing grammar in the first place, so a
   * method with no coordinate equivalent is never offered a coordinate.
   */
  const instant = (spec: {
    readonly api: string;
    readonly target: string;
    readonly options: InstantActionOptions | undefined;
    /**
     * Non-secret call parameters that belong in the cache key. Required, so that
     * adding a located action forces a decision about what its key covers; `{}`
     * only when the call really has no parameters.
     */
    readonly input: Readonly<Record<string, unknown>>;
    readonly action: (invocation: Invocation, located: LocatedNode) => Promise<void>;
    readonly pointAction?: (invocation: Invocation, located: LocatedPoint) => Promise<void>;
  }): Promise<void> => {
    const { api, target, options, input, action, pointAction } = spec;
    const vision = resolveVision(options?.vision);
    const point: PointPolicy<null> =
      pointAction === undefined
        ? NODE_ONLY
        : {
            allowed: true,
            perform: async (invocation, located) => {
              await dispatch(invocation, api, target, located, () =>
                pointAction(invocation, located),
              );
              return null;
            },
          };
    return step(
      {
        api,
        task: `select one node for ${api}`,
        timeoutMs: resolveTimeout(options?.timeout, runtime.config.actionTimeout),
        // One locate plus room for exactly one repair round: a hallucinated
        // node id or stale revision is invalid output, not a lost test.
        maxModelCalls: locateCalls(2, vision),
        maxActionSteps: 1,
        cache: options?.cache ?? true,
        vision,
      },
      target,
      async (invocation) => {
        const located = await locateOne(invocation, target, { testIdAttribute, input, point });
        // Null means the model pointed and the policy already dispatched.
        if (located === null) return;
        await dispatch(invocation, api, target, located, () => action(invocation, located));
      },
    );
  };

  /** One judgment call against a fresh observation. */
  const askJudgment = (invocation: Invocation, instruction: string, observation: AgentObservation) =>
    invocation.ask({
      schemaName: 'agent-judgment-1',
      schema: JUDGMENT_SCHEMA,
      validate: validateJudgmentResponse,
      prompt: { request: JUDGMENT_REQUEST, instruction, observation },
    });

  /** `tap` and `click` are the same located action under two spec names. */
  const tapVerb =
    (api: string) =>
    (target: string, options?: InstantActionOptions): Promise<void> =>
      instant({
        api,
        target,
        options,
        input: {},
        action: (invocation, located) =>
          invocation.commit('tap', () =>
            invocation.session.actions.tap({ ref: located.ref }, invocation.operation()),
          ),
        pointAction: (invocation, located) => tapAtPoint(invocation, api, located),
      });

  /**
   * Taps a validated screenshot point. The dispatch is at the point itself:
   * moving to the center of the hit-tested node would leave the pixels the
   * model chose, which on a canvas is the whole surface.
   */
  const tapAtPoint = (
    invocation: Invocation,
    api: string,
    located: LocatedPoint,
  ): Promise<void> => {
    const tapPoint = invocation.session.actions.tapPoint;
    if (tapPoint === undefined) {
      throw new ConfigurationError(
        'UNSUPPORTED_CAPABILITY',
        `${api} received a screenshot point, but the driver has no coordinate input; ` +
          'vision pointing requires a driver implementing tapPoint',
      );
    }
    return invocation.commit('tapPoint', () => tapPoint(located.point, invocation.operation()));
  };

  const planningTierUnavailable = (api: string): never => {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `${api} is the planning tier and is not implemented yet; use the located-action and judgment methods`,
    );
  };

  const agent: Agent = {
    act: ((): never => planningTierUnavailable('agent.act')) as Agent['act'],
    login: ((): never => planningTierUnavailable('agent.login')) as Agent['login'],

    tap: tapVerb('agent.tap'),
    click: tapVerb('agent.click'),

    type(target, value, options) {
      const sensitive = isSecret(value);
      if (!sensitive && typeof value !== 'string') {
        throw new TestError('INVALID_ARGUMENT', 'agent.type value must be a string or a Secret');
      }
      return instant({
        api: 'agent.type',
        target,
        options,
        // A secret contributes only its stable name and purpose: its value must
        // never reach a cache key, not even through a digest.
        input: sensitive ? { sensitiveName: value.name, purpose: value.purpose } : { value },
        action: async (invocation, located) => {
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
        },
      });
    },

    longPress(target, options) {
      const durationMs = validateLongPress(options?.durationMs);
      return instant({
        api: 'agent.longPress',
        target,
        options,
        input: { durationMs },
        action: (invocation, located) =>
          invocation.commit('longPress', () =>
            invocation.session.actions.longPress(
              { ref: located.ref },
              durationMs,
              invocation.operation(),
            ),
          ),
      });
    },

    press(target, key, options) {
      if (typeof key !== 'string' || key.trim() === '' || key.length > 64) {
        throw new TestError('INVALID_ARGUMENT', 'agent.press key must be a short non-empty string');
      }
      return instant({
        api: 'agent.press',
        target,
        options,
        input: { key },
        action: (invocation, located) =>
          invocation.commit('press', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'press', key },
              invocation.operation(),
            ),
          ),
      });
    },

    select(target, value, options) {
      validateSelectOption(value);
      return instant({
        api: 'agent.select',
        target,
        options,
        input: { value },
        action: (invocation, located) =>
          invocation.commit('selectOption', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'selectOption', value },
              invocation.operation(),
            ),
          ),
      });
    },

    hover(target, options) {
      return instant({
        api: 'agent.hover',
        target,
        options,
        input: {},
        action: (invocation, located) =>
          invocation.commit('hover', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'hover' },
              invocation.operation(),
            ),
          ),
      });
    },

    check(target, options) {
      return instant({
        api: 'agent.check',
        target,
        options,
        input: {},
        action: (invocation, located) =>
          invocation.commit('check', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'check' },
              invocation.operation(),
            ),
          ),
      });
    },

    uncheck(target, options) {
      return instant({
        api: 'agent.uncheck',
        target,
        options,
        input: {},
        action: (invocation, located) =>
          invocation.commit('uncheck', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'uncheck' },
              invocation.operation(),
            ),
          ),
      });
    },

    upload(target, paths, options) {
      const resolved = validateUploadPaths(paths, runtime.config.projectRoot);
      return instant({
        api: 'agent.upload',
        target,
        options,
        input: { paths: resolved },
        action: (invocation, located) =>
          invocation.commit('setInputFiles', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'setInputFiles', paths: resolved },
              invocation.operation(),
            ),
          ),
      });
    },

    dragTo(source, destination, options) {
      const dragVision = resolveVision(options?.vision);
      return step(
        {
          api: 'agent.dragTo',
          task: 'select one drag source and one drop destination',
          timeoutMs: resolveTimeout(options?.timeout, runtime.config.actionTimeout),
          // Two locates, each with room for one repair round.
          maxModelCalls: locateCalls(4, dragVision),
          maxActionSteps: 1,
          cache: options?.cache ?? true,
          vision: dragVision,
        },
        `${source} \u2192 ${destination}`,
        async (invocation) => {
          const from = await locateOne(invocation, source, { testIdAttribute, input: {} });
          const to = await locateOne(invocation, destination, { testIdAttribute, input: {} });
          try {
            await invocation.commit('dragTo', () =>
              invocation.session.screen.perform(
                from.ref,
                { kind: 'dragTo', target: to.ref },
                invocation.operation(),
              ),
            );
          } catch (cause) {
            throw explainActionFailure(invocation, 'agent.dragTo', source, from, cause);
          }
        },
      );
    },

    scroll(options) {
      const direction = validateDirection(options.direction);
      const momentum = validateMomentum(options.momentum);
      const within = options.within;
      const scrollVision = resolveVision(options.vision);
      return step(
        {
          api: 'agent.scroll',
          task: 'select one scrollable container',
          timeoutMs: resolveTimeout(options.timeout, runtime.config.actionTimeout),
          maxModelCalls: within === undefined ? 0 : locateCalls(2, scrollVision),
          maxActionSteps: 1,
          cache: options.cache ?? true,
          vision: scrollVision,
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
          const located = await locateOne(invocation, within, {
            testIdAttribute,
            input: { direction, ...(momentum === undefined ? {} : { momentum }) },
          });
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
          timeoutMs: resolveTimeout(options?.timeout, stepTimeout),
          maxModelCalls: runtime.config.agent.maxModelCalls,
          maxActionSteps: runtime.config.agent.maxSteps,
          cache: options?.cache ?? true,
          vision: resolveVision(options?.vision),
        },
        target,
        async (invocation) => {
          const located = await locateByScrolling(
            invocation,
            target,
            { testIdAttribute, input: { direction } },
            () =>
              invocation.commit('scroll', () =>
                invocation.session.actions.scroll(direction, {}, invocation.operation()),
              ),
          );
          await invocation.commit('scrollIntoView', () =>
            invocation.session.screen.perform(
              located.ref,
              { kind: 'scrollIntoView' },
              invocation.operation(),
            ),
          );
        },
      );
    },

    waitFor(condition, options) {
      const intervalMs = validateInterval(options?.intervalMs);
      return step(
        {
          api: 'agent.waitFor',
          task: 'judge whether a condition holds',
          timeoutMs: resolveTimeout(options?.timeout, stepTimeout),
          maxModelCalls: resolveModelCalls(
            options?.maxModelCalls,
            runtime.config.agent.maxModelCalls,
          ),
          maxActionSteps: 0,
          cache: false,
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
          maxModelCalls: resolveModelCalls(options.maxModelCalls, EXTRACT_MODEL_CALLS),
          maxActionSteps: 0,
          cache: false,
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
      return step(
        {
          api: 'agent.assert',
          task: 'judge whether an assertion holds',
          timeoutMs: resolveTimeout(options?.timeout, stepTimeout),
          maxModelCalls: 1,
          maxActionSteps: 0,
          cache: false,
          vision: resolveVision(options?.vision),
        },
        assertion,
        async (invocation) => {
          const observation = await invocation.observe();
          const judgment = await askJudgment(invocation, assertion, observation);
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

/**
 * Waits until the next judgment is worth spending, and returns the observation
 * to spend it on.
 *
 * A judgment reads the observation and nothing else, so while the page looks the
 * same the answer is the same and re-asking is a model call that can only repeat
 * itself. So a false judgment is followed by driver-only observations until the
 * page actually changes, which is also what makes a condition that came true two
 * seconds ago cost two seconds rather than a full interval.
 *
 * `intervalMs` stays the rate limit it always was: at most one judgment per
 * interval, so a page that changes continuously — a spinner, a countdown —
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
  for (;;) {
    if (invocation.deadline.expired()) {
      throw new AgentError(
        'STEP_TIMEOUT',
        `waitFor timed out; last judgment: ${options.lastExplanation}`,
      );
    }
    if (!invocation.canAsk()) {
      throw new AgentError(
        'STEP_BUDGET_EXHAUSTED',
        `waitFor exhausted its model-call budget; last judgment: ${options.lastExplanation}`,
      );
    }
    const remainder = Math.min(tickMs, invocation.deadline.remaining());
    if (remainder > 0) await sleep(remainder, options.signal);
    const observation = await invocation.observe();
    if (Date.now() - judgedAt < options.intervalMs) continue;
    if (!watchTree || observationShape(observation) !== judgedShape) return observation;
  }
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

function validateSelectOption(value: SelectOption): void {
  if (typeof value === 'string') {
    if (value !== '') return;
    throw new TestError('INVALID_ARGUMENT', 'agent.select value must not be empty');
  }
  if (typeof value === 'object' && value !== null) {
    if (typeof value.label === 'string' && value.label !== '') return;
    if (typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 0) {
      return;
    }
  }
  throw new TestError(
    'INVALID_ARGUMENT',
    'agent.select value must be an option label or { label } or { index }',
  );
}

/**
 * Upload paths come from trusted test code and resolve from the project root.
 * They never transit the model: the instruction carries only the target text.
 */
function validateUploadPaths(paths: string | readonly string[], projectRoot: string): string[] {
  const list = typeof paths === 'string' ? [paths] : [...paths];
  if (list.length === 0 || list.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'agent.upload requires one or more non-empty file paths',
    );
  }
  return list.map((entry) => path.resolve(projectRoot, entry));
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
  const fieldPath = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
    .join('.');
  return fieldPath === '' ? issue.message : `${fieldPath}: ${issue.message}`;
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
  located: Located,
  cause: unknown,
): AgentError {
  const error = toAgentError(cause);
  if (error.code !== 'ACTION_FAILED') return error;
  if (located.kind === 'point') {
    const explanation =
      `the model pointed at (${located.point.x}, ${located.point.y}) as ${JSON.stringify(target)}, ` +
      `but dispatching there failed: ${driverReason(error.message)}.`;
    invocation.note({ explanation });
    return new AgentError('ACTION_FAILED', `${api} failed: ${explanation}`, { cause: error });
  }
  const reasoning =
    located.explanation === '' ? '' : ` The model explained: ${located.explanation}`;
  const addressed =
    located.expression === undefined
      ? `by reference from observation ${located.observation.revision}`
      : describeExpression(located.expression);
  const explanation =
    `the model selected ${describeNode(located.node)} (${addressed}) ` +
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
