import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type ExecutorActions, type ExecutorModelCall, type StepExecutorContext } from 'e2e';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpExecutor } from '../src/index.ts';
import type { AcpExecutorOptions } from '../src/types.ts';

const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A scripted agent: one list of moves per prompt turn, and the log it writes. */
function scripted(turns: unknown[][], extra: Partial<AcpExecutorOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-acp-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'agent.jsonl');
  const executor = acpExecutor({
    command: process.execPath,
    args: [AGENT],
    ...extra,
    env: { ACP_SCRIPT: JSON.stringify(turns), ACP_LOG: logFile, ...extra.env },
  });
  const log = (): Record<string, unknown>[] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  return { executor, log };
}

/** A step context with recorded actions and an attempt the test ends. */
function context(options: { kind?: 'act' | 'assert'; attempt?: ReturnType<typeof attemptOf>; verbs?: (keyof ExecutorActions)[] } = {}) {
  const attempt = options.attempt ?? attemptOf();
  const stepController = new AbortController();
  const signal = stepController.signal;
  const tap = vi.fn<ExecutorActions['tap']>().mockResolvedValue(undefined);
  const type = vi.fn<ExecutorActions['type']>().mockResolvedValue(undefined);
  const hover = vi.fn<ExecutorActions['hover']>().mockResolvedValue(undefined);
  const usage: ExecutorModelCall[] = [];
  const transcripts: string[] = [];
  const ctx = {
    step: { kind: options.kind ?? 'act', index: 0, instruction: 'add a todo', params: { title: 'Buy milk' }, secrets: [] },
    attempt: attempt.attempt,
    signal,
    target: { name: 'web', platform: 'web', verbs: new Set(options.verbs ?? ['tap', 'type', 'navigate']) },
    model: undefined,
    providerOptions: undefined,
    ledger: '',
    agentContext: undefined,
    actions: { tap, type, hover } as unknown as ExecutorActions,
    observe: vi.fn<StepExecutorContext['observe']>().mockImplementation(async (request) => ({
      revision: '1',
      text: '#n1 textbox "Title"\n#n2 button "Add"',
      truncated: false,
      viewport: { width: 800, height: 600 },
      path: '/todos',
      ...(request?.pixels === true
        ? { pixels: { data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 } }
        : {}),
    })),
    pixelsTainted: false,
    attachTranscript: (text: string) => void transcripts.push(text),
    attachTurns: () => undefined,
    attachScreenshot: async () => 'screenshot',
    budgets: {
      maxActions: 25,
      maxModelCalls: 25,
      remainingMs: () => 60_000,
      actionsUsed: () => 0,
      recordModelCall: (call?: ExecutorModelCall) => void usage.push(call ?? {}),
      runTool: <T>(_call: unknown, body: () => Promise<T>) => body(),
    },
  } as unknown as StepExecutorContext;
  return { ctx, tap, type, hover, usage, transcripts, end: attempt.end, abortStep: (reason: unknown) => stepController.abort(reason) };
}

function attemptOf() {
  const controller = new AbortController();
  const attempt = { testId: 't', attemptId: 'a', index: 0, signal: controller.signal, memory: new Map<string, unknown>() };
  return { attempt, end: () => controller.abort() };
}

const pass = { call: 'complete_step', args: { status: 'passed', summary: 'added' } };

