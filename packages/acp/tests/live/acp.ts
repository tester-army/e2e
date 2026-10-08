/**
 * Hand-run check of the ACP presets against a real agent, never part of
 * `pnpm test`: it spends the agent's own login. Runs a todo act plus assert,
 * an assertion that must fail, a secret login, and a step that asks the agent
 * to name every tool it has, twice in a throwaway project, the first run
 * recording and the second replaying, and prints each step.
 *
 *   pnpm build
 *   node packages/acp/tests/live/acp.ts
 *
 * ACP_AGENT picks the preset (claudeCode, the default, or codex) and
 * ACP_MODEL its model. The adapter comes from ACP_ADAPTERS, a node_modules
 * directory that has it installed, or is installed into the project.
 * ACP_KEEP=1 keeps the project for a look at its traces.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'acp-live-secret-value';
const preset = process.env['ACP_AGENT'] ?? 'claudeCode';
const ADAPTERS: Record<string, string> = {
  claudeCode: '@agentclientprotocol/claude-agent-acp@0.88.0',
  codex: '@agentclientprotocol/codex-acp@2.1.1',
};
if (!(preset in ADAPTERS)) throw new Error(`ACP_AGENT must be one of ${Object.keys(ADAPTERS).join(', ')}`);
const model = process.env['ACP_MODEL'] ?? (preset === 'claudeCode' ? 'sonnet' : '');
/** The step whose summary names the agent's tools. */
const INVENTORY = 'Without changing the app, conclude passed with a summary that lists the name of every tool you can call in this conversation, all of them, wherever they come from.';
/** Tests expected to fail, by title, with the code they fail with. */
const EXPECTED_FAILURES: Record<string, string> = { 'wrong assertion': 'ASSERTION_FAILED' };

const app = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  const login = (request.url ?? '').startsWith('/login');
  response.end(
    login
      ? `<!doctype html><html><body><h1>Login</h1><label>Name<input id="name"></label><label>Password<input id="password" type="password"></label><button id="go">Sign in</button><p role="status" id="status"></p><script>document.getElementById("go").onclick = () => { document.getElementById("status").textContent = document.getElementById("password").value === ${JSON.stringify(password)} ? "Hello " + document.getElementById("name").value : "Invalid password"; };</script></body></html>`
      : '<!doctype html><html><body><h1>Todos</h1><label>New todo<input id="name"></label><button id="add">Add</button><ul id="list"></ul><script>document.getElementById("add").onclick = () => { const li = document.createElement("li"); li.textContent = document.getElementById("name").value; document.getElementById("list").appendChild(li); };</script></body></html>',
  );
});
await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

const directory = await mkdtemp(join(tmpdir(), 'e2e-acp-live-'));
await mkdir(join(directory, 'node_modules/@e2e-dev'), { recursive: true });
const adapters = process.env['ACP_ADAPTERS'];
if (adapters === undefined) {
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await execFileAsync('npm', ['install', '--no-save', '--silent', ADAPTERS[preset]!], { cwd: directory, timeout: 600_000 });
} else {
  await symlink(join(resolvePath(adapters), '@agentclientprotocol'), join(directory, 'node_modules/@agentclientprotocol'));
}
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
    `  agents: { default: { executor: acpExecutor.${preset}(${JSON.stringify(model === '' ? {} : { model })}) } },`,
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
    'test("wrong assertion", async ({ app, agent }) => {',
    '  await app.open("/todos");',
    '  await agent.assert("The list shows Buy bread.");',
    '});',
    'test("tool inventory", async ({ app, agent }) => {',
    '  await app.open("/todos");',
    `  await agent.act(${JSON.stringify(INVENTORY)});`,
    '});',
    'test("secret login", async ({ app, screen, agent }) => {',
    '  await app.open("/login");',
    '  await agent.act("Sign in as Ada.", { params: { password: credentials.user("admin").password } });',
    '  await expect(screen.getByRole("status")).toHaveText("Hello Ada");',
    '});',
  ].join('\n'),
);

interface Step {
  api?: string;
  label?: string;
  status?: string;
  durationMs?: number;
  cache?: { mode?: string };
  metrics?: { modelCalls?: number; actionSteps?: number };
  model?: unknown;
  error?: { code?: string; message?: string };
}
interface Report {
  run: { results: { titlePath: string[]; status: string; attempts: { steps: Step[] }[] }[] };
}

let failed = false;
/** The act steps the record run took actions in, by label: the replay run must take them from the cache. */
const recorded = new Set<string>();
try {
  for (const phase of ['record', 'replay']) {
    const started = Date.now();
    // A run that fails before it writes a report must not leave the last one to read.
    await rm(join(directory, '.e2e/report.json'), { force: true });
    try {
      await execFileAsync(process.execPath, [join(root, 'e2e/dist/cli/bin.js'), 'run', 'acp.e2e.ts', '--workers', '1'], {
        cwd: directory,
        env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
        timeout: 600_000,
      });
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      console.log(`${phase}: e2e run exited non-zero\n${stdout ?? ''}${stderr ?? ''}`);
    }
    const report = JSON.parse(await readFile(join(directory, '.e2e/report.json'), 'utf8')) as Report;
    console.log(`\n## ${phase} (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const result of report.run.results) {
      const title = result.titlePath.at(-1) ?? '';
      const expectedCode = EXPECTED_FAILURES[title];
      const steps = result.attempts.at(-1)?.steps ?? [];
      const code = steps.find((step) => step.error?.code !== undefined)?.error?.code;
      const ok = expectedCode === undefined ? result.status === 'passed' : result.status === 'failed' && code === expectedCode;
      console.log(`- ${title}: ${result.status}${ok ? '' : ' (UNEXPECTED)'}`);
      if (!ok) failed = true;
      for (const step of steps) {
        if (step.api?.startsWith('agent.') !== true) continue;
        console.log(
          `  ${step.api} "${step.label}": ${step.status}, cache ${step.cache?.mode ?? '-'}, ${step.metrics?.modelCalls ?? 0} model calls, ${step.metrics?.actionSteps ?? 0} actions, ${step.durationMs} ms${step.error === undefined ? '' : `, ${step.error.code}: ${step.error.message}`}`,
        );
        if (step.model !== undefined) console.log(`    model: ${JSON.stringify(step.model)}`);
        if (step.api !== 'agent.act' || step.label === undefined) continue;
        if (phase === 'record' && (step.metrics?.actionSteps ?? 0) > 0) recorded.add(step.label);
        if (phase === 'replay' && recorded.has(step.label) && ((step.metrics?.modelCalls ?? 0) > 0 || step.cache?.mode === 'missed')) {
          console.log('    (UNEXPECTED: did not replay from the cache)');
          failed = true;
        }
      }
    }
  }
  const leaked: string[] = [];
  const foreign: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const text = await readFile(path, 'utf8');
        if (text.includes(password)) leaked.push(path);
        foreign.push(...(text.match(/^(?:rejected tools|tools) of the agent's own.*$/gm) ?? []));
      }
    }
  };
  await walk(join(directory, '.e2e'));
  console.log(`\nsecret in artifacts: ${leaked.length === 0 ? 'no' : leaked.join(', ')}`);
  console.log(`agent's own tool calls: ${foreign.length === 0 ? 'none' : [...new Set(foreign)].join('; ')}`);
  if (leaked.length > 0) failed = true;
} finally {
  app.close();
  if (process.env['ACP_KEEP'] === '1') console.log(`project kept at ${directory}`);
  else await rm(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
