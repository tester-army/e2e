import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepExecutor, StepExecutorContext } from 'e2e';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeCode, codex } from '../src/index.ts';

const AGENT = new URL('./fixtures/scripted-agent.ts', import.meta.url).href;
const pass = { call: 'complete_step', args: { status: 'passed', summary: 'done' } };
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A project with the scripted agent installed under an adapter's package name. */
function project(adapters: readonly string[] = []): string {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-acp-preset-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of adapters) {
    const pkg = join(directory, 'node_modules', name);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    const bin = name.split('/').at(-1)!;
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin: { [bin]: 'dist/index.js' } }));
    writeFileSync(join(pkg, 'dist/index.js'), `import ${JSON.stringify(AGENT)};\n`);
  }
  return directory;
}

/** Builds the executor from inside `directory`, as a config loaded there does. */
function inProject<T>(directory: string, build: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return build();
  } finally {
    process.chdir(previous);
  }
}

/** Runs one passing step and returns what the agent logged. */
async function runStep(executor: StepExecutor, log: string): Promise<Record<string, unknown>[]> {
  const attempt = new AbortController();
  cleanups.push(() => attempt.abort());
  const ctx = {
    step: { kind: 'act', index: 0, instruction: 'add a todo', params: undefined, secrets: [] },
    attempt: { testId: 't', attemptId: 'a', index: 0, signal: attempt.signal, memory: new Map() },
    signal: new AbortController().signal,
    target: { name: 'web', platform: 'web', verbs: new Set(['tap']) },
    ledger: '',
    agentContext: undefined,
    actions: {},
    observe: async () => ({ revision: '1', text: '#n1 button "Add"', truncated: false, viewport: { width: 800, height: 600 }, path: '/' }),
    attachTranscript: () => undefined,
    attachTurns: () => undefined,
    attachScreenshot: async () => 'screenshot',
    budgets: { maxActions: 5, maxModelCalls: 5, remainingMs: () => 60_000, actionsUsed: () => 0, recordModelCall: () => undefined, runTool: <T>(_: unknown, body: () => Promise<T>) => body() },
  } as unknown as StepExecutorContext;
  await expect(executor.runStep(ctx)).resolves.toMatchObject({ status: 'passed' });
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('agent presets', () => {
  it('refuses a preset whose adapter the project has not installed', () => {
    const directory = project();
    expect(() => inProject(directory, () => claudeCode())).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('npm install -D @agentclientprotocol/claude-agent-acp') }),
    );
    expect(() => inProject(directory, () => codex())).toThrow(/npm install -D @agentclientprotocol\/codex-acp/);
  });

  it("starts Claude Code's installed adapter with its own tools, settings, and saved sessions off", async () => {
    const directory = project(['@agentclientprotocol/claude-agent-acp']);
    const log = join(directory, 'agent.jsonl');
    const executor = inProject(directory, () =>
      claudeCode({ model: 'slow', env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
    );
    expect(executor.name).toBe('claude-code');
    const entries = await runStep(executor, log);
    const session = entries.find((entry) => 'session' in entry)?.['session'] as { meta: unknown };
    expect(session.meta).toEqual({
      claudeCode: {
        options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, allowDangerouslySkipPermissions: false },
      },
    });
    expect(entries).toContainEqual({ config: { model: 'slow' } });
  });

  it("starts Codex read-only with its own tools and the user's MCP servers off", async () => {
    const directory = project(['@agentclientprotocol/codex-acp']);
    const log = join(directory, 'agent.jsonl');
    // Use the adapter's bundled Node entry instead of a platform-specific executable.
    vi.stubEnv('CODEX_PATH', undefined);
    const codexPackage = join(directory, 'node_modules', '@openai', 'codex');
    mkdirSync(join(codexPackage, 'bin'), { recursive: true });
    writeFileSync(join(codexPackage, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    writeFileSync(join(codexPackage, 'bin', 'codex.js'), `
if (process.argv.slice(2).join(' ') !== 'mcp list --json' || process.env.E2E_SECRET_KEY) process.exit(1);
console.log(JSON.stringify([{ name: 'playwright' }, { name: 'executor' }]));
`);
    const executor = inProject(directory, () =>
      codex({ env: { E2E_SECRET_KEY: 'sk_test_value', ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
    );
    const entries = await runStep(executor, log);
    expect(entries).toContainEqual({ mode: 'read-only' });
    const config = JSON.parse(entries.find((entry) => 'codexConfig' in entry)?.['codexConfig'] as string) as {
      web_search: string;
      features: Record<string, boolean>;
      mcp_servers: Record<string, { enabled: boolean }>;
    };
    expect(config.web_search).toBe('disabled');
    expect(config.features).toMatchObject({ shell_tool: false, multi_agent: false, plugins: false, apps: false, browser_use: false });
    expect(config.mcp_servers).toEqual({ playwright: { enabled: false }, executor: { enabled: false } });
  });
});
