import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { resolveConfig } from '../../src/config/resolve.ts';
import { defineEngine } from '../../src/engine/index.ts';
import { createEngineSession } from '../../src/engine/session.ts';
import { providerFailureMessage, setErrorRedactor } from '../../src/internal/errors.ts';
import { Deadline } from '../../src/internal/time.ts';
import { AttemptBudget } from '../../src/run/budget.ts';
import { createFixtures } from '../../src/run/fixtures.ts';
import { StepRecorder } from '../../src/run/steps.ts';
import { WorkerModels } from '../../src/run/worker-models.ts';
import type { E2EConfig } from '../../src/types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

const DETAIL = '{"detail":"Unsupported service_tier: fast"}';

/** An OpenAI-compatible model whose server answers every request with `status`, `body`, and an empty status text, as HTTP/2 has none. */
function rejectingModel(status: number, body: string) {
  const fetch = async () => new Response(body, { status, statusText: '', headers: { 'content-type': 'application/json' } });
  return createOpenAICompatible({ name: 'fake', baseURL: 'https://provider.test/v1', apiKey: 'key', fetch }).chatModel('fake-model');
}

/** The error the AI SDK throws for one call to `model`. */
async function thrownBy(model: ReturnType<typeof rejectingModel>): Promise<unknown> {
  try {
    await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  } catch (error) {
    return error;
  }
  throw new Error('the call did not fail');
}

/** A real fixture graph with an in-memory engine and no runner process. */
function runtime(overrides: Partial<E2EConfig>) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
  const config = resolveConfig(
    { targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides },
    { projectRoot: process.cwd(), env: {} },
  );
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(600_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures };
}

describe('providerFailureMessage', () => {
  afterEach(() => {
    setErrorRedactor(undefined);
  });

  it('quotes the status and the body the SDK could not parse', async () => {
    expect(providerFailureMessage(await thrownBy(rejectingModel(400, DETAIL)))).toBe(`HTTP 400: ${DETAIL}`);
    expect(providerFailureMessage(await thrownBy(rejectingModel(502, '')))).toBe('HTTP 502');
  });

  it("keeps the provider's message when the SDK parsed the body", async () => {
    const error = await thrownBy(rejectingModel(400, '{"error":{"message":"model not found"}}'));
    expect(providerFailureMessage(error)).toBe('model not found');
    expect(providerFailureMessage(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('redacts secrets in the body before cutting it short', async () => {
    setErrorRedactor((text) => text.replaceAll('hunter2', '<secret:password>'));
    const echoed = await thrownBy(rejectingModel(400, '{"detail":"bad field: hunter2"}'));
    expect(providerFailureMessage(echoed)).toBe('HTTP 400: {"detail":"bad field: <secret:password>"}');
    // The secret straddles the cut: redacted whole first, no prefix of it survives.
    const straddling = await thrownBy(rejectingModel(500, `${'x'.repeat(1020)}hunter2${'y'.repeat(100)}`));
    const message = providerFailureMessage(straddling);
    expect(message).toBe(`HTTP 500: ${'x'.repeat(1020)}<sec…`);
    expect(message).not.toContain('hun');
  });

  it("reads a spent retry chain's last attempt", async () => {
    const { RetryError } = await loadAiSdk();
    const lastError = await thrownBy(rejectingModel(503, '<html>upstream unavailable</html>'));
    const chain = new RetryError({ message: 'Failed after 6 attempts. Last error: ', reason: 'maxRetriesExceeded', errors: [lastError] });
    expect(providerFailureMessage(chain)).toBe('HTTP 503: <html>upstream unavailable</html>');
  });

  it('names the status and the body in the failed agent step', async () => {
    const { fixtures } = runtime({ agents: { default: { model: rejectingModel(400, DETAIL) } } });

    await expect(fixtures.agent.act('open the page')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: `the model provider failed: HTTP 400: ${DETAIL}`,
    });
  });

  it('names the last attempt when a retryable failure spent its retries', async () => {
    const { fixtures } = runtime({ agents: { default: { model: rejectingModel(502, '<html>bad gateway</html>') } } });

    await expect(fixtures.agent.act('open the page')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: 'the model provider failed: HTTP 502: <html>bad gateway</html>',
    });
  });

  it('names the status and the body in a failed judgment', async () => {
    const { fixtures } = runtime({ agents: { default: { model: rejectingModel(400, DETAIL) } } });

    await expect(fixtures.agent.assert('the page is open')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: `model provider failed: HTTP 400: ${DETAIL}`,
    });
  });
});