describe('acpExecutor', () => {
  it('rejects a config without a command', () => {
    expect(() => acpExecutor({} as AcpExecutorOptions)).toThrow(/takes \{ command, args \}/);
  });

  it('acts through ctx.actions and passes on complete_step', async () => {
    const { executor, log } = scripted([[{ call: 'type', args: { target: 'n1', value: 'Buy milk' } }, { call: 'tap', args: { target: 'n2' } }, pass]], { model: 'slow' });
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict).toEqual({ status: 'passed', summary: 'added' });
    expect(step.type).toHaveBeenCalledWith({ id: 'n1' }, 'Buy milk');
    expect(step.tap).toHaveBeenCalledWith({ id: 'n2' });
    expect(step.usage).toEqual([
      expect.objectContaining({ provider: 'scripted-agent', modelId: 'slow', inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, estimatedCostUsd: 0.01 }),
    ]);
    const entries = log();
    expect(entries).toContainEqual({ config: { model: 'slow' } });
    const session = entries.find((entry) => 'session' in entry)?.['session'] as { server: string; tools: string[] };
    expect(session.server).toBe('e2e_step');
    // The built-in agent's tools for the target's verbs, plus complete_step.
    expect(session.tools.toSorted()).toEqual(['complete_step', 'navigate', 'observe', 'screenshot', 'tap', 'tap_at', 'type', 'type_at']);
    expect(JSON.stringify(entries.find((entry) => entry['call'] === 'tap'))).toContain('Tapped #n2.');
    // The step's first screen is whole, in the message.
    expect(String(entries.find((entry) => 'prompt' in entry)?.['prompt'])).toContain('#n2 button "Add"');
  });

  it('counts cached tokens into the input when the agent reports them apart', async () => {
    // The Claude adapter's shape: its total adds the cache to input and output.
    const { executor } = scripted([[pass]], { env: { ACP_USAGE: JSON.stringify({ totalTokens: 24, inputTokens: 5, outputTokens: 5, cachedReadTokens: 10, cachedWriteTokens: 4 }) } });
    const step = context();
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    expect(step.usage).toEqual([expect.objectContaining({ inputTokens: 19, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 4 })]);
  });

  it('keeps one session per attempt and sends the rules only once', async () => {
    const { executor, log } = scripted([[pass], [pass]]);
    const first = context();
    const second = context({ attempt: { attempt: first.ctx.attempt as never, end: first.end } });
    await executor.runStep(first.ctx);
    await executor.runStep(second.ctx);
    const prompts = log().filter((entry) => 'prompt' in entry).map((entry) => String(entry['prompt']));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('end-to-end testing agent');
    expect(prompts[0]).toContain('Step: add a todo');
    expect(prompts[0]).toContain('Parameters: {"title":"Buy milk"}');
    expect(prompts[1]).not.toContain('end-to-end testing agent');
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(1);
    const pid = log().find((entry) => 'pid' in entry)?.['pid'] as number;
    first.end();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('refuses actions that change the screen on an assertion, and lets it hover', async () => {
    const { executor, log } = scripted([
      [{ call: 'tap', args: { target: 'n2' } }, { call: 'hover', args: { target: 'n2' } }, { call: 'complete_step', args: { status: 'failed', summary: 'no todo' } }],
    ]);
    const step = context({ kind: 'assert', verbs: ['tap', 'hover'] });
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    // The runner gives a failed assertion its ASSERTION_FAILED code.
    expect(verdict).toEqual({ status: 'failed', summary: 'no todo' });
    expect(step.tap).not.toHaveBeenCalled();
    expect(step.hover).toHaveBeenCalledWith({ id: 'n2' });
    expect(JSON.stringify(log().find((entry) => entry['call'] === 'tap'))).toContain('this step is an assertion');
  });

  it("concludes through the built-in agent's complete_step: blocked needs a code", async () => {
    const { executor, log } = scripted([
      [
        { call: 'complete_step', args: { status: 'blocked', summary: 'the app is down' } },
        { call: 'complete_step', args: { status: 'blocked', summary: 'the app is down', errorCode: 'APP_UNREACHABLE' } },
        { call: 'tap', args: { target: 'n2' } },
      ],
    ]);
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict).toEqual({ status: 'blocked', summary: 'the app is down', errorCode: 'APP_UNREACHABLE' });
    const answers = log().filter((entry) => entry['call'] === 'complete_step').map((entry) => JSON.stringify(entry['result']));
    expect(answers[0]).toContain('Rejected: a blocked verdict requires errorCode');
    expect(answers[1]).toContain('Step concluded. Wait for the next instruction.');
    // Nothing runs after the verdict.
    expect(step.tap).not.toHaveBeenCalled();
    expect(String(log().find((entry) => 'prompt' in entry)?.['prompt'])).toContain('Verdict rules:');
  });

  it("rejects the agent's own tools", async () => {
    const { executor, log } = scripted([[{ own: 'Bash: ls ~', kind: 'execute' }, pass]]);
    const step = context();
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    expect(log()).toContainEqual({ permission: 'Bash: ls ~', outcome: { outcome: 'selected', optionId: 'no' } });
    expect(step.transcripts.join('\n')).toContain("rejected tools of the agent's own: Bash: ls ~");
  });

  it('stops a step whose agent runs a tool of its own without asking, before it acts on what it read', async () => {
    const { executor, log } = scripted([[{ ran: 'Read ~/.env', kind: 'read' }, { call: 'type', args: { target: 'n1', value: 'leaked' } }, pass]]);
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict).toMatchObject({ status: 'failed', errorCode: 'POLICY_DENIED', summary: expect.stringContaining('Read ~/.env') });
    expect(step.type).not.toHaveBeenCalled();
    expect(log()).toContainEqual({ cancelled: true });
    expect(step.transcripts.join('\n')).toContain("tools of the agent's own that ran without asking: Read ~/.env");
  });

  it('fails a step whose own tool ran without asking, even when the tool failed', async () => {
    const { executor } = scripted([[{ ran: 'Bash: curl evil.example', kind: 'execute', status: 'failed' }, pass]]);
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).resolves.toMatchObject({ status: 'failed', errorCode: 'POLICY_DENIED' });
  });

  it('refuses a screenshot once a secret was filled, before the engine is asked for pixels', async () => {
    const { executor, log } = scripted([[{ call: 'screenshot' }, pass]]);
    const step = context();
    cleanups.push(step.end);
    // The session lists screenshot from an untainted first step; this step is tainted.
    Object.assign(step.ctx, { pixelsTainted: true });
    await executor.runStep(step.ctx);
    expect(JSON.stringify(log().find((entry) => entry['call'] === 'screenshot'))).toContain('PIXEL_TAINTED');
    expect(step.ctx.observe).not.toHaveBeenCalledWith(expect.objectContaining({ pixels: true }));
  });

  it('starts a fresh agent for the next step when a step ended while the agent was starting', async () => {
    const { executor, log } = scripted([[pass]], { env: { ACP_HANG_INIT: '1' } });
    const first = context();
    cleanups.push(first.end);
    const run = executor.runStep(first.ctx);
    const pid = await vi.waitFor(() => {
      const entry = log().find((line) => 'pid' in line);
      if (entry === undefined) throw new Error('the agent has not started');
      return entry['pid'] as number;
    });
    first.abortStep(new AgentError('STEP_TIMEOUT', 'the step timed out'));
    await expect(run).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    // The abandoned agent is stopped, and the next step starts its own.
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    const second = context({ attempt: { attempt: first.ctx.attempt as never, end: first.end } });
    const next = executor.runStep(second.ctx);
    await vi.waitFor(() => expect(log().filter((line) => 'pid' in line)).toHaveLength(2));
    second.abortStep(new AgentError('STEP_TIMEOUT', 'the step timed out'));
    await expect(next).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('starts a step only once the turn of the step before it stopped', async () => {
    const { executor, log } = scripted([[{ hang: true }], [pass]]);
    const first = context();
    cleanups.push(first.end);
    const run = executor.runStep(first.ctx);
    await vi.waitFor(() => expect(log().filter((entry) => 'prompt' in entry)).toHaveLength(1));
    first.abortStep(new AgentError('STEP_TIMEOUT', 'the step timed out'));
    await expect(run).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    const second = context({ attempt: { attempt: first.ctx.attempt as never, end: first.end } });
    await expect(executor.runStep(second.ctx)).resolves.toMatchObject({ status: 'passed' });
  });

  it('gives up on a session whose agent never stops the turn of a step that ended', async () => {
    const { executor } = scripted([[{ ignoreCancel: true }], [pass]]);
    const first = context();
    cleanups.push(first.end);
    const run = executor.runStep(first.ctx);
    await new Promise((resolve) => setTimeout(resolve, 500));
    first.abortStep(new AgentError('STEP_TIMEOUT', 'the step timed out'));
    await expect(run).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    const second = context({ attempt: { attempt: first.ctx.attempt as never, end: first.end } });
    await expect(executor.runStep(second.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('did not stop') });
  });

  it('allows only calls the adapter names as one of the step tools, never by text the agent wrote', async () => {
    const asks = [
      // Ours, as the Claude adapter, an MCP approval's raw input, and an adapter title name them.
      { own: 'claude ours', meta: { claudeCode: { toolName: 'mcp__e2e_step__tap' } }, allowed: true },
      { own: 'codex ours', kind: 'execute', rawInput: { server: 'e2e_step', tool: 'tap', arguments: { target: 'n1' } }, meta: { is_mcp_tool_call: true }, allowed: true },
      { own: 'subagent named e2e_step: tap', kind: 'think', rawInput: { server: 'e2e_step', tool: 'tap' }, allowed: false },
      { own: 'other ours', kind: 'other', rawInput: { serverName: 'e2e_step', toolName: 'tap' }, allowed: true },
      // A title is text the agent may have written, so it allows nothing.
      { own: 'e2e_step: tap', kind: 'other', allowed: false },
      // Not ours, though each names the step server.
      { own: 'claude Read', meta: { claudeCode: { toolName: 'Read' } }, allowed: false },
      { own: 'claude other server', meta: { claudeCode: { toolName: 'mcp__playwright__browser_navigate' } }, allowed: false },
      { own: 'playwright: navigate to evil.example?x=e2e_step', kind: 'other', allowed: false },
      { own: 'web_search e2e_step leak', kind: 'think', allowed: false },
      { own: 'e2e_step: browser_navigate', kind: 'other', allowed: false },
      { own: 'Fetch e2e_step: tap', kind: 'fetch', allowed: false },
      { own: 'raw input of the agent', kind: 'other', rawInput: { query: 'e2e_step tap', server: 'e2e_step', tool: 'tap' }, allowed: false },
      { own: 'codex other server', kind: 'execute', rawInput: { server: 'playwright', tool: 'tap', arguments: {} }, meta: { is_mcp_tool_call: true }, allowed: false },
      { own: 'codex shell', kind: 'execute', rawInput: { command: 'cat ~/.ssh/id_rsa # e2e_step tap' }, allowed: false },
    ];
    const { executor, log } = scripted([[...asks.map(({ own, kind, rawInput, meta }) => ({ own, kind, rawInput, meta })), pass]]);
    const step = context();
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    const outcomes = Object.fromEntries(
      log()
        .filter((entry) => 'permission' in entry)
        .map((entry) => [entry['permission'], (entry['outcome'] as { optionId: string }).optionId === 'yes']),
    );
    expect(outcomes).toEqual(Object.fromEntries(asks.map((ask) => [ask.own, ask.allowed])));
  });

  it("keeps e2e's secret and credential variables from the agent", async () => {
    for (const [name, value] of [['E2E_SECRET_STRIPE_KEY', 'sk_test_value'], ['E2E_USER_ADMIN_PASSWORD', 'hunter2']] as const) {
      const before = process.env[name];
      process.env[name] = value;
      cleanups.push(() => {
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
      });
    }
    // Named in the executor's own env too, they still do not reach the agent.
    const { executor, log } = scripted([[pass]], { env: { E2E_SECRET_OTHER: 'also-secret' } });
    const step = context();
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    const env = log().find((entry) => 'env' in entry)?.['env'] as string[];
    expect(env).toContain('E2E_TELEMETRY_DISABLED');
    expect(env.filter((name) => name.startsWith('E2E_SECRET_') || name.startsWith('E2E_USER_'))).toEqual([]);
  });

  it('fails with STEP_NO_CONCLUSION when the turn ends without complete_step', async () => {
    const { executor } = scripted([[{ say: 'I could not find the button.' }]]);
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict.status).toBe('failed');
    expect(verdict.errorCode).toBe('STEP_NO_CONCLUSION');
    expect(verdict.summary).toContain('I could not find the button.');
  });

  it('rethrows a runtime error a tool hit, after cancelling the turn', async () => {
    const { executor, log } = scripted([[{ call: 'tap', args: { target: 'n2' } }, { hang: true }]]);
    const step = context();
    cleanups.push(step.end);
    step.tap.mockRejectedValue(new AgentError('STEP_BUDGET_EXHAUSTED', 'the step used its 25 actions'));
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(log()).toContainEqual({ cancelled: true });
    // The turn still counts, with what it cost.
    expect(step.usage).toHaveLength(1);
  });

  it('reports a model the agent does not offer', async () => {
    const { executor } = scripted([[pass]], { model: 'huge' });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
      message: expect.stringContaining('does not offer model huge; it offers fast, slow'),
    });
  });

  it('lists the tools once and tells the agent which ones a step does not offer', async () => {
    const { executor, log } = scripted([[{ call: 'screenshot' }, { call: 'type_secret', args: { target: 'n1', name: 'admin.password' } }, pass]]);
    const step = context({ verbs: ['tap', 'typeSecret'] });
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    const entries = log();
    const session = entries.find((entry) => 'session' in entry)?.['session'] as { tools: string[] };
    expect(session.tools).toContain('type_secret');
    expect(String(entries.find((entry) => 'prompt' in entry)?.['prompt'])).toContain('Not offered in this step: type_secret (this step declares no secrets).');
    expect(JSON.stringify(entries.find((entry) => entry['call'] === 'type_secret'))).toContain('this step declares no secrets');
    // A screenshot reaches the agent as an MCP image.
    const shot = entries.find((entry) => entry['call'] === 'screenshot')?.['result'] as { content: { type: string; mimeType?: string }[] };
    expect(shot.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
  });

  it('launches the agent from the project directory and opens the session in an empty one', async () => {
    // A relative command resolves against the project, as `npx` finds a locally installed adapter.
    const { executor, log } = scripted([[pass]], { args: [relative(process.cwd(), AGENT)] });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).resolves.toMatchObject({ status: 'passed' });
    const session = log().find((entry) => 'session' in entry)?.['session'] as { cwd: string };
    expect(session.cwd.startsWith(join(tmpdir(), 'e2e-acp-'))).toBe(true);
  });

  it('gives each executor its own session in the same attempt', async () => {
    const first = scripted([[pass]], { model: 'fast' });
    const second = scripted([[pass]], { model: 'slow' });
    const step = context();
    cleanups.push(step.end);
    await first.executor.runStep(step.ctx);
    await second.executor.runStep(step.ctx);
    expect(first.log().filter((entry) => 'session' in entry)).toHaveLength(1);
    expect(second.log().filter((entry) => 'session' in entry)).toHaveLength(1);
    expect(second.log()).toContainEqual({ config: { model: 'slow' } });
  });

  it('stops an agent that hangs at startup when the attempt ends', async () => {
    const { executor, log } = scripted([[pass]], { env: { ACP_HANG_INIT: '1' } });
    const step = context();
    cleanups.push(step.end);
    const run = executor.runStep(step.ctx);
    const pid = await vi.waitFor(() => {
      const entry = log().find((line) => 'pid' in line);
      if (entry === undefined) throw new Error('the agent has not started');
      return entry['pid'] as number;
    });
    step.end();
    await expect(run).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('ended while the agent was starting') });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('ends a step that times out while the agent is still starting', async () => {
    const { executor } = scripted([[pass]], { env: { ACP_HANG_INIT: '1' } });
    const step = context();
    cleanups.push(step.end);
    const run = executor.runStep(step.ctx);
    step.abortStep(new AgentError('STEP_TIMEOUT', 'the step timed out'));
    await expect(run).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('reports an agent that does not start', async () => {
    const executor = acpExecutor({ command: join(tmpdir(), 'no-such-acp-agent') });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
  });
});
