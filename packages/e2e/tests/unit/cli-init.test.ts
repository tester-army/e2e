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
import { init } from '../../src/cli/init.ts';
import { planSkillInstall } from '../../src/cli/init/agent-skill.ts';
import { dependencyRange } from '../../src/cli/init/versions.ts';
import { readSkillFiles } from '../../src/cli/skill.ts';

vi.mock('@clack/prompts', { spy: true });
vi.mock('../../src/cli/skill.ts', { spy: true });
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

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
  vi.mocked(clack.multiselect)
    .mockReset()
    .mockImplementation(async (prompt) =>
      String(prompt.message).includes('MCP') ? ['.mcp.json', '.cursor/mcp.json'] : ['.agents/skills', '.claude/skills'],
    );
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
      devDependencies: { 'e2e': dependencyRange(runnerVersion), '@e2e-dev/web': '0.x', playwright: '^1', ai: '^7.0.0' },
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
    expect(read('.gitignore')).toContain('node_modules/');
    expect(read('.gitignore')).toContain('.e2e/junit.xml');
    expect(read('.gitignore')).toContain('.e2e/summary.md');
    expect(read('.gitignore')).toContain('.e2e/cache/');
    expect(output()).toContain('.e2e/cache/ is ignored; committing agent.act replays is opt-in, see https://e2e.tester.army/docs/cache#commit-the-replay-cache');
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

  it('hands back what --yes chose, then that a second run had nothing to do', async () => {
    expect(await init(dir, { yes: true })).toEqual({
      exitCode: 0,
      result: 'scaffolded',
      yes: true,
      existingConfig: false,
      engine: 'web',
      gateway: 'vercel',
      skill: true,
      mcp: true,
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
    vi.mocked(clack.select).mockResolvedValueOnce('mobile').mockResolvedValueOnce('none');
    vi.mocked(clack.multiselect).mockResolvedValueOnce(['.agents/skills']).mockResolvedValueOnce(cancel);
    expect(await init(dir)).toEqual({
      exitCode: 0,
      result: 'cancelled',
      yes: false,
      existingConfig: false,
      engine: 'mobile',
      gateway: 'none',
      skill: true,
      mcp: false,
      install: false,
    });

    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('openrouter');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(spawnSync).mockReturnValueOnce(spawnResult(1));
    expect(await init(dir)).toMatchObject({ exitCode: 2, result: 'install-failed', engine: 'web', gateway: 'openrouter', install: true });
  });

  it('hands back a run that could not start', async () => {
    expect(await init(dir, { interactive: false })).toMatchObject({ exitCode: 2, result: 'not-interactive' });
    writeFileSync(path.join(dir, 'package.json'), '{not json');
    expect(await init(dir, { yes: true })).toMatchObject({ exitCode: 2, result: 'invalid-project' });
  });

  it('keeps quiet about tsconfig.json when the project has one', async () => {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n');
    expect((await init(dir, { yes: true })).exitCode).toBe(0);
    expect(output()).not.toContain('tsconfig.json');
  });

  it.each([
    { engine: 'none', ai: false },
    { engine: 'none', ai: true },
    { engine: 'web', ai: false },
    { engine: 'web', ai: true },
    { engine: 'mobile', ai: false },
    { engine: 'mobile', ai: true },
  ] as const)('matches imports and dependencies to engine=$engine, ai=$ai', async ({ engine, ai }) => {
    vi.mocked(clack.select).mockResolvedValueOnce(engine).mockResolvedValueOnce(ai ? 'openrouter' : 'none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const manifest = JSON.parse(read('package.json'));
    const device = engine === 'mobile';
    expect(Object.keys(manifest.devDependencies)).toEqual([
      'e2e',
      ...(engine === 'web' ? ['@e2e-dev/web', 'playwright'] : []),
      ...(device ? ['@e2e-dev/mobile'] : []),
      ...(ai ? ['ai', '@openrouter/ai-sdk-provider'] : []),
    ]);
    expect(manifest.devDependencies.ai).toBe(ai ? '^7.0.0' : undefined);
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
    { host: 'win32', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
  ] as const)('defaults agent-device to $platform on $host', async ({ host, platform, app, label }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    vi.mocked(clack.select).mockResolvedValueOnce('mobile').mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.select).toHaveBeenCalledTimes(2);
    expect(clack.select).toHaveBeenCalledWith(expect.objectContaining({
      initialValue: 'web',
      options: [
        expect.objectContaining({ value: 'web', label: 'Web', hint: 'Playwright' }),
        expect.objectContaining({ value: 'mobile', label: 'Mobile (iOS/Android)', hint: 'agent-device' }),
        expect.objectContaining({ value: 'none', label: 'None' }),
      ],
    }));
    expect(read('e2e.config.ts')).toContain(`engine: mobile({ platform: '${platform}' }), app: { bundleId: '${app}' }`);
    expect(read('tests/example.e2e.ts')).toContain(label);
  });

  it('offers every gateway and none, and asks an OpenAI-compatible endpoint for its URL', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('openai-compatible');
    vi.mocked(clack.text).mockResolvedValueOnce(' http://127.0.0.1:11434/v1 ');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.select).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining('Which model gateway'),
      initialValue: 'vercel',
      options: [
        expect.objectContaining({ value: 'vercel', label: 'Vercel AI Gateway' }),
        expect.objectContaining({ value: 'openrouter', label: 'OpenRouter' }),
        expect.objectContaining({ value: 'openai-compatible', label: 'OpenAI-compatible endpoint' }),
        expect.objectContaining({ value: 'chatgpt', label: 'ChatGPT Plus/Pro subscription' }),
        expect.objectContaining({ value: 'copilot', label: 'GitHub Copilot subscription' }),
        expect.objectContaining({ value: 'grok', label: 'SuperGrok subscription' }),
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
    { gateway: 'chatgpt', provider: 'openai', line: "import { chatgpt } from 'e2e/oauth/chatgpt';", model: "model: chatgpt('gpt-6-luna'),", sdk: '@ai-sdk/openai' },
    { gateway: 'copilot', provider: 'github-copilot', line: "import { copilot } from 'e2e/oauth/copilot';", model: "model: copilot('claude-sonnet-5'),", sdk: '@ai-sdk/openai-compatible' },
    { gateway: 'grok', provider: 'spacexai', line: "import { grok } from 'e2e/oauth/grok';", model: "model: grok('grok-4'),", sdk: '@ai-sdk/xai' },
  ] as const)('writes a $gateway subscription model and names the sign-in as the next step', async ({ gateway, provider, line, model, sdk }) => {
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce(gateway);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.text).not.toHaveBeenCalled();
    expect(read('e2e.config.ts')).toContain(line);
    expect(read('e2e.config.ts')).toContain(model);
    expect(read('e2e.config.ts')).toContain(`sign in once with \`e2e login ${provider}\``);
    const devDependencies = JSON.parse(read('package.json')).devDependencies;
    expect(devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(devDependencies).toHaveProperty(sdk);
    expect(output()).toContain(`e2e login ${provider}, then`);
  });

  it('validates the endpoint the way config resolution will', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('openai-compatible');
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
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('vercel');
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
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('Next: npm install, then APP_URL=');
  });

  it.each(['engine', 'gateway', 'endpoint', 'skill', 'mcp', 'files', 'install'])('leaves the directory untouched when cancelling at %s', async (stage) => {
    const cancel: typeof clack.CANCEL_SYMBOL = clack.CANCEL_SYMBOL;
    vi.mocked(clack.select)
      .mockResolvedValueOnce(stage === 'engine' ? cancel : 'web')
      .mockResolvedValueOnce(stage === 'gateway' ? cancel : 'openai-compatible');
    vi.mocked(clack.text).mockResolvedValueOnce(stage === 'endpoint' ? cancel : 'http://127.0.0.1:11434/v1');
    vi.mocked(clack.multiselect)
      .mockResolvedValueOnce(stage === 'skill' ? cancel : ['.agents/skills'])
      .mockResolvedValueOnce(stage === 'mcp' ? cancel : ['.mcp.json']);
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
        dependencies: { 'e2e': 'workspace:*', '@e2e-dev/web': 'workspace:*', playwright: '1.59.0-alpha-2026-01-01', ai: '^7.0.12' },
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
    ['e2e runner --ci', 'npm exec e2e run'],
    ['vitest', 'npm exec e2e run'],
  ])('keeps an existing test:e2e script (%s) and points the run step at %s', async (script, step) => {
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'existing-app', scripts: { 'test:e2e': script } })}\n`);
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('none');
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
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    expect(JSON.parse(read('package.json'))).toEqual({
      ...manifest,
      scripts: { dev: 'vite', 'test:e2e': 'e2e run' },
      devDependencies: { ...manifest.devDependencies, 'e2e': expect.any(String), playwright: '^1' },
    });
    expect(read('package.json')).toContain('\r\n    "name"');
    const written = JSON.parse(read('package.json'));
    expect(Object.keys(written)).toEqual(Object.keys(manifest));
    expect(Object.keys(written.devDependencies)).toEqual(['@e2e-dev/web', 'e2e', 'playwright', 'vite']);
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

  it("keeps the app's own playwright and adds only the engine next to it", async () => {
    const manifest = {
      name: 'existing-app',
      dependencies: { playwright: '1.59.0-alpha-2026-01-01' },
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const written = JSON.parse(read('package.json'));
    expect(written.dependencies).toEqual(manifest.dependencies);
    expect(Object.keys(written.devDependencies)).toEqual(['e2e', '@e2e-dev/web']);
  });

  it.each([
    ['{broken', /package\.json could not be read: .*JSON/],
    ['null', /package\.json could not be read: .*/],
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
    expect(output()).toContain('pass --yes to accept the defaults (Playwright, the Vercel AI Gateway, no installation)');
  });

  it('scaffolds with --yes without a terminal', async () => {
    expect((await init(dir, { yes: true, interactive: false })).exitCode).toBe(0);
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
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
    vi.mocked(clack.select).mockResolvedValueOnce(Symbol('cancel'));
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

  it.each(['e2e.config.ts', 'e2e.config.mts'])('never overwrites an existing %s or assumes its optional packages', async (config) => {
    writeFileSync(path.join(dir, config), '// custom config\n');
    await init(dir, { yes: true });
    expect(read(config)).toBe('// custom config\n');
    expect(Object.keys(JSON.parse(read('package.json')).devDependencies)).toEqual(['e2e']);
    expect(JSON.parse(read('package.json')).scripts).toEqual({ 'test:e2e': 'e2e run' });
    if (config.endsWith('.mts')) expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(false);
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
    expect(read('.gitignore')).toBe(`${older}.e2e/ai-trace.json\n.e2e/junit.xml\n.e2e/summary.md\n.e2e/failures/\n.e2e/logs/\n.e2e/videos/\n`);
    expect(output()).not.toContain('commit-the-replay-cache');
  });

  it('installs the skill where selected, then refreshes only those copies', async () => {
    vi.mocked(clack.multiselect).mockResolvedValueOnce(['.claude/skills']);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
    expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      options: [expect.objectContaining({ value: '.agents/skills' }), expect.objectContaining({ value: '.claude/skills' })],
      initialValues: ['.agents/skills', '.claude/skills'],
      required: false,
    }));
    expect(clack.multiselect).toHaveBeenCalledWith(expect.objectContaining({
      options: [expect.objectContaining({ value: '.mcp.json' }), expect.objectContaining({ value: '.cursor/mcp.json' })],
      initialValues: ['.mcp.json', '.cursor/mcp.json'],
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
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
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
    vi.mocked(clack.multiselect).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await init(dir)).exitCode).toBe(0);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(false);
    expect(output()).toContain('npm exec e2e guide');
    expect(output()).toContain('claude mcp add e2e -- npx e2e mcp');
  });

  it('is idempotent', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('web').mockResolvedValueOnce('vercel');
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
});
