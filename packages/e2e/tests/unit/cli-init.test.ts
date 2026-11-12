import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { init } from '../../src/cli/init.ts';
import { planSkillInstall } from '../../src/cli/init/agent-skill.ts';
import { dependencyRange } from '../../src/cli/init/versions.ts';
import { readSkillFiles } from '../../src/cli/skill.ts';

vi.mock('@clack/prompts', { spy: true });
vi.mock('../../src/cli/skill.ts', { spy: true });
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
/** What each multiselect question answers; a test sets one before calling init. */
let answers: Record<'engines' | 'skills' | 'mcp', string[] | typeof clack.CANCEL_SYMBOL>;

/** Whether this host lets the tests create symlinks; Windows needs a privilege for them. */
const symlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-symlink-'));
  try {
    writeFileSync(path.join(probe, 'file'), '');
    symlinkSync(path.join(probe, 'file'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** Captures user-facing output without ANSI formatting. */
function output(): string {
  return stdoutSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join('');
}

/** Installs a stand-in for package `name` in the throwaway project, whose ESM entry is `source`. */
function stubPackage(name: string, source: string): void {
  const root = path.join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
  writeFileSync(path.join(root, 'index.js'), source);
}

/** Reads one file from the throwaway project. */
function read(file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

/** Writes the bundled skill into `<location>/e2e` as an earlier init left it, every file holding `content` when given. */
function writeCopy(location: string, content?: string): void {
  for (const file of readSkillFiles()) {
    const absolute = path.join(dir, location, 'e2e', file.relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content ?? file.content);
  }
}

/** A completed `spawnSync` result with the given exit status. */
function spawnResult(status: number): ReturnType<typeof spawnSync> {
  return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status, signal: null };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0');
  vi.mocked(clack.select).mockReset().mockResolvedValue('none');
  vi.mocked(clack.text).mockReset().mockResolvedValue('http://127.0.0.1:11434/v1');
  vi.mocked(clack.confirm).mockReset().mockResolvedValue(false);
  answers = { engines: [], skills: ['.agents/skills', '.claude/skills'], mcp: ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml'] };
  vi.mocked(clack.multiselect)
    .mockReset()
    .mockImplementation(async (prompt) => {
      const message = String(prompt.message);
      return message.includes('MCP') ? answers.mcp : message.includes('Which engines') ? answers.engines : answers.skills;
    });
  vi.mocked(clack.isCancel).mockImplementation((value) => typeof value === 'symbol');
  vi.mocked(spawnSync).mockReset().mockReturnValue(spawnResult(0));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('e2e init', () => {
  it('adds the runner, Playwright, and AI with --yes and does not install or prompt', async () => {
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    // The runner pins itself the way it pins engines: a caret on a stable version, exact on a canary.
    const runnerVersion = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version;
    expect(JSON.parse(read('package.json'))).toEqual({
      private: true,
      type: 'module',
      devDependencies: { 'e2e': dependencyRange(runnerVersion), '@e2e-dev/web': '0.x', ai: '^7.0.0', zod: '^4.1.8' },
      scripts: { 'test:e2e': 'e2e run' },
    });
    expect(read('e2e.config.ts')).toContain('agents: {\n    default: {\n      model: ');
    expect(read('e2e.config.ts')).not.toContain('e2e/agent');
    // The default gateway is written out as its own provider's constructor, never implied by the runner.
    expect(read('e2e.config.ts')).toContain("import { gateway } from 'ai';");
    expect(read('e2e.config.ts')).toContain("model: gateway('openai/gpt-6-luna-fast'),");
    expect(read('e2e.config.ts')).toContain('// The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY, or the OIDC token of a linked Vercel project.');
    expect(read('tests/example.e2e.ts')).toContain('// With the model key in the environment, uncomment:');
    expect(read('e2e.config.ts')).toContain("engine: web(),\n    app: {\n      url: process.env.APP_URL ?? 'http://localhost:3000',");
    expect(read('e2e.config.ts')).toContain('// command: {');
    expect(read('tests/example.e2e.ts')).toContain("test('app opens'");
    expect(read('tests/example.e2e.ts')).toContain("await app.open('/');");
    expect(read('tests/example.e2e.ts')).toContain("await expect(browser.locator('body')).toBeVisible();");
    expect(read('tests/example.e2e.ts')).toContain('// test(');
    expect(read('tests/example.e2e.ts')).not.toContain('fetch(');
    expect(JSON.parse(read('.mcp.json'))).toEqual({ mcpServers: { e2e: { command: 'npx', args: ['e2e', 'mcp'] } } });
    expect(JSON.parse(read('.cursor/mcp.json'))).toEqual({ mcpServers: { e2e: { command: 'npx', args: ['e2e', 'mcp'] } } });
    expect(read('.codex/config.toml')).toContain('[mcp_servers.e2e]');
    expect(read('.codex/config.toml')).toContain('command = "npx"');
    expect(output()).toContain('trusted projects');
    expect(read('.gitignore')).toContain('node_modules/');
    expect(read('.gitignore')).toContain('.e2e/junit.xml');
    expect(read('.gitignore')).toContain('.e2e/summary.md');
    expect(read('.gitignore')).toContain('.e2e/cache/');
    expect(output()).toContain('.e2e/cache/ is ignored; committing agent.act replays is opt-in, see https://e2e.com/docs/cache#commit-the-replay-cache');
    expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(read('.claude/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('Add scripts: test:e2e (e2e run)');
    expect(output()).toContain('No tsconfig.json');
    expect(output()).toContain('Next: npm install, then APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('registers the MCP server through bunx in a Bun project', async () => {
    writeFileSync(path.join(dir, 'bun.lock'), '');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(JSON.parse(read('.mcp.json'))).toEqual({ mcpServers: { e2e: { command: 'bunx', args: ['e2e', 'mcp'] } } });
    expect(read('.codex/config.toml')).toContain('command = "bunx"');
  });

  it('hands back what --yes chose, then that a second run had nothing to do', async () => {
    expect(await init(dir, { yes: true })).toEqual({
      exitCode: 0,
      ready: false,
      result: 'scaffolded',
      yes: true,
      example: null,
      existingConfig: false,
      engine: 'web',
      gateway: 'vercel',
      skill: true,
      mcp: true,
      ci: 'none',
      install: false,
    });
    expect(await init(dir, { yes: true })).toMatchObject({
      exitCode: 0,
      result: 'already-initialized',
      existingConfig: true,
      engine: null,
      gateway: null,
    });
  });

  it('hands back the prompted choices, a cancellation with what was chosen so far, and a failed install', async () => {
    const cancel: typeof clack.CANCEL_SYMBOL = clack.CANCEL_SYMBOL;
    answers.engines = ['mobile'];
    vi.mocked(clack.select).mockResolvedValueOnce('none');
    answers.skills = ['.agents/skills'];
    answers.mcp = cancel;
    expect(await init(dir)).toEqual({
      exitCode: 0,
      ready: false,
      result: 'cancelled',
      yes: false,
      example: null,
      existingConfig: false,
      engine: 'mobile',
      gateway: 'none',
      skill: true,
      mcp: false,
      ci: null,
      install: false,
    });

    answers.engines = ['web'];
    answers.mcp = ['.mcp.json'];
    vi.mocked(clack.select).mockResolvedValueOnce('openrouter');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(1));
    expect(await init(dir)).toMatchObject({ exitCode: 2, result: 'install-failed', engine: 'web', gateway: 'openrouter', install: true });

    rmSync(path.join(dir, 'e2e.config.ts'));
    answers.engines = ['mobile', 'web'];
    vi.mocked(clack.select).mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toMatchObject({ exitCode: 0, result: 'scaffolded', engine: 'web,mobile' });
  });

  it('hands back a run that could not start', async () => {
    expect(await init(dir, { interactive: false })).toMatchObject({ exitCode: 2, result: 'not-interactive' });
    writeFileSync(path.join(dir, 'package.json'), '{not json');
    expect(await init(dir, { yes: true })).toMatchObject({ exitCode: 2, result: 'invalid-project' });
  });

  it.each([
    { engine: 'none', ai: false },
    { engine: 'web', ai: true },
    { engine: 'mobile', ai: true },
  ] as const)('matches imports and dependencies to engine=$engine, ai=$ai', async ({ engine, ai }) => {
    answers.engines = engine === 'none' ? [] : [engine];
    vi.mocked(clack.select).mockResolvedValueOnce(ai ? 'openrouter' : 'none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const manifest = JSON.parse(read('package.json'));
    const device = engine === 'mobile';
    expect(Object.keys(manifest.devDependencies)).toEqual([
      'e2e',
      ...(engine === 'web' ? ['@e2e-dev/web'] : []),
      ...(device ? ['@e2e-dev/mobile'] : []),
      ...(ai ? ['ai', 'zod', '@openrouter/ai-sdk-provider'] : []),
    ]);
    expect(manifest.devDependencies.ai).toBe(ai ? '^7.0.0' : undefined);
    expect(manifest.devDependencies.zod).toBe(ai ? '^4.1.8' : undefined);
    expect(manifest.devDependencies['@openrouter/ai-sdk-provider']).toBe(ai ? '^3.0.0' : undefined);
    expect(read('e2e.config.ts').includes('agents: {')).toBe(ai);
    expect(read('e2e.config.ts').includes("import { openrouter } from '@openrouter/ai-sdk-provider';")).toBe(ai);
    expect(read('e2e.config.ts').includes("model: openrouter('openai/gpt-6-luna-fast'),")).toBe(ai);
    expect(read('e2e.config.ts').includes('// OpenRouter serves the model id and reads OPENROUTER_API_KEY.')).toBe(ai);
    expect(clack.text).not.toHaveBeenCalled();
    expect(read('e2e.config.ts').includes('@e2e-dev/web')).toBe(engine === 'web');
    expect(read('tests/example.e2e.ts').includes('@e2e-dev/web')).toBe(engine === 'web');
    expect(read('e2e.config.ts').includes('@e2e-dev/mobile')).toBe(device);
    expect(read('tests/example.e2e.ts').includes('@e2e-dev/mobile')).toBe(device);
    expect(read('e2e.config.ts').includes('APP_URL')).toBe(engine === 'web');
    expect(output()).toContain(`Next: npm install, then ${device ? '' : 'APP_URL=http://localhost:3000 '}npm run test:e2e`);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    { host: 'darwin', platform: 'ios', app: 'Settings', label: 'General' },
    { host: 'linux', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
  ] as const)('defaults agent-device to $platform on $host', async ({ host, platform, app, label }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    answers.engines = ['mobile'];
    vi.mocked(clack.select).mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir, { ci: 'none' })).exitCode).toBe(0);
    expect(clack.select).toHaveBeenCalledTimes(1);
    expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Which engines?'),
      initialValues: ['web'],
      required: false,
      options: [
        expect.objectContaining({ value: 'web', label: 'Web', hint: 'Playwright' }),
        expect.objectContaining({ value: 'mobile', label: 'Mobile (iOS/Android)', hint: 'agent-device' }),
      ],
    }));
    expect(read('e2e.config.ts')).toContain(`engine: mobile({ platform: '${platform}' }), app: { bundleId: '${app}' }`);
    expect(read('tests/example.e2e.ts')).toContain(label);
  });

  it('writes one target and one example file per engine when both are selected', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    answers.engines = ['web', 'mobile'];
    vi.mocked(clack.select).mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await init(dir)).toMatchObject({ exitCode: 0, engine: 'web,mobile' });
    expect(Object.keys(JSON.parse(read('package.json')).devDependencies)).toEqual(['e2e', '@e2e-dev/web', '@e2e-dev/mobile', 'ai', 'zod']);
    expect(read('e2e.config.ts')).toContain("import { web } from '@e2e-dev/web';\nimport { mobile } from '@e2e-dev/mobile';\n");
    expect(read('e2e.config.ts')).toContain(`  targets: [
    {
      engine: web(),
      app: {
        url: process.env.APP_URL ?? 'http://localhost:3000',
        // Or let the runner start the dev server:
        // command: { executable: 'npm', args: ['run', 'dev'] },
      },
    },
    // Replace Settings with your app's bundle id.
    { name: 'ios', engine: mobile({ platform: 'ios' }), app: { bundleId: 'Settings' } },
  ],
  workers: 1,
}`);
    expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(false);
    expect(read('tests/web.e2e.ts')).toContain("test('app opens', { requires: ['browser'] }, async ({ app, browser }) => {");
    expect(read('tests/web.e2e.ts')).toContain("// test('the agent drives a flow', { requires: ['browser'] }, async ({ app, agent }) => {");
    expect(read('tests/mobile.e2e.ts')).toContain("test('Settings opens', { requires: ['device'] }, async ({ app, screen }) => {");
    expect(read('tests/mobile.e2e.ts')).toContain("// test('the agent opens General', { requires: ['device'] }, async ({ agent, app, device }) => {");
    expect(output()).toContain('  - Create tests/web.e2e.ts\n');
    expect(output()).toContain('  - Create tests/mobile.e2e.ts\n');
    expect(output()).toContain('Next: npm install, then APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('offers every gateway and none, and asks an OpenAI-compatible endpoint for its URL', async () => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('openai-compatible');
    vi.mocked(clack.text).mockResolvedValueOnce(' http://127.0.0.1:11434/v1 ');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir, { ci: 'none' })).exitCode).toBe(0);
    expect(clack.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: expect.stringContaining('Which model gateway'),
      initialValue: 'vercel',
      options: [
        expect.objectContaining({ value: 'vercel', label: 'Vercel AI Gateway' }),
        expect.objectContaining({ value: 'openrouter' }),
        expect.objectContaining({ value: 'openai-compatible' }),
        expect.objectContaining({ value: 'chatgpt' }),
        expect.objectContaining({ value: 'copilot' }),
        expect.objectContaining({ value: 'opencode-console' }),
        expect.objectContaining({ value: 'grok' }),
        expect.objectContaining({ value: 'none' }),
      ],
    }));
    expect(clack.text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ placeholder: 'http://127.0.0.1:11434/v1' }));
    expect(read('e2e.config.ts')).toContain("import { createOpenAICompatible } from '@ai-sdk/openai-compatible';");
    expect(read('e2e.config.ts')).toContain(
      "      model: createOpenAICompatible({\n        name: 'openai-compatible',\n        baseURL: 'http://127.0.0.1:11434/v1',\n        // apiKey: process.env.LLM_API_KEY,\n      }).chatModel('gpt-6-luna'),",
    );
    expect(read('e2e.config.ts')).toContain('// The endpoint serves the model id over the OpenAI chat API; pass apiKey when it needs one.');
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('@ai-sdk/openai-compatible', '^3.0.0');
  });

  it.each([
    { gateway: 'chatgpt', provider: 'openai', line: "import { chatgpt } from 'e2e/oauth/chatgpt';", model: "model: chatgpt('gpt-6-luna'),", sdk: ['@ai-sdk/openai'] },
    { gateway: 'copilot', provider: 'github-copilot', line: "import { copilot } from 'e2e/oauth/copilot';", model: "model: copilot('claude-sonnet-5'),", sdk: ['@ai-sdk/openai-compatible', '@ai-sdk/openai'] },
    {
      gateway: 'opencode-console',
      provider: 'opencode-console',
      line: "import { opencodeConsole } from 'e2e/oauth/opencode-console';",
      model: "model: opencodeConsole('deepseek-v4.1-flash'),",
      sdk: ['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic', '@ai-sdk/google'],
    },
    { gateway: 'grok', provider: 'spacexai', line: "import { grok } from 'e2e/oauth/grok';", model: "model: grok('grok-4'),", sdk: ['@ai-sdk/xai'] },
  ] as const)('writes a $gateway subscription model and names the sign-in as the next step', async ({ gateway, provider, line, model, sdk }) => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce(gateway);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.text).not.toHaveBeenCalled();
    expect(read('e2e.config.ts')).toContain(line);
    expect(read('e2e.config.ts')).toContain(model);
    expect(read('e2e.config.ts')).toContain(`sign in once with \`e2e login ${provider}\``);
    const devDependencies = JSON.parse(read('package.json')).devDependencies;
    expect(devDependencies).toHaveProperty('ai', '^7.0.0');
    for (const name of sdk) expect(devDependencies).toHaveProperty(name);
    expect(output()).toContain(`e2e login ${provider}, then`);
  });

  it('takes every answer from flags under --yes and writes only the chosen locations', async () => {
    const outcome = await init(dir, {
      yes: true,
      engines: ['mobile'],
      gateway: 'openrouter',
      skills: ['.agents/skills'],
      mcp: ['.mcp.json'],
      install: true,
    });
    expect(outcome).toEqual({
      exitCode: 0,
      ready: false,
      result: 'scaffolded',
      yes: true,
      example: null,
      existingConfig: false,
      engine: 'mobile',
      gateway: 'openrouter',
      skill: true,
      mcp: true,
      ci: 'none',
      install: true,
    });
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(read('e2e.config.ts')).toContain('@e2e-dev/mobile');
    expect(read('e2e.config.ts')).toContain("model: openrouter('openai/gpt-6-luna-fast'),");
    expect(existsSync(path.join(dir, '.agents/skills/e2e/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(true);
    expect(existsSync(path.join(dir, '.cursor'))).toBe(false);
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('npm', ['install'], expect.objectContaining({ cwd: dir }));
  });

  it('writes no model, skill, or MCP config when each flag says none', async () => {
    expect(await init(dir, { yes: true, engines: [], gateway: 'none', skills: [], mcp: [] })).toMatchObject({
      exitCode: 0,
      engine: 'none',
      gateway: 'none',
      skill: false,
      mcp: false,
      install: false,
    });
    expect(read('e2e.config.ts')).not.toContain('agents: {');
    expect(JSON.parse(read('package.json')).devDependencies).not.toHaveProperty('ai');
    expect(readdirSync(dir).toSorted()).toEqual(['.gitignore', 'e2e.config.ts', 'package.json', 'tests']);
    expect(output()).toContain('Skipped the agent skill');
    expect(output()).toContain('Skipped the MCP server');
  });

  it.each([
    { endpoint: ' https://llm.example/v1 ', written: 'https://llm.example/v1' },
    { endpoint: undefined, written: 'http://127.0.0.1:11434/v1' },
  ])('writes the --endpoint of an OpenAI-compatible gateway under --yes, else the local placeholder ($endpoint)', async ({ endpoint, written }) => {
    expect((await init(dir, { yes: true, gateway: 'openai-compatible', ...(endpoint === undefined ? {} : { endpoint }) })).exitCode).toBe(0);
    expect(clack.text).not.toHaveBeenCalled();
    expect(read('e2e.config.ts')).toContain(`baseURL: '${written}',`);
  });

  it('asks only the questions no flag answered', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);
    expect(await init(dir, { engines: ['web'], skills: ['.claude/skills'], mcp: [], ci: 'none', install: false })).toMatchObject({
      exitCode: 0,
      engine: 'web',
      gateway: 'none',
      install: false,
    });
    expect(clack.select).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('Which model gateway') }));
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(clack.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Apply these changes?' }));
    expect(existsSync(path.join(dir, '.claude/skills/e2e/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('warns that engine and gateway flags do not apply to an existing config', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), 'export default {};\n');
    expect(await init(dir, { yes: true, engines: ['mobile'], gateway: 'openrouter' })).toMatchObject({ exitCode: 0, engine: null, gateway: null });
    expect(read('e2e.config.ts')).toBe('export default {};\n');
    expect(output()).toContain('Ignoring --engine, --gateway: e2e.config.ts exists, and these apply to a new config only');
  });

  it('adds only the missing script to package.json beside an existing config, with no engine or gateway packages', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), 'export default {};\n');
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'existing-app', type: 'module', devDependencies: { e2e: '1.2.3' } }, null, 2)}\n`);
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(JSON.parse(read('package.json'))).toEqual({
      name: 'existing-app',
      type: 'module',
      devDependencies: { e2e: '1.2.3' },
      scripts: { 'test:e2e': 'e2e run' },
    });
    expect(read('e2e.config.ts')).toBe('export default {};\n');
  });

  it('installs the skill exactly where --skills says on a re-run, leaving earlier locations untouched', async () => {
    writeCopy('.agents/skills', 'stale');
    expect((await init(dir, { yes: true, skills: ['.claude/skills'], mcp: [] })).exitCode).toBe(0);
    expect(read('.claude/skills/e2e/SKILL.md')).toBe(readSkillFiles().find((file) => file.relative === 'SKILL.md')!.content);
    expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isSymbolicLink()).toBe(false);
    expect(read('.agents/skills/e2e/SKILL.md')).toBe('stale');
  });

  it('refuses to run without a terminal and without --yes even when flags answer every question', async () => {
    const flags = { engines: ['web'], gateway: 'none', skills: [], mcp: [], install: false } as const;
    expect(await init(dir, { interactive: false, ...flags })).toMatchObject({ exitCode: 2, result: 'not-interactive' });
    expect(readdirSync(dir)).toEqual([]);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(output()).toContain('needs an interactive terminal');
  });

  it('validates the endpoint the way config resolution will', async () => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('openai-compatible');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    const { validate } = vi.mocked(clack.text).mock.calls[0]![0] as { validate: (value: string | undefined) => string | undefined };
    expect(validate(undefined)).toContain('Enter the base URL');
    expect(validate('   ')).toContain('Enter the base URL');
    expect(validate('not a url')).toContain('Not a URL');
    expect(validate('http://llm.example/v1')).toContain('HTTPS');
    expect(validate('http://localhost:11434/v1')).toBeUndefined();
    expect(validate('https://llm.example/v1')).toBeUndefined();
  });

  it('accepts interactive selections and installs once after writing all files', async () => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
      expect(read('e2e.config.ts')).toContain('agents: {');
      expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(true);
      return spawnResult(0);
    });

    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.select).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('AI SDK v7'), initialValue: 'vercel' }));
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Install dependencies with npm?' }));
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('npm', ['install'], {
      cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
    });
    expect(output()).toContain('Next: APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('writes the selected dependencies when installation is declined', async () => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('Next: npm install, then APP_URL=');
  });

  describe('with continueWith', () => {
    const explore = ['e2e', 'explore', "Check the cart's totals", '--max-steps', '4'];
    const quoted = "e2e explore 'Check the cart'\\''s totals' --max-steps 4";

    beforeEach(() => {
      vi.stubEnv('AI_GATEWAY_API_KEY', 'key');
      vi.stubEnv('VERCEL_OIDC_TOKEN', undefined);
      vi.stubEnv('OPENROUTER_API_KEY', undefined);
      vi.stubEnv('APP_URL', undefined);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.skipIf(process.platform === 'win32')('hands over once the install leaves nothing to do by hand, naming the URL it explores', async () => {
      answers.engines = ['web'];
      vi.mocked(clack.select).mockResolvedValueOnce('vercel');
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(0));
      expect(await init(dir, { continueWith: explore })).toMatchObject({ exitCode: 0, result: 'scaffolded', ready: true });
      expect(output()).toContain(`Starting ${quoted} on http://localhost:3000 (set APP_URL for another URL)`);
      expect(output()).not.toContain('Next:');
    });

    it.skipIf(process.platform === 'win32').each([
      ['the install is declined', ['web'], 'vercel', false, `Next: npm install, then APP_URL=http://localhost:3000 npm exec -- ${quoted}`],
      ['a subscription needs a sign-in', ['web'], 'chatgpt', true, `Next: npm exec -- e2e login openai, then APP_URL=http://localhost:3000 npm exec -- ${quoted}`],
      ['the gateway key is unset', ['web'], 'openrouter', true, `Next: set OPENROUTER_API_KEY, then APP_URL=http://localhost:3000 npm exec -- ${quoted}`],
      ['no gateway was chosen', ['web'], 'none', true, 'Next: add a model to agents in e2e.config.ts, then APP_URL='],
      ['no engine was chosen', [], 'vercel', true, 'Next: add an engine target to e2e.config.ts, then APP_URL='],
      ['the mobile target is a placeholder', ['mobile'], 'vercel', true, `Next: point the mobile target in e2e.config.ts at your app, then npm exec -- ${quoted}`],
    ])('ends the Next line with the command and is not ready when %s', async (_case, engines, gateway, install, next) => {
      answers.engines = engines;
      vi.mocked(clack.select).mockResolvedValueOnce(gateway);
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(install);
      vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(0));
      expect(await init(dir, { continueWith: explore })).toMatchObject({ exitCode: 0, result: 'scaffolded', ready: false });
      expect(output()).toContain(next);
    });
  });

  it.each(['engine', 'gateway', 'endpoint', 'skill', 'mcp', 'ci', 'files', 'install'])('leaves the directory untouched when cancelling at %s', async (stage) => {
    const cancel: typeof clack.CANCEL_SYMBOL = clack.CANCEL_SYMBOL;
    answers = {
      engines: stage === 'engine' ? cancel : ['web', 'mobile'],
      skills: stage === 'skill' ? cancel : ['.agents/skills'],
      mcp: stage === 'mcp' ? cancel : ['.mcp.json'],
    };
    vi.mocked(clack.select)
      .mockResolvedValueOnce(stage === 'gateway' ? cancel : 'openai-compatible')
      .mockResolvedValueOnce(stage === 'ci' ? cancel : 'github-actions');
    vi.mocked(clack.text).mockResolvedValueOnce(stage === 'endpoint' ? cancel : 'http://127.0.0.1:11434/v1');
    vi.mocked(clack.confirm)
      .mockResolvedValueOnce(stage !== 'files')
      .mockResolvedValueOnce(cancel);

    expect((await init(dir)).exitCode).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([undefined, 'commonjs', 'module'])(
    'preserves existing dependency versions and type %s',
    async (type) => {
      const manifest = `${JSON.stringify({
        name: 'existing-app', type, scripts: { 'test:e2e': 'e2e run --workers 1' },
        dependencies: { 'e2e': 'workspace:*', '@e2e-dev/web': 'workspace:*', ai: '^7.0.12', zod: '^4.0.0' },
      }, null, 4)}\n`;
      writeFileSync(path.join(dir, 'package.json'), manifest);
      for (let run = 0; run < 2; run += 1) {
        stdoutSpy.mockClear();
        await init(dir, { yes: true });
        expect(read('package.json')).toBe(manifest);
        expect(output()).not.toContain('"type": "module"');
      }
    },
  );

  it.each([
    ['e2e run --workers 1', 'npm run test:e2e'],
    ['e2e runner --ci', 'npm exec -- e2e run'],
  ])('keeps an existing test:e2e script (%s) and points the run step at %s', async (script, step) => {
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'existing-app', scripts: { 'test:e2e': script } })}\n`);
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(JSON.parse(read('package.json')).scripts).toEqual({ 'test:e2e': script });
    expect(output()).toContain(`Next: npm install, then APP_URL=http://localhost:3000 ${step}`);
  });

  it('adds missing dependencies without changing existing fields, ranges, or formatting', async () => {
    const manifest = {
      name: 'existing-app', type: 'commonjs', scripts: { dev: 'vite' },
      dependencies: { ai: '^7.0.12' },
      devDependencies: { '@e2e-dev/web': 'file:../engine', vite: '^7.0.0' },
      custom: { enabled: true },
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 4).replaceAll('\n', '\r\n')}\r\n`);
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    expect(JSON.parse(read('package.json'))).toEqual({
      ...manifest,
      scripts: { dev: 'vite', 'test:e2e': 'e2e run' },
      devDependencies: { ...manifest.devDependencies, 'e2e': expect.any(String), zod: '^4.1.8' },
    });
    expect(read('package.json')).toContain('\r\n    "name"');
    const written = JSON.parse(read('package.json'));
    expect(Object.keys(written)).toEqual(Object.keys(manifest));
    expect(Object.keys(written.devDependencies)).toEqual(['@e2e-dev/web', 'e2e', 'vite', 'zod']);
    expect(Object.keys(written.scripts)).toEqual(['dev', 'test:e2e']);
  });

  it('appends to a hand-ordered devDependencies block and to scripts even when they sort', async () => {
    const manifest = { name: 'existing-app', scripts: { lint: 'oxlint', typecheck: 'tsc' }, devDependencies: { vite: '^7.0.0', '@types/node': '^24.0.0' } };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await init(dir, { yes: true });
    const written = JSON.parse(read('package.json'));
    expect(Object.keys(written.scripts)).toEqual(['lint', 'typecheck', 'test:e2e']);
    expect(Object.keys(written.devDependencies).slice(0, 2)).toEqual(['vite', '@types/node']);
  });

  it.each([
    ['{broken', /package\.json could not be read: .*JSON/],
    ['{"devDependencies":false}', /package\.json could not be read: devDependencies: /],
  ])('rejects invalid package.json before writing and says what is wrong (%s)', async (manifest, reason) => {
    writeFileSync(path.join(dir, 'package.json'), manifest);
    expect((await init(dir, { yes: true })).exitCode).toBe(2);
    expect(read('package.json')).toBe(manifest);
    expect(readdirSync(dir)).toEqual(['package.json']);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toMatch(reason);
    expect(output()).toContain('fix it before running e2e init');
  });

  it('refuses to prompt without a terminal and names --yes', async () => {
    expect((await init(dir, { interactive: false })).exitCode).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(output()).toContain('needs an interactive terminal');
    expect(output()).toContain('pass --yes to accept the defaults (the web engine, the Vercel AI Gateway, no installation) or --yes with flags such as --engine for other answers');
  });

  it('creates a named directory and starts the next steps with cd into it', async () => {
    const target = path.join(dir, 'apps', 'web');
    expect((await init(target, { yes: true, directory: 'apps/web' })).exitCode).toBe(0);
    expect(existsSync(path.join(target, 'e2e.config.ts'))).toBe(true);
    expect(existsSync(path.join(target, 'tests', 'example.e2e.ts'))).toBe(true);
    expect(output()).toContain('e2e init apps/web');
    expect(output()).toContain('Next: cd apps/web, then npm install, then APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('quotes a directory the shell would otherwise split, for the platform it runs on', async () => {
    expect((await init(path.join(dir, 'apps', 'my web'), { yes: true, directory: 'apps/my web' })).exitCode).toBe(0);
    expect(output()).toContain("Next: cd 'apps/my web', then npm install, then");
    expect(existsSync(path.join(dir, 'apps', 'my web', 'e2e.config.ts'))).toBe(true);

    stdoutSpy.mockClear();
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    expect((await init(path.join(dir, 'my app'), { yes: true, directory: 'my app' })).exitCode).toBe(0);
    expect(output()).toContain('Next: cd "my app", then npm install, then');
  });

  it('does not create the directory when cancelling', async () => {
    const target = path.join(dir, 'later');
    answers.engines = clack.CANCEL_SYMBOL;
    expect((await init(target, { directory: 'later' })).exitCode).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a directory argument that names a file', async () => {
    writeFileSync(path.join(dir, 'notes.txt'), '');
    expect((await init(path.join(dir, 'notes.txt'), { yes: true, directory: 'notes.txt' })).exitCode).toBe(2);
    expect(output()).toContain('notes.txt is a file, not a directory');
  });

  it.each(['packageManager', 'lockfile'])('uses pnpm when selected by the %s', async (source) => {
    if (source === 'packageManager') {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', packageManager: 'pnpm@10.2.1' }));
    } else {
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    }
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await init(dir);
    expect(spawnSync).toHaveBeenCalledWith('pnpm', ['install'], expect.objectContaining({ cwd: dir }));
  });

  it('keeps the scaffold and returns a failure when installation fails', async () => {
    vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(1));
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    expect((await init(dir)).exitCode).toBe(2);
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
    expect(output()).toContain('retry with npm install');
  });

  it.each(['e2e.config.ts', 'e2e.config.mts', 'e2e.config.js', 'e2e.config.mjs'])('never overwrites an existing %s or assumes its optional packages', async (config) => {
    writeFileSync(path.join(dir, config), '// custom config\n');
    await init(dir, { yes: true });
    expect(read(config)).toBe('// custom config\n');
    expect(Object.keys(JSON.parse(read('package.json')).devDependencies)).toEqual(['e2e']);
    expect(JSON.parse(read('package.json')).scripts).toEqual({ 'test:e2e': 'e2e run' });
    if (config !== 'e2e.config.ts') expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(false);
    const javascript = config.endsWith('js');
    expect(existsSync(path.join(dir, 'tests/example.e2e.js'))).toBe(javascript);
    expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(!javascript);
    expect(output().includes('No tsconfig.json')).toBe(!javascript);
  });

  it('reconciles new .gitignore entries without replacing existing source files', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n');
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests/example.e2e.ts'), '// custom test\n');
    const older = 'node_modules/\n.e2e/artifacts/\n.e2e/cache/\n.e2e/sessions/\n.e2e/report.json\n';
    writeFileSync(path.join(dir, '.gitignore'), older);
    await init(dir, { yes: true });
    expect(read('e2e.config.ts')).toBe('// custom config\n');
    expect(read('tests/example.e2e.ts')).toBe('// custom test\n');
    expect(read('.gitignore')).toBe(`${older}.e2e/results/\n.e2e/ai-trace.json\n.e2e/timings.json\n.e2e/junit.xml\n.e2e/summary.md\n.e2e/logs/\n.e2e/videos/\n`);
    expect(output()).not.toContain('commit-the-replay-cache');
  });

  it('installs the skill where selected, then refreshes only those copies', async () => {
    answers.skills = ['.claude/skills'];
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.multiselect).toHaveBeenCalledTimes(3);
    expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      options: [expect.objectContaining({ value: '.agents/skills' }), expect.objectContaining({ value: '.claude/skills' })],
      initialValues: ['.agents/skills', '.claude/skills'],
      required: false,
    }));
    expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      options: [expect.objectContaining({ value: '.mcp.json' }), expect.objectContaining({ value: '.cursor/mcp.json' }), expect.objectContaining({ value: '.codex/config.toml' })],
      initialValues: ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml'],
      required: false,
    }));
    expect(read('.mcp.json')).toContain('"e2e"');
    expect(output()).toContain('  - Create .claude/skills/e2e/');
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Apply these changes?' }));
    expect(existsSync(path.join(dir, '.agents/skills'))).toBe(false);
    expect(output()).toContain('Created .claude/skills/e2e/');
    const reference = path.join(dir, '.claude/skills/e2e/references/setup.md');
    const shipped = read('.claude/skills/e2e/references/setup.md');

    writeFileSync(reference, 'stale\n');
    stdoutSpy.mockClear();
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(read('.claude/skills/e2e/references/setup.md')).toBe(shipped);
    expect(existsSync(path.join(dir, '.agents/skills'))).toBe(false);
    expect(clack.multiselect).toHaveBeenCalledTimes(3);
    expect(output()).toContain('Updated .claude/skills/e2e/');
  });

  it('repairs a damaged copy without asking and leaves other locations alone', async () => {
    mkdirSync(path.join(dir, '.agents/skills/e2e/references'), { recursive: true });
    writeFileSync(path.join(dir, '.agents/skills/e2e/references/setup.md'), 'stale\n');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(read('.agents/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(output()).toContain('Updated .agents/skills/e2e/');
  });

  it.skipIf(!symlinks)('links .claude/skills/e2e to the copy in .agents/skills when both are chosen, and a second run has nothing to do', async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(output()).toContain('  - Create .agents/skills/e2e/\n');
    expect(output()).toContain('  - Link .claude/skills/e2e -> ../../.agents/skills/e2e\n');
    expect(output()).toContain('  - Create .mcp.json\n');
    expect(clack.confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'Apply these changes?' }));
    const link = path.join(dir, '.claude/skills/e2e');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../.agents/skills/e2e');
    expect(realpathSync(link)).toBe(realpathSync(path.join(dir, '.agents/skills/e2e')));
    expect(read('.claude/skills/e2e/SKILL.md')).toBe(read('.agents/skills/e2e/SKILL.md'));
    expect(output()).toContain('Created .agents/skills/e2e/');
    expect(output()).toContain('Linked .claude/skills/e2e -> ../../.agents/skills/e2e');
    expect(output()).not.toContain('(replaced');

    stdoutSpy.mockClear();
    expect((await init(dir, { yes: true })).result).toBe('already-initialized');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(output()).not.toContain('Linked');
  });

  it.skipIf(!symlinks)('replaces an earlier copy in .claude/skills with the link when it holds only shipped files', async () => {
    writeCopy('.agents/skills');
    writeCopy('.claude/skills', 'stale\n');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    // Both directories hold the skill, so the locations are not asked again.
    expect(clack.multiselect).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Install the e2e skill for coding agents?' }));
    expect(output()).toContain('  - Link .claude/skills/e2e -> ../../.agents/skills/e2e (replacing the copy)\n');
    expect(clack.confirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'Apply these changes?' }));
    const link = path.join(dir, '.claude/skills/e2e');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../.agents/skills/e2e');
    expect(read('.claude/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(output()).toContain('Linked .claude/skills/e2e -> ../../.agents/skills/e2e (replaced the copy)');
    expect(output()).not.toContain('Updated .agents/skills/e2e/');
  });

  it('keeps an earlier copy in .claude/skills that holds other files, and refreshes it', async () => {
    writeCopy('.agents/skills');
    writeCopy('.claude/skills', 'stale\n');
    writeFileSync(path.join(dir, '.claude/skills/e2e/notes.md'), 'mine\n');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isDirectory()).toBe(true);
    expect(read('.claude/skills/e2e/notes.md')).toBe('mine\n');
    expect(read('.claude/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(output()).toContain('Updated .claude/skills/e2e/');
    expect(output()).not.toContain('Linked');
  });

  it.skipIf(!symlinks)('keeps an earlier copy in .claude/skills whose SKILL.md is a symlink, and leaves that link alone', async () => {
    writeCopy('.agents/skills');
    writeCopy('.claude/skills');
    const mine = path.join(dir, 'mine.md');
    writeFileSync(mine, 'mine\n');
    const linked = path.join(dir, '.claude/skills/e2e/SKILL.md');
    rmSync(linked);
    symlinkSync(path.join('..', '..', '..', 'mine.md'), linked);
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e/ (.claude/skills/e2e/SKILL.md -> ${realpathSync(mine)})`);
    expect(output()).not.toContain('Linked');
    expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isDirectory()).toBe(true);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(read('mine.md')).toBe('mine\n');
  });

  it.skipIf(!symlinks)('needs no link when .claude/skills already leads to .agents/skills', async () => {
    mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
    mkdirSync(path.join(dir, '.claude'));
    symlinkSync(path.join('..', '.agents', 'skills'), path.join(dir, '.claude/skills'), 'dir');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(readdirSync(path.join(dir, '.agents/skills'))).toEqual(['e2e']);
    expect(lstatSync(path.join(dir, '.agents/skills/e2e')).isDirectory()).toBe(true);
    expect(lstatSync(path.join(dir, '.claude/skills')).isSymbolicLink()).toBe(true);
    expect(output()).toContain('Created .agents/skills/e2e/');
    expect(output()).not.toContain('Linked');
    expect(output()).not.toContain('not touching');
  });

  it('fails before any prompt or write when the package lacks its skill files', async () => {
    vi.mocked(readSkillFiles).mockReturnValueOnce([]);
    expect((await init(dir)).exitCode).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(output()).toContain('reinstall e2e');
  });

  it('offers the skill to an initialized project and points at e2e guide when declined', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n');
    answers = { engines: ['web'], skills: [], mcp: [] };
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(false);
    expect(output()).toContain('npm exec -- e2e guide');
    expect(output()).toContain('e2e init --yes --skills none --mcp .codex/config.toml,.mcp.json,.cursor/mcp.json');
  });

  it('is idempotent', async () => {
    answers.engines = ['web'];
    vi.mocked(clack.select).mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const files = ['package.json', 'e2e.config.ts', 'tests/example.e2e.ts', '.gitignore', '.agents/skills/e2e/SKILL.md'];
    const before = files.map(read);
    stdoutSpy.mockClear();
    await init(dir, { yes: true });
    expect(files.map(read)).toEqual(before);
    expect(output()).toContain('Nothing to create; project already initialized');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('is idempotent with both engines and adds no engine-less example beside theirs', async () => {
    expect((await init(dir, { yes: true, engines: ['web', 'mobile'] })).exitCode).toBe(0);
    stdoutSpy.mockClear();
    expect(await init(dir, { yes: true })).toMatchObject({ exitCode: 0, result: 'already-initialized' });
    expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(false);
    expect(readdirSync(path.join(dir, 'tests')).toSorted()).toEqual(['mobile.e2e.ts', 'web.e2e.ts']);
  });

  it('preserves existing ignores and appends only missing entries', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\r\n.e2e/artifacts/');
    await init(dir, { yes: true });
    expect(read('.gitignore').startsWith('node_modules/\r\n.e2e/artifacts/\n')).toBe(true);
    expect(read('.gitignore').match(/\.e2e\/artifacts\//g)).toHaveLength(1);
    expect(read('.gitignore')).toContain('.e2e/sessions/');
  });

  it('skips a copy with a directory where a file goes or a file where a directory goes, naming each', async () => {
    mkdirSync(path.join(dir, '.agents/skills/e2e/SKILL.md'), { recursive: true });
    writeFileSync(path.join(dir, '.agents/skills/e2e/references'), 'not a directory\n');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(output()).toContain('Broken, not touching: .agents/skills/e2e/ (SKILL.md is a directory, references is a file)');
    expect(lstatSync(path.join(dir, '.agents/skills/e2e/SKILL.md')).isDirectory()).toBe(true);
    expect(read('.agents/skills/e2e/references')).toBe('not a directory\n');
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(read('e2e.config.ts')).toContain('targets:');
    expect(JSON.parse(read('.mcp.json'))).toHaveProperty('mcpServers.e2e');
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('plans a location outside the project as links, even with no symlink on the way', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
    try {
      const location = path.relative(dir, path.join(elsewhere, 'skills')).split(path.sep).join('/');
      const bundled = readSkillFiles();
      const installs = planSkillInstall(dir, [location], bundled);
      expect(installs).toHaveLength(1);
      expect(installs[0]!.relative).toBe(`${location}/e2e`);
      expect(installs[0]!.existing).toBe(false);
      expect(installs[0]!.obstacles).toEqual([]);
      expect(installs[0]!.links).toEqual(
        bundled.map((file) => ({
          relative: `${location}/e2e/${file.relative}`,
          target: path.join(realpathSync(elsewhere), 'skills', 'e2e', file.relative),
        })),
      );
      expect(existsSync(path.join(elsewhere, 'skills'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  describe.skipIf(!symlinks)('a symlinked skill directory', () => {
    /** Links `<location>/e2e` to `target`, which holds the user's own SKILL.md. */
    function linkSkill(location: string, target: string): void {
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'SKILL.md'), 'mine\n');
      mkdirSync(path.join(dir, location), { recursive: true });
      symlinkSync(target, path.join(dir, location, 'e2e'), 'dir');
    }

    /** The target holds exactly what the user put there. */
    function untouched(target: string): void {
      expect(readdirSync(target)).toEqual(['SKILL.md']);
      expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe('mine\n');
    }

    it('is left alone under --yes when it points outside the project, and the warning names it', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'e2e');
        linkSkill('.claude/skills', target);
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        untouched(target);
        expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isSymbolicLink()).toBe(true);
        expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e -> ${realpathSync(target)}`);
        expect(output()).not.toContain('.claude/skills/e2e/ (');
        expect(read('e2e.config.ts')).toContain('targets:');
        expect(JSON.parse(read('.mcp.json'))).toHaveProperty('mcpServers.e2e');
        expect(read('.gitignore')).toContain('.e2e/cache/');
        // The link counts as the installed location, so no other one is added.
        expect(existsSync(path.join(dir, '.agents'))).toBe(false);
        expect(clack.confirm).not.toHaveBeenCalled();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('is left alone under --yes without reading what it leads to, even a directory named SKILL.md', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'e2e');
        mkdirSync(path.join(target, 'SKILL.md'), { recursive: true });
        mkdirSync(path.join(dir, '.claude/skills'), { recursive: true });
        symlinkSync(target, path.join(dir, '.claude/skills/e2e'), 'dir');
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e -> ${realpathSync(target)}`);
        expect(output()).not.toContain('Broken, not touching');
        expect(lstatSync(path.join(target, 'SKILL.md')).isDirectory()).toBe(true);
        expect(readdirSync(target)).toEqual(['SKILL.md']);
        expect(read('e2e.config.ts')).toContain('targets:');
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('is left alone under --yes when it points inside the project', async () => {
      const target = path.join(dir, 'shared', 'e2e');
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'SKILL.md'), 'mine\n');
      mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
      symlinkSync(path.join('..', '..', 'shared', 'e2e'), path.join(dir, '.agents/skills/e2e'), 'dir');
      expect((await init(dir, { yes: true })).exitCode).toBe(0);
      untouched(target);
      expect(output()).toContain(`Symlink, not touching: .agents/skills/e2e -> ${realpathSync(target)}`);
      expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    });

    it('asks before replacing the link with a copy, declining by default', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'e2e');
        linkSkill('.claude/skills', target);
        const question = {
          message: `Replace the symlink .claude/skills/e2e -> ${realpathSync(target)} with a copy of the skill?`,
          initialValue: false,
        };
        vi.mocked(clack.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await init(dir)).exitCode).toBe(0);
        expect(clack.confirm).toHaveBeenCalledTimes(3);
        expect(clack.confirm).toHaveBeenNthCalledWith(1, question);
        expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isSymbolicLink()).toBe(true);
        untouched(target);
        expect(output()).not.toContain('Symlink, not touching');

        stdoutSpy.mockClear();
        vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        expect((await init(dir)).exitCode).toBe(0);
        expect(clack.confirm).toHaveBeenNthCalledWith(4, question);
        expect(output()).toContain('  - Replace .claude/skills/e2e/');
        expect(clack.confirm).toHaveBeenNthCalledWith(5, expect.objectContaining({ message: 'Apply these changes?' }));
        expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isSymbolicLink()).toBe(false);
        expect(read('.claude/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
        expect(read('.claude/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
        untouched(target);
        expect(output()).toContain('Replaced .claude/skills/e2e/');
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('is left alone under --yes when it dangles, and the warning names the target as written', async () => {
      mkdirSync(path.join(dir, '.claude/skills'), { recursive: true });
      const link = path.join(dir, '.claude/skills/e2e');
      symlinkSync(path.join('..', '..', 'gone', 'e2e'), link, 'dir');
      expect((await init(dir, { yes: true })).exitCode).toBe(0);
      expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e -> ${path.join(dir, 'gone', 'e2e')}`);
      expect(output()).not.toContain('Broken, not touching');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(link)).toBe(false);
      expect(existsSync(path.join(dir, 'gone'))).toBe(false);
      // A link to nothing is no installed copy, so --yes takes every location and the other one gets the skill.
      expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
      expect(clack.confirm).not.toHaveBeenCalled();
    });

    it('is replaced with the link when it dangles beside a chosen .agents/skills and the user agrees', async () => {
      mkdirSync(path.join(dir, '.claude/skills'), { recursive: true });
      const link = path.join(dir, '.claude/skills/e2e');
      symlinkSync(path.join('..', '..', 'gone', 'e2e'), link, 'dir');
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect((await init(dir)).exitCode).toBe(0);
      expect(clack.confirm).toHaveBeenNthCalledWith(1, {
        message: `Replace the symlink .claude/skills/e2e -> ${path.join(dir, 'gone', 'e2e')} with a link to ../../.agents/skills/e2e?`,
        initialValue: false,
      });
      expect(output()).toContain('  - Create .agents/skills/e2e/\n');
      expect(output()).toContain('  - Link .claude/skills/e2e -> ../../.agents/skills/e2e (replacing the symlink)\n');
      expect(clack.confirm).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'Apply these changes?' }));
      expect(readlinkSync(link)).toBe('../../.agents/skills/e2e');
      expect(read('.claude/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
      expect(read('.claude/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
      expect(existsSync(path.join(dir, 'gone'))).toBe(false);
      expect(output()).toContain('Linked .claude/skills/e2e -> ../../.agents/skills/e2e (replaced the symlink)');
    });

    it('is left alone under --yes beside a copy in .agents/skills, and the warning names it', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'e2e');
        linkSkill('.claude/skills', target);
        writeCopy('.agents/skills');
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e -> ${realpathSync(target)}`);
        expect(output()).not.toContain('Linked');
        expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isSymbolicLink()).toBe(true);
        untouched(target);
        expect(clack.confirm).not.toHaveBeenCalled();
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('gets a copy in .claude/skills when the .agents/skills copy is left alone', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'e2e');
        linkSkill('.agents/skills', target);
        writeCopy('.claude/skills', 'stale\n');
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        expect(output()).toContain(`Symlink, not touching: .agents/skills/e2e -> ${realpathSync(target)}`);
        expect(lstatSync(path.join(dir, '.claude/skills/e2e')).isDirectory()).toBe(true);
        expect(read('.claude/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
        expect(output()).toContain('Updated .claude/skills/e2e/');
        expect(output()).not.toContain('Linked');
        untouched(target);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('is skipped without a question when a parent is the link', async () => {
      const shared = path.join(dir, 'shared');
      const target = path.join(shared, 'e2e');
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'SKILL.md'), 'mine\n');
      mkdirSync(path.join(dir, '.claude'));
      symlinkSync(shared, path.join(dir, '.claude/skills'), 'dir');
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect((await init(dir)).exitCode).toBe(0);
      expect(clack.confirm).toHaveBeenCalledTimes(2);
      expect(output()).toContain(`Symlink, not touching: .claude/skills/e2e/ (.claude/skills -> ${realpathSync(shared)})`);
      untouched(target);
      expect(lstatSync(path.join(dir, '.claude/skills')).isSymbolicLink()).toBe(true);
    });
  });

  describe('a linked MCP config', () => {
    // A junction works on Windows without the symlink privilege, and a symlink on POSIX.
    const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
    // A junction needs no privilege, so the directory case runs on Windows whatever `symlinks` says; POSIX still needs it.
    const canLinkDir = process.platform === 'win32' || symlinks;

    it.skipIf(!symlinks)('is left alone under --yes, the warning names it, and the target keeps its own servers', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        const target = path.join(elsewhere, 'mcp.json');
        const original = '{"mcpServers":{"figma":{"command":"figma-mcp"}}}\n';
        writeFileSync(target, original);
        symlinkSync(target, path.join(dir, '.mcp.json'), 'file');
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        expect(output()).toContain(`Symlink, not touching: .mcp.json -> ${realpathSync(target)} (e2e mcp server)`);
        expect(output()).not.toContain('Updated .mcp.json');
        // The linked file is untouched and still a link; the other location is written normally.
        expect(readFileSync(target, 'utf8')).toBe(original);
        expect(lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
        expect(JSON.parse(read('.cursor/mcp.json'))).toHaveProperty('mcpServers.e2e');
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it.skipIf(!canLinkDir)('is left alone when a parent directory is the link, and nothing is written through it', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        symlinkSync(elsewhere, path.join(dir, '.cursor'), dirLink);
        expect((await init(dir, { yes: true })).exitCode).toBe(0);
        expect(output()).toContain(`Symlink, not touching: .cursor -> ${realpathSync(elsewhere)} (e2e mcp server)`);
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(JSON.parse(read('.mcp.json'))).toHaveProperty('mcpServers.e2e');
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });

  describe('with a CI workflow', () => {
    const workflow = '.github/workflows/e2e.yml';

    it('writes the GitHub Actions workflow with --ci and says what CI still needs', async () => {
      expect(await init(dir, { yes: true, ci: 'github-actions' })).toMatchObject({ exitCode: 0, result: 'scaffolded', ci: 'github-actions' });
      expect(read(workflow)).toContain('run: npx e2e run --reporter list,junit');
      expect(read(workflow)).toContain('AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}');
      expect(output()).toContain(`Created ${workflow} (GitHub Actions)`);
      expect(output()).toContain('add it with gh secret set AI_GATEWAY_API_KEY');
      // The new config leaves app.command commented out, so nothing would start the app on the runner.
      expect(output()).toContain('Nothing starts the app in CI: set app.command in e2e.config.ts');
    });

    it('writes none under --yes alone, and none over an existing workflow', async () => {
      expect(await init(dir, { yes: true })).toMatchObject({ ci: 'none' });
      expect(existsSync(path.join(dir, workflow))).toBe(false);

      mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
      writeFileSync(path.join(dir, workflow), 'name: mine\n');
      expect(await init(dir, { yes: true, ci: 'github-actions' })).toMatchObject({ result: 'already-initialized' });
      expect(read(workflow)).toBe('name: mine\n');
      expect(output()).toContain(`Exists, not touching: ${workflow}`);
    });

    it('asks with GitHub Actions preselected in a GitHub repository, and not again once the workflow exists', async () => {
      answers.engines = ['web'];
      mkdirSync(path.join(dir, '.github'));
      vi.mocked(clack.select).mockResolvedValueOnce('none').mockResolvedValueOnce('github-actions');
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await init(dir)).toMatchObject({ exitCode: 0, ci: 'github-actions' });
      expect(clack.select).toHaveBeenLastCalledWith(expect.objectContaining({
        message: 'Add a CI pipeline that runs the tests?',
        initialValue: 'github-actions',
        options: [
          expect.objectContaining({ value: 'github-actions' }),
          expect.objectContaining({ value: 'gitlab' }),
          expect.objectContaining({ value: 'none' }),
        ],
      }));
      expect(output()).toContain(`Create ${workflow}`);
      // No model was chosen, so the workflow reads no key.
      expect(read(workflow)).not.toContain('env:');

      vi.mocked(clack.select).mockClear();
      expect(await init(dir)).toMatchObject({ result: 'already-initialized', ci: null });
      expect(clack.select).not.toHaveBeenCalled();
    });

    it('preselects none outside a GitHub repository', async () => {
      answers.engines = ['web'];
      vi.mocked(clack.confirm).mockResolvedValueOnce(false);
      await init(dir);
      expect(clack.select).toHaveBeenLastCalledWith(expect.objectContaining({ initialValue: 'none' }));
    });

    it.each([
      { host: 'darwin', platform: 'ios', label: 'iOS' },
      { host: 'linux', platform: 'android', label: 'Android' },
    ] as const)('writes the $platform job alone for a mobile-only project on $host', async ({ host, platform, label }) => {
      vi.spyOn(os, 'platform').mockReturnValue(host);
      expect(await init(dir, { yes: true, engines: ['mobile'], ci: 'github-actions' })).toMatchObject({ exitCode: 0, ci: 'github-actions' });
      const jobs = (parseYaml(read(workflow)) as { jobs: Record<string, unknown> }).jobs;
      expect(Object.keys(jobs)).toEqual([platform]);
      expect(read(workflow)).toContain(`npx e2e run --target ${platform} --workers 1 --reporter list,junit`);
      // Not an Expo or React Native project, so the build is the user's to write.
      expect(output()).toContain(`The ${label} job's build step is a placeholder that fails`);
      // app.command starts a web app; a phone job installs its build.
      expect(output()).not.toContain('Nothing starts the app in CI');
    });

    it('runs the web and phone targets in their own jobs when the config has both', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      await init(dir, { yes: true, engines: ['web', 'mobile'], ci: 'github-actions' });
      expect(Object.keys((parseYaml(read(workflow)) as { jobs: object }).jobs)).toEqual(['web', 'ios']);
      expect(read(workflow)).toContain('run: npx e2e run --target web --reporter list,junit');
      expect(read(workflow)).toContain('run: npx e2e run --target ios --workers 1 --reporter list,junit');
    });

    it('builds an Expo app in the phone jobs', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('linux');
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
      await init(dir, { yes: true, engines: ['mobile'], ci: 'github-actions' });
      expect(read(workflow)).toContain('npx expo prebuild --platform android --no-install');
      expect(output()).not.toContain('placeholder');
    });

    it('tells GitLab users the phone jobs need self-managed runners and a device from E2E_DEVICE', async () => {
      vi.spyOn(os, 'platform').mockReturnValue('darwin');
      await init(dir, { yes: true, engines: ['mobile'], ci: 'gitlab' });
      expect(Object.keys(parseYaml(read('.gitlab-ci.yml')) as object)).toEqual(['.e2e-mobile', 'e2e-ios']);
      expect(output()).toContain("GitLab's hosted runners can't run a simulator or an emulator");
      expect(output()).toContain('set device: process.env.E2E_DEVICE in each mobile() target');
    });

    it('asks nothing for a new config with no engine, whatever package.json still lists', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@e2e-dev/web': '*' } }));
      answers.engines = [];
      vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await init(dir, { gateway: 'none', skills: [], mcp: [] })).toMatchObject({ exitCode: 0, ci: null });
      expect(clack.select).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Add a CI pipeline that runs the tests?' }));
    });

    it('counts an engine an existing project declares as a peer', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ peerDependencies: { '@e2e-dev/web': '*' } }));
      writeFileSync(path.join(dir, 'e2e.config.ts'), "export default { targets: [{ platform: 'web' }] };\n");
      await init(dir, { yes: true, ci: 'github-actions' });
      expect(read(workflow)).toContain('run: npx e2e run --reporter list,junit');
    });

    it('writes no pipeline for a project with neither engine', async () => {
      expect(await init(dir, { yes: true, engines: [], ci: 'github-actions' })).toMatchObject({ exitCode: 0, ci: null });
      expect(existsSync(path.join(dir, '.github'))).toBe(false);
      expect(output()).toContain('Ignoring --ci: init writes a pipeline for web, iOS, and Android targets, and the project has none');
    });

    it('writes the workflow at the repository root for a project in a subfolder', async () => {
      const project = path.join(dir, 'e2e');
      mkdirSync(path.join(dir, '.git'), { recursive: true });
      mkdirSync(project);
      writeFileSync(path.join(dir, '.nvmrc'), '24\n');
      expect((await init(project, { yes: true, ci: 'github-actions' })).exitCode).toBe(0);
      expect(existsSync(path.join(project, '.github'))).toBe(false);
      expect(read(workflow)).toContain('        working-directory: e2e\n');
      expect(read(workflow)).toContain('          node-version-file: .nvmrc\n');
      expect(read(workflow)).toContain("hashFiles('e2e/package-lock.json')");
      expect(output()).toContain('Created ../.github/workflows/e2e.yml (GitHub Actions)');
    });

    it('reads the key and the start command from an existing config', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/web': '*' } }));
      stubPackage('@openrouter/ai-sdk-provider', 'export const openrouter = () => undefined;');
      writeFileSync(path.join(dir, 'e2e.config.ts'), [
        "import { openrouter } from '@openrouter/ai-sdk-provider';",
        "export default { model: openrouter, targets: [{ platform: 'web', app: { url: 'http://localhost:3100', command: { executable: 'npm', args: ['run', 'dev'] } } }] };",
        '',
      ].join('\n'));
      expect((await init(dir, { yes: true, ci: 'github-actions' })).exitCode).toBe(0);
      expect(read(workflow)).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
      expect(output()).not.toContain('Nothing starts the app in CI');
    });

    it('writes .gitlab-ci.yml with --ci gitlab and names the CI/CD variable to add', async () => {
      expect(await init(dir, { yes: true, ci: 'gitlab' })).toMatchObject({ exitCode: 0, ci: 'gitlab' });
      expect(read('.gitlab-ci.yml')).toContain('    - npx e2e run --reporter list,junit\n');
      expect(output()).toContain('Created .gitlab-ci.yml (GitLab CI/CD)');
      expect(output()).toContain('glab variable set AI_GATEWAY_API_KEY --masked --hidden --raw');
      // A second run finds the job in the pipeline and asks nothing more.
      expect(await init(dir, { yes: true, ci: 'gitlab' })).toMatchObject({ result: 'already-initialized' });
      expect(output()).toContain('Exists, not touching: .gitlab-ci.yml');
    });

    it('leaves an existing .gitlab-ci.yml alone and writes a file for it to include', async () => {
      writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'build:\n  script: [make]\n');
      await init(dir, { yes: true, ci: 'gitlab' });
      expect(read('.gitlab-ci.yml')).toBe('build:\n  script: [make]\n');
      expect(read('.gitlab/e2e.gitlab-ci.yml')).toMatch(/^e2e-web:\n/mu);
      expect(output()).toContain('.gitlab-ci.yml exists, not touching it; add this to it to run the e2e jobs:');
      expect(output()).toMatch(/include:\n\S*\s+- local: \.gitlab\/e2e\.gitlab-ci\.yml/u);
    });

    it('preselects GitLab in a repository with a GitLab remote', async () => {
      answers.engines = ['web'];
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://gitlab.com/acme/app.git\n');
      vi.mocked(clack.confirm).mockResolvedValueOnce(false);
      await init(dir);
      expect(clack.select).toHaveBeenLastCalledWith(expect.objectContaining({ initialValue: 'gitlab' }));
    });

    it('installs a workspace member at the workspace root with the workspace manager', async () => {
      vi.stubEnv('npm_config_user_agent', 'npm/11.0.0');
      mkdirSync(path.join(dir, '.git'));
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@10.0.0' }));
      writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
      writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const project = path.join(dir, 'apps', 'web');
      mkdirSync(project, { recursive: true });
      expect((await init(project, { yes: true, ci: 'github-actions' })).exitCode).toBe(0);
      expect(read(workflow)).toContain('      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n        working-directory: .\n');
      expect(read(workflow)).toContain("hashFiles('pnpm-lock.yaml')");
      expect(read(workflow)).toContain('        run: pnpm exec e2e run --reporter list,junit\n');
    });

    it('reads the target names and platforms from an existing config', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/web': '*', '@e2e-dev/mobile': '*' } }));
      writeFileSync(path.join(dir, 'e2e.config.ts'), [
        'const engine = (platform: string) => ({ platform });',
        "export default { targets: [{ name: 'chromium', engine: engine('web') }, { name: 'iphone', engine: engine('ios') }, { name: 'pixel', engine: engine('android') }] };",
        '',
      ].join('\n'));
      await init(dir, { yes: true, ci: 'github-actions' });
      expect(read(workflow)).toContain('run: npx e2e run --target chromium --reporter list,junit');
      expect(read(workflow)).toContain('run: npx e2e run --target iphone --workers 1 --reporter list,junit');
      expect(read(workflow)).toContain('npx e2e run --target pixel --workers 1 --reporter list,junit');
    });

    it('runs every target in one web job when an existing web config does not load, and says why', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/web': '*' } }));
      writeFileSync(path.join(dir, 'e2e.config.ts'), "import { web } from 'not-installed-engine';\nexport default { targets: [{ engine: web() }] };\n");
      await init(dir, { yes: true, ci: 'github-actions' });
      expect(Object.keys((parseYaml(read(workflow)) as { jobs: object }).jobs)).toEqual(['web']);
      expect(read(workflow)).toContain('run: npx e2e run --reporter list,junit');
      expect(output()).toContain('Could not read the targets of e2e.config.ts');
      expect(output()).toContain('The pipeline runs every target in one web job');
      expect(output()).not.toContain('No web, iOS, or Android target');
    });

    it('writes no pipeline when an existing mobile config does not load', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/mobile': '*' } }));
      writeFileSync(path.join(dir, 'e2e.config.ts'), "import { mobile } from 'not-installed-engine';\nexport default { targets: [{ engine: mobile() }] };\n");
      await init(dir, { yes: true, ci: 'github-actions' });
      expect(existsSync(path.join(dir, workflow))).toBe(false);
      expect(output()).toContain('No pipeline: the mobile jobs need the config\'s targets');
    });

    it('loads an existing config only after the changes are confirmed and the dependencies installed', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/web': '*' } }));
      writeFileSync(path.join(dir, 'e2e.config.ts'), "import { engine } from 'late-engine';\nexport default { targets: [{ name: 'chromium', engine }] };\n");
      // The install puts the engine in place; before it, the config could not load.
      vi.mocked(spawnSync).mockImplementationOnce(() => {
        stubPackage('late-engine', "export const engine = { platform: 'web' };");
        return spawnResult(0);
      });
      await init(dir, { yes: true, ci: 'github-actions', install: true });
      expect(read(workflow)).toContain('run: npx e2e run --reporter list,junit');
      expect(output()).not.toContain('Could not read the targets');

      // Cancelled at the confirmation, the config never runs.
      rmSync(path.join(dir, workflow));
      writeFileSync(path.join(dir, 'e2e.config.ts'), "globalThis.configRan = true;\nexport default { targets: [{ platform: 'web' }] };\n");
      vi.mocked(clack.confirm).mockResolvedValueOnce(false);
      await init(dir, { ci: 'github-actions', skills: [], mcp: [] });
      expect((globalThis as { configRan?: boolean }).configRan).toBeUndefined();
    });

    it('warns that a model served on this machine is out of the runner\'s reach', async () => {
      await init(dir, { yes: true, gateway: 'openai-compatible', ci: 'gitlab' });
      expect(output()).toContain('The model endpoint is on this machine, so agent steps fail in CI');
      rmSync(path.join(dir, 'e2e.config.ts'));
      rmSync(path.join(dir, '.gitlab-ci.yml'));
      await init(dir, { yes: true, gateway: 'openai-compatible', endpoint: 'https://llm.example/v1', ci: 'gitlab' });
      expect(output().match(/The model endpoint is on this machine/gu)).toHaveLength(1);
    });

    it('reads a loopback endpoint from an existing config too', async () => {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '*', '@e2e-dev/web': '*' } }));
      stubPackage('@ai-sdk/openai-compatible', 'export const createOpenAICompatible = (options) => options;');
      writeFileSync(path.join(dir, 'e2e.config.ts'), [
        "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';",
        "const model = createOpenAICompatible({ name: 'local',",
        "  baseURL: 'http://127.0.0.1:11434/v1',",
        '});',
        "export default { model, targets: [{ platform: 'web' }] };",
        '',
      ].join('\n'));
      await init(dir, { yes: true, ci: 'gitlab' });
      expect(output()).toContain('The model endpoint is on this machine, so agent steps fail in CI');
    });

    // A junction needs no symlink privilege on Windows.
    it.skipIf(!symlinks && process.platform !== 'win32')('writes nothing through a symlinked .github folder', async () => {
      const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-elsewhere-'));
      try {
        symlinkSync(elsewhere, path.join(dir, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(await init(dir, { yes: true, ci: 'github-actions' })).toMatchObject({ exitCode: 0 });
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(output()).toContain(`Symlink, not touching: .github -> ${realpathSync(elsewhere)} (.github/workflows/e2e.yml)`);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it('warns that a subscription gateway has no key to give CI', async () => {
      await init(dir, { yes: true, gateway: 'chatgpt', ci: 'github-actions' });
      expect(read(workflow)).not.toContain('env:');
      expect(output()).toContain('ChatGPT Plus/Pro subscription signs in on this machine only, so agent steps fail in CI');
    });
  });
});
