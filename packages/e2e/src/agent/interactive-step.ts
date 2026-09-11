/**
 * An agent step driven from outside the model loop. A dev-loop host
 * (`e2e mcp`) opens one, runs bodies against its context (observations,
 * grammar actions, project tools) one at a time for as long as the session
 * lasts, and ends it when the session closes. The step is dispatched like any
 * `agent.act()`: it is recorded on the attempt, runs under the step clock and
 * the attempt's cancellation, fills secrets under the same authorization, and
 * hard-stops the same way; only the brain is the host instead of a model.
 */

import type { ResolvedAgentConfig } from '../config/agent.ts';
import { ConfigurationError } from '../internal/errors.ts';
import type { AgentParams } from '../types.ts';
import { dispatchAgentStep, type DispatchAgent } from './act.ts';
import { validateParams } from './act-validation.ts';
import type { StepExecutor, StepExecutorContext, StepVerdict } from './executor.ts';
import type { AgentContext } from './invocation.ts';

/** Action and model-call budgets a host-driven step never reaches; the timeout is the real bound. */
const UNBOUNDED = 1_000_000;

export interface InteractiveStepOptions {
  /** What the step records as its instruction. */
  readonly instruction: string;
  /** Step parameters; a `Secret` value declares a credential the step may fill. */
  readonly params?: AgentParams | undefined;
  /** How long the step may live, in milliseconds. */
  readonly timeout: number;
}

export interface InteractiveStep {
  readonly context: StepExecutorContext;
  /** Runs one body inside the step, after every body submitted before it; what it records attributes to the step. */
  run<Value>(body: (context: StepExecutorContext) => Promise<Value>): Promise<Value>;
  /** Ends the step with the host's verdict and waits for it to be recorded; bodies still queued are refused. */
  end(verdict: StepVerdict): Promise<void>;
  /** Settles when the step has ended for any reason: `end`, its timeout, or a hard stop. */
  readonly done: Promise<{ readonly error?: unknown }>;
}

/**
 * Opens a step and resolves once its context is available. The step's agent
 * is the run's agent with the host as executor, so the configured model is
 * never resolved and the budgets a model loop needs do not apply.
 */
export async function openInteractiveStep(runtime: AgentContext, options: InteractiveStepOptions): Promise<InteractiveStep> {
  const { projected, secrets } = validateParams(options.params);
  const executor = new HostExecutor();
  const config: ResolvedAgentConfig = { ...runtime.config.agent, maxSteps: UNBOUNDED, maxModelCalls: UNBOUNDED };
  const agent: DispatchAgent = { name: executor.name, config, executor, agentContext: undefined };
  const done: Promise<{ readonly error?: unknown }> = dispatchAgentStep(
    runtime,
    {
      api: 'session',
      kind: 'act',
      instruction: options.instruction,
      params: projected,
      secrets,
      defaultFailureCode: 'ACTION_FAILED',
      timeout: options.timeout,
      maxSteps: undefined,
      maxModelCalls: undefined,
      agent: undefined,
    },
    agent,
  ).then(
    () => ({}),
    (error: unknown) => ({ error }),
  );
  const context = await Promise.race([
    executor.context,
    done.then((outcome) => {
      throw outcome.error ?? new Error('the step ended before it started');
    }),
  ]);
  return {
    context,
    run: (body) => executor.submit(body),
    end: async (verdict) => {
      executor.finish(verdict);
      await done;
    },
    done,
  };
}

interface Job {
  run: (context: StepExecutorContext) => Promise<unknown>;
  settle: (outcome: { value?: unknown; error?: unknown }) => void;
}

/**
 * The executor behind an interactive step: `runStep` hands its context out
 * and then runs, one at a time and in order, every job the host submits,
 * until the host finishes the step or the harness stops it. Jobs run inside
 * the step's async scope, so the recorder attributes their events to the step.
 */
class HostExecutor implements StepExecutor {
  readonly name = 'session-host';
  readonly version = '1';
  readonly cache = 'off' as const;
  private readonly jobs: Job[] = [];
  private wake: (() => void) | undefined;
  private verdict: StepVerdict | undefined;
  private stopped: unknown | undefined;
  private resolveContext!: (context: StepExecutorContext) => void;
  /** The step context, once the harness opened the step. */
  readonly context: Promise<StepExecutorContext> = new Promise((resolve) => {
    this.resolveContext = resolve;
  });

  async runStep(context: StepExecutorContext): Promise<StepVerdict> {
    this.resolveContext(context);
    const onAbort = (): void => this.stop(context.signal.reason ?? new Error('the step was stopped'));
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (this.verdict === undefined && this.stopped === undefined) {
        const job = this.jobs.shift();
        if (job === undefined) {
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          continue;
        }
        try {
          job.settle({ value: await job.run(context) });
        } catch (error) {
          job.settle({ error });
        }
      }
    } finally {
      context.signal.removeEventListener('abort', onAbort);
      this.drain();
    }
    if (this.verdict !== undefined) return this.verdict;
    throw this.stopped;
  }

  submit<Value>(run: (context: StepExecutorContext) => Promise<Value>): Promise<Value> {
    if (this.verdict !== undefined || this.stopped !== undefined) {
      return Promise.reject(new ConfigurationError('NO_SESSION', 'the session has ended; open_session again'));
    }
    return new Promise<Value>((resolve, reject) => {
      this.jobs.push({
        run,
        settle: (outcome) => (outcome.error === undefined ? resolve(outcome.value as Value) : reject(outcome.error)),
      });
      this.wakeUp();
    });
  }

  finish(verdict: StepVerdict): void {
    this.verdict ??= verdict;
    this.wakeUp();
  }

  private stop(reason: unknown): void {
    this.stopped ??= reason;
    this.wakeUp();
  }

  private wakeUp(): void {
    this.wake?.();
    this.wake = undefined;
  }

  private drain(): void {
    const reason = new ConfigurationError('NO_SESSION', 'the session ended before this call ran');
    for (const job of this.jobs.splice(0)) job.settle({ error: reason });
  }
}
