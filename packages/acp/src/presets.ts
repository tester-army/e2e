/**
 * How to start each agent with e2e's step tools as its only tools. ACP lets
 * a client add tools but not take the agent's own away, so each preset turns
 * them off the way its agent allows. The adapter runs from the install found
 * from the working directory up, never fetched by name at run time.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { promisify } from 'node:util';
import { ConfigurationError } from 'e2e/engine';
import type { AgentLaunch } from './session.ts';
import type { AcpAgentOptions } from './types.ts';

const execFileAsync = promisify(execFile);

/** Claude Code with no built-in tools, no user or project settings or MCP servers, and no saved session. */
export function claudeCodeLaunch(options: AcpAgentOptions): () => Promise<AgentLaunch> {
  const bin = adapterBin('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp');
  const launch: AgentLaunch = {
    command: process.execPath,
    args: [bin],
    // The adapter starts on ANTHROPIC_MODEL ahead of the user's own settings, whose model may not start outside their CLI.
    env: { ...(options.model === undefined ? {} : { ANTHROPIC_MODEL: options.model }), ...options.env },
    model: options.model,
    sessionMeta: {
      claudeCode: {
        options: {
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          allowDangerouslySkipPermissions: false,
        },
      },
    },
    signIn: 'run `claude` and log in, or set ANTHROPIC_API_KEY',
  };
  return async () => launch;
}

/**
 * Codex in its read-only mode with no shell, web search, apps, plugins,
 * browser or computer use, and the user's own MCP servers turned off by
 * name, as `codex mcp list` reports them. The adapter merges this over the
 * user's Codex config for its sessions only. Codex may still start a
 * subagent, which fails the step like any tool of its own.
 */
export function codexLaunch(options: AcpAgentOptions): () => Promise<AgentLaunch> {
  const pkg = adapterPackage('@agentclientprotocol/codex-acp');
  const bin = binOf(pkg, 'codex-acp');
  let launch: Promise<AgentLaunch> | undefined;
  return () => {
    launch ??= codexServers(pkg, options.env).then(
      (servers): AgentLaunch => ({
        command: process.execPath,
        args: [bin],
        env: { ...options.env, CODEX_CONFIG: JSON.stringify(codexConfig(servers)) },
        model: options.model,
        mode: 'read-only',
        signIn: 'run `codex login`',
      }),
    );
    launch.catch(() => {
      launch = undefined;
    });
    return launch;
  };
}

/** The Codex features that give the agent a tool of its own. */
const CODEX_FEATURES_OFF = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'shell_tool',
  'skill_search',
  'tool_suggest',
  'unified_exec',
  'view_image',
];

function codexConfig(servers: readonly string[]): Record<string, unknown> {
  return {
    web_search: 'disabled',
    features: Object.fromEntries(CODEX_FEATURES_OFF.map((feature) => [feature, false])),
    mcp_servers: Object.fromEntries(servers.map((name) => [name, { enabled: false }])),
  };
}

/** The MCP servers the user's Codex config declares, from the Codex the adapter runs. */
async function codexServers(adapter: string, env: Readonly<Record<string, string>> | undefined): Promise<string[]> {
  const codexPath = env?.['CODEX_PATH'] ?? process.env['CODEX_PATH'];
  const [command, args] =
    codexPath === undefined
      ? [process.execPath, [createRequire(join(adapter, 'package.json')).resolve('@openai/codex/bin/codex.js')]]
      : [codexPath, []];
  try {
    const { stdout } = await execFileAsync(command, [...args, 'mcp', 'list', '--json'], {
      env: { ...process.env, ...env },
      timeout: 30_000,
    });
    return (JSON.parse(stdout) as { name: string }[]).map((server) => server.name);
  } catch (error) {
    throw new Error(`could not list your Codex MCP servers to turn them off: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * The directory of an adapter package installed in the project, found the
 * way Node finds a dependency, with links resolved: pnpm links a package
 * into the project, and its own dependencies resolve only from where it is.
 */
function adapterPackage(name: string): string {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (directory === parse(directory).root) break;
  }
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `${name} is not installed in ${process.cwd()} or a directory above it: npm install -D ${name}, and run e2e from that project`,
  );
}

function adapterBin(name: string, bin: string): string {
  return binOf(adapterPackage(name), bin);
}

function binOf(pkg: string, bin: string): string {
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  const path = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (path === undefined) throw new ConfigurationError('INVALID_CONFIG', `${pkg} has no ${bin} command`);
  return join(pkg, path);
}
