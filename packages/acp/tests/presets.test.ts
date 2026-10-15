import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepExecutor, StepExecutorContext } from 'e2e';
import { afterEach, describe, expect, it } from 'vitest';
import { acpExecutor } from '../src/index.ts';

const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const pass = { call: 'complete_step', args: { status: 'passed', summary: 'done' } };
const cleanups: (() => void)[] = [];
afterEach(() => {
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
    pixelsTainted: false,
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
    expect(() => inProject(directory, () => acpExecutor.claudeCode())).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('npm install -D @agentclientprotocol/claude-agent-acp') }),
    );
    expect(() => inProject(directory, () => acpExecutor.codex())).toThrow(/npm install -D @agentclientprotocol\/codex-acp/);
  });

  it("starts Claude Code's installed adapter with its own tools, settings, and saved sessions off", async () => {
    const directory = project(['@agentclientprotocol/claude-agent-acp']);
    const log = join(directory, 'agent.jsonl');
    const executor = inProject(directory, () =>
      acpExecutor.claudeCode({ model: 'slow', env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
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
    // Stands in for the Codex the adapter runs, which lists the user's MCP servers.
    const codex = join(directory, 'codex');
    writeFileSync(codex, `#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] && echo '[{"name":"playwright"},{"name":"executor"}]'\n`);
    chmodSync(codex, 0o755);
    const executor = inProject(directory, () =>
      acpExecutor.codex({ env: { CODEX_PATH: codex, ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
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
