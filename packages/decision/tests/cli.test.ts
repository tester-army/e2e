import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const password = 'decision-secret-test-value';
const reportSchema = z.object({ run: z.object({
  results: z.array(z.object({ titlePath: z.array(z.string()), status: z.string(), attempts: z.array(z.object({
    steps: z.array(z.object({ error: z.object({ code: z.string() }).optional(), agentMetrics: z.unknown().optional() })),
  })) })),
}) });
/** Starts an actual HTTP server and returns its ephemeral URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP address.');
  return `http://127.0.0.1:${address.port}`;
}
/** Reads generated artifacts recursively, including logs and reports. */
async function contents(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await contents(path));
    else result.push(await readFile(path, 'utf8'));
  }
  return result;
}
describe('decision executor through the built CLI and real Chromium', () => {
  let directory: string;
  let app: Server;
  let report: z.infer<typeof reportSchema>;
  let artifacts: string[];
  let output = '';
  let requests: unknown[] = [];
  beforeAll(async () => {
    app = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      const url = request.url ?? '/todos';
      if (url.startsWith('/many')) {
        const buttons = Array.from({ length: 300 }, (_, index) => `<button data-i="${index}">target ${index}</button>`).join('');
        response.end(`<!doctype html><html><body><h1>Many</h1>${buttons}<p role="status" id="status"></p><script>for (const b of document.querySelectorAll("button")) b.onclick = () => { document.getElementById("status").textContent = "picked " + b.dataset.i; };</script></body></html>`);
        return;
      }
      const login = url.startsWith('/login');
      response.end(`<!doctype html><html><body><h1>${login ? 'Login' : 'Todos'}</h1>${login ? '' : '<label>New todo<input id="name"></label>'}${login ? '<label>Name<input id="name"></label><label>Password<input id="password" type="password"></label>' : ''}<button id="save">${login ? 'Sign in' : 'Add'}</button><ul id="list"></ul><p role="status" id="status"></p><script>document.getElementById("save").onclick = () => {${login ? `const valid = document.getElementById("password").value === ${JSON.stringify(password)};` : 'const name = document.getElementById("name").value;'}${login ? 'document.getElementById("status").textContent = valid ? "Saved Ada" : "Invalid password";' : 'const li = document.createElement("li"); li.textContent = name; document.getElementById("list").appendChild(li);'}};</script></body></html>`);
    });
    const appUrl = await listen(app);
    directory = await mkdtemp(join(tmpdir(), 'e2e-decision-cli-'));
    await mkdir(join(directory, 'node_modules/@e2e-dev'), { recursive: true });
    await symlink(join(root, 'e2e'), join(directory, 'node_modules/e2e'));
    await symlink(join(root, 'decision'), join(directory, 'node_modules/@e2e-dev/decision'));
    await symlink(join(root, 'web'), join(directory, 'node_modules/@e2e-dev/web'));
    requests = [];
    const requestsFile = join(directory, 'requests.jsonl');
    await writeFile(join(directory, 'models.ts'), [
      'import { appendFileSync } from "node:fs";',
      'import type { DecisionExecutorOptions } from "@e2e-dev/decision";',
      'import type { LanguageModel } from "ai";',
      'const log = process.env.E2E_DECISION_REQUESTS === undefined ? "" : process.env.E2E_DECISION_REQUESTS;',
      'function record(entry: unknown): void { if (log !== "") appendFileSync(log, JSON.stringify(entry) + "\\n"); }',
      'function unanimous(choice: string, keys: string[]): Record<string, number> {',
      '  return Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0]));',
      '}',
      'function doneActs(state: any): string[] { return ((state.recentActions ?? []) as { action?: unknown }[]).map((entry) => typeof entry.action === "string" ? entry.action : ""); }',
      'function pickOp(goal: string, done: string[], keys: string[]): string {',
      '  const order = goal.indexOf("Sign in") !== -1 ? ["typeSecret", "type", "tap", "done"] : ["type", "tap", "done"];',
      '  for (const op of order) {',
      '    if (keys.indexOf(op) === -1) continue;',
      '    if (op !== "done" && done.some((action) => action === op || action.indexOf(op + " ") === 0)) continue;',
      '    return op;',
      '  }',
      '  return "blocked";',
      '}',
      'function pickTarget(id: string, instructions: string, criteria: Record<string, any>, goal: string): string {',
      '  const entries = Object.entries(criteria);',
      '  const labelOf = (value: any): string => typeof value === "string" ? value : String(value.element ?? "");',
      '  if (goal.indexOf("target 5") !== -1) {',
      '    const hit = entries.find((entry) => labelOf(entry[1]).indexOf("target 5") !== -1);',
      '    if (hit !== undefined) return hit[0];',
      '  }',
      '  const op = (/The next operation is "([a-zA-Z_]+)"/.exec(instructions) ?? [])[1] ?? "";',
      '  if (op === "typeSecret") {',
      '    const secret = entries.find((entry) => labelOf(entry[1]).toLowerCase().indexOf("password") !== -1);',
      '    return ((secret ?? entries[0]) as [string, unknown])[0];',
      '  }',
      '  const role = op === "type" || op === "typeSecret" ? "textbox" : op === "tap" ? "button" : "";',
      '  const hit = entries.find((entry) => { const record = entry[1]; return typeof record !== "string" && record.role === role; });',
      '  return (hit ?? entries[0] as [string, unknown])[0];',
      '}',
      'export const decisionModel: DecisionExecutorOptions["model"] = {',
      '  specificationVersion: "v4", provider: "scripted", modelId: "scripted-1", supportedQuestionTypes: ["choice"],',
      '  async doDecide({ state, questions }) {',
      '    record({ state, questions });',
      '    const view = state as { goal?: unknown; recentActions?: { action?: unknown }[]; page?: { text?: unknown } };',
      '    const goal = typeof view.goal === "string" ? view.goal : "";',
      '    const done = doneActs(state);',
      '    const answers: Record<string, { type: "choice"; choice: string; probabilities: Record<string, number> }> = {};',
      '    for (const entry of Object.entries(questions)) {',
      '      const id = entry[0];',
      '      const question = entry[1] as { type: string; criteria: Record<string, unknown> };',
      '      const keys = Object.keys(question.criteria);',
      '      if (id === "operation") { const choice = pickOp(goal, done, keys); answers[id] = { type: "choice", choice, probabilities: unanimous(choice, keys) }; }',
      '      else if (id === "verdict") { const page = typeof view.page === "object" && view.page !== null ? String((view.page as { text?: unknown }).text ?? "") : ""; const holds = page.indexOf("Buy milk") !== -1 || page.indexOf("Saved Ada") !== -1 || page.indexOf("picked 5") !== -1; const choice = holds ? "holds" : "fails"; answers[id] = { type: "choice", choice, probabilities: unanimous(choice, keys) }; }',
      '      else if (id === "secret") { answers[id] = { type: "choice", choice: "password", probabilities: unanimous("password", keys) }; }',
      '      else { const choice = pickTarget(id, String(question.instructions), question.criteria, goal); answers[id] = { type: "choice", choice, probabilities: unanimous(choice, keys) }; }',
      '    }',
      '    return { answers, warnings: [], usage: { inputTokens: 5, outputTokens: 0 }, response: { modelId: "scripted-1" } };',
      '  },',
      '};',
      'export const textModel = {',
      '  specificationVersion: "v4", provider: "scripted-text", modelId: "s-1", supportedUrls: {},',
      '  async doGenerate({ prompt }: { prompt?: unknown }) {',
      '    record({ textPrompt: prompt });',
      '    const parts = Array.isArray(prompt) ? prompt : [];',
      '    const user = parts.find((message: any) => message.role === "user");',
      '    const content = Array.isArray(user?.content) ? user.content : [];',
      '    const textPart = content.find((part: any) => part.type === "text");',
      '    const raw = typeof textPart?.text === "string" ? textPart.text : "{}";',
      '    const asked = JSON.parse(raw.slice(raw.indexOf("{")));',
      '    const label = String(asked.field?.label ?? "");',
      '    const wanted = label.toLowerCase().indexOf("todo") !== -1 ? "Buy milk" : label.indexOf("Name") !== -1 ? "Ada" : null;',
      '    return { content: [{ type: "text", text: JSON.stringify({ text: wanted }) }], finishReason: { unified: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] };',
      '  },',
      '} as unknown as LanguageModel;',
    ].join('\n'));
    await writeFile(join(directory, 'e2e.config.ts'), [
      'import { web } from "@e2e-dev/web";',
      'import { decisionExecutor } from "@e2e-dev/decision";',
      'import { decisionModel, textModel } from "./models.ts";',
      'export default {',
      '  tests: "decision.e2e.ts",',
      `  targets: [{ engine: web(), app: { url: ${JSON.stringify(appUrl)} } }],`,
      `  credentials: { admin: { username: "Ada", password: ${JSON.stringify(password)} } },`,
      '  agents: { default: { executor: decisionExecutor({ model: decisionModel, textModel }) } },',
      '};',
    ].join('\n'));
    await writeFile(join(directory, 'decision.e2e.ts'), [
      'import { test, expect, credentials } from "e2e";',
      'test("todo flow in plain language", async ({ app, screen, agent }) => {',
      '  await app.open("/todos");',
      '  await agent.act("Add a todo named Buy milk.");',
      '  await expect(screen.getByText("Buy milk")).toBeVisible();',
      '});',
      'test("secret login", async ({ app, screen, agent }) => {',
      '  await app.open("/login");',
      '  await agent.act("Sign in with Ada.", { params: { password: credentials.user("admin").password } });',
      '  await expect(screen.getByRole("status")).toHaveText("Saved Ada");',
      '});',
      'test("long page", async ({ app, screen, agent }) => {',
      '  await app.open("/many");',
      '  await agent.act("Tap target 5.");',
      '  await expect(screen.getByRole("status")).toHaveText("picked 5");',
      '});',
    ].join('\n'));
    try {
      const result = await execFileAsync(process.execPath, [join(root, 'e2e/dist/cli/bin.js'), 'run', 'decision.e2e.ts', '--workers', '1'], {
        cwd: directory,
        env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1', E2E_DECISION_REQUESTS: requestsFile },
        timeout: 120_000,
      });
      output = result.stdout + result.stderr;
    } catch (error) {
      const result = z.object({ stdout: z.string(), stderr: z.string() }).parse(error);
      output = result.stdout + result.stderr;
    }
    const raw = JSON.parse(await readFile(join(directory, '.e2e/report.json'), 'utf8').catch((error) => { throw new Error(output, { cause: error }); }));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(await readFile(join(root, 'e2e/schema/report-v1.schema.json'), 'utf8')));
    expect(validate(raw), JSON.stringify(validate.errors)).toBe(true);
    report = reportSchema.parse(raw);
    artifacts = await contents(join(directory, '.e2e'));
    requests = (await readFile(requestsFile, 'utf8').catch(() => '')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }, 180_000);
  afterAll(async () => {
    if (app) await new Promise<void>((resolve) => app.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('completes the todo flow in plain language', () => {
    expect(report.run.results.find((result) => result.titlePath.at(-1) === 'todo flow in plain language')?.status).toBe('passed');
  });
  it('fills a runner-authorized secret without sending it anywhere', () => {
    expect(report.run.results.find((result) => result.titlePath.at(-1) === 'secret login')?.status).toBe('passed');
    expect(JSON.stringify(requests)).not.toContain(password);
    for (const artifact of artifacts) expect(artifact).not.toContain(password);
  });
  it('completes a long page past the choice cap', () => {
    expect(report.run.results.find((result) => result.titlePath.at(-1) === 'long page')?.status).toBe('passed');
  });
  it('asks the operation first and the target in its own call', () => {
    const asked = requests
      .filter((request) => typeof (request as { questions?: unknown }).questions === 'object')
      .map((request) => Object.keys((request as { questions: Record<string, unknown> }).questions).toSorted());
    expect(asked).toContainEqual(['operation']);
    expect(asked).toContainEqual(['target']);
  });
});
