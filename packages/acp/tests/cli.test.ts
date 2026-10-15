import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const agentScript = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const password = 'acp-secret-test-value';
const pass = { call: 'complete_step', args: { status: 'passed', summary: 'done' } };
/** What the scripted agent does for each step, keyed by the step's text. */
const SCRIPT = {
  'Step: Add a todo named Buy milk.': [
    { call: 'type', on: 'textbox "New todo"', args: { value: 'Buy milk' } },
    { call: 'tap', on: 'button "Add"' },
    pass,
  ],
  'Assertion: The list shows Buy milk.': [pass],
  'Step: Sign in as Ada.': [
    { call: 'type', on: 'textbox "Name"', args: { value: 'Ada' } },
    { call: 'type_secret', on: 'textbox "Password"', args: { name: 'admin.password' } },
    { call: 'tap', on: 'button "Sign in"' },
    pass,
  ],
};
const reportSchema = z.object({
  run: z.object({ results: z.array(z.object({ titlePath: z.array(z.string()), status: z.string() })) }),
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function contents(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await contents(path)));
    else result.push(await readFile(path, 'utf8'));
  }
  return result;
}

describe('acp executor through the built CLI and real Chromium', () => {
  let directory: string;
  let app: Server;
  const runs: { status: Map<string, string>; prompts: string[]; log: string }[] = [];
  let artifacts: string[] = [];

  /** One `e2e run`: the tests' statuses, the prompts the agent received, and its whole log, tool results included. */
  async function run(): Promise<{ status: Map<string, string>; prompts: string[]; log: string }> {
    const log = join(directory, `agent-${runs.length}.jsonl`);
    let output = '';
    try {
      const result = await execFileAsync(process.execPath, [join(root, 'e2e/dist/cli/bin.js'), 'run', 'acp.e2e.ts', '--workers', '1'], {
        cwd: directory,
        env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1', ACP_LOG: log },
        timeout: 120_000,
      });
      output = result.stdout + result.stderr;
    } catch (error) {
      const result = z.object({ stdout: z.string(), stderr: z.string() }).parse(error);
      output = result.stdout + result.stderr;
    }
    const raw = await readFile(join(directory, '.e2e/report.json'), 'utf8').catch((error: unknown) => {
      throw new Error(output, { cause: error });
    });
    const report = reportSchema.parse(JSON.parse(raw));
    const agentLog = await readFile(log, 'utf8').catch(() => '');
    const prompts = agentLog
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { prompt?: string })
      .flatMap((entry) => (entry.prompt === undefined ? [] : [entry.prompt]));
    return { status: new Map(report.run.results.map((result) => [result.titlePath.at(-1) ?? '', result.status])), prompts, log: agentLog };
  }

  beforeAll(async () => {
    app = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      const login = (request.url ?? '').startsWith('/login');
      response.end(
        login
          ? `<!doctype html><html><body><h1>Login</h1><label>Name<input id="name"></label><label>Password<input id="password" type="password"></label><button id="go">Sign in</button><p role="status" id="status"></p><script>document.getElementById("go").onclick = () => { document.getElementById("status").textContent = document.getElementById("password").value === ${JSON.stringify(password)} ? "Hello " + document.getElementById("name").value : "Invalid password"; };</script></body></html>`
          : '<!doctype html><html><body><h1>Todos</h1><label>New todo<input id="name"></label><button id="add">Add</button><ul id="list"></ul><script>document.getElementById("add").onclick = () => { const li = document.createElement("li"); li.textContent = document.getElementById("name").value; document.getElementById("list").appendChild(li); };</script></body></html>',
      );
    });
    const appUrl = await listen(app);
    directory = await mkdtemp(join(tmpdir(), 'e2e-acp-cli-'));
    await mkdir(join(directory, 'node_modules/@e2e-dev'), { recursive: true });
    await symlink(join(root, 'e2e'), join(directory, 'node_modules/e2e'));
    await symlink(join(root, 'acp'), join(directory, 'node_modules/@e2e-dev/acp'));
    await symlink(join(root, 'web'), join(directory, 'node_modules/@e2e-dev/web'));
    await writeFile(
      join(directory, 'e2e.config.ts'),
      [
        'import { web } from "@e2e-dev/web";',
        'import { acpExecutor } from "@e2e-dev/acp";',
        'export default {',
        '  tests: "acp.e2e.ts",',
        '  cache: "read-write",',
        `  targets: [{ engine: web(), app: { url: ${JSON.stringify(appUrl)} } }],`,
        `  credentials: { admin: { username: "Ada", password: ${JSON.stringify(password)} } },`,
        '  agents: { default: { executor: acpExecutor({',
        '    command: process.execPath,',
        `    args: [${JSON.stringify(agentScript)}],`,
        `    env: { ACP_SCRIPT: ${JSON.stringify(JSON.stringify(SCRIPT))} },`,
        '  }) } },',
        '};',
      ].join('\n'),
    );
    await writeFile(
      join(directory, 'acp.e2e.ts'),
      [
        'import { test, expect, credentials } from "e2e";',
        'test("todo flow", async ({ app, screen, agent }) => {',
        '  await app.open("/todos");',
        '  await agent.act("Add a todo named Buy milk.");',
        '  await expect(screen.getByText("Buy milk")).toBeVisible();',
        '  await agent.assert("The list shows Buy milk.");',
        '});',
        'test("secret login", async ({ app, screen, agent }) => {',
        '  await app.open("/login");',
        '  await agent.act("Sign in as Ada.", { params: { password: credentials.user("admin").password } });',
        '  await expect(screen.getByRole("status")).toHaveText("Hello Ada");',
        '});',
      ].join('\n'),
    );
    runs.push(await run());
    runs.push(await run());
    artifacts = await contents(join(directory, '.e2e'));
  }, 240_000);

  afterAll(async () => {
    if (app) await new Promise<void>((resolve) => app.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('runs act and assert steps on the agent', () => {
    expect(runs[0]?.status.get('todo flow')).toBe('passed');
    expect(runs[0]?.prompts.some((prompt) => prompt.includes('Step: Add a todo named Buy milk.'))).toBe(true);
    expect(runs[0]?.prompts.some((prompt) => prompt.includes('Assertion: The list shows Buy milk.'))).toBe(true);
  });

  it('fills a secret by name without the value reaching the agent or the artifacts', () => {
    expect(runs[0]?.status.get('secret login')).toBe('passed');
    expect(runs[0]?.prompts.join('\n')).toContain('Secrets to fill with type_secret, by name: admin.password');
    expect(runs[0]?.log).toContain('"call":"type_secret"');
    expect(runs[0]?.log).not.toContain(password);
    for (const artifact of artifacts) expect(artifact).not.toContain(password);
  });

  it('replays recorded act steps without the agent', () => {
    expect(runs[1]?.status.get('todo flow')).toBe('passed');
    expect(runs[1]?.status.get('secret login')).toBe('passed');
    expect(runs[1]?.prompts.some((prompt) => prompt.includes('Step:'))).toBe(false);
    // Assertions are never cached: they still reach the agent.
    expect(runs[1]?.prompts.some((prompt) => prompt.includes('Assertion: The list shows Buy milk.'))).toBe(true);
  });
});
