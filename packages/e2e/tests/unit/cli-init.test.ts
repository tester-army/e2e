import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { init } from '../../src/cli/init.ts';
import { readSkillFiles } from '../../src/cli/skill.ts';

vi.mock('@clack/prompts', { spy: true });
vi.mock('../../src/cli/skill.ts', { spy: true });
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

let dir: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Captures user-facing output without ANSI formatting. */
function output(): string {
  return stdoutSpy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join('');
}

/** Reads one file from the throwaway project. */
function read(file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
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
    expect(await init(dir, { yes: true })).toBe(0);
    expect(JSON.parse(read('package.json'))).toEqual({
      private: true,
      type: 'module',
      devDependencies: { '@e2edev/e2e': expect.stringMatching(/^\^\d+\.\d+\.\d+/), '@e2edev/playwright': '0.x', playwright: '^1', ai: '^7.0.0' },
      scripts: { 'test:e2e': 'e2e run' },
    });
    expect(read('e2e.config.ts')).toContain('agents: {\n    default: createAgent({');
    // The default gateway is written out as its own provider's constructor, never implied by the runner.
    expect(read('e2e.config.ts')).toContain("import { gateway } from 'ai';");
    expect(read('e2e.config.ts')).toContain("model: gateway('openai/gpt-5.6-luna'),");
    expect(read('e2e.config.ts')).toContain('// The Vercel AI Gateway serves the model id and reads AI_GATEWAY_API_KEY.');
    expect(read('e2e.config.ts')).toContain("// Any AI SDK model works here: openai('gpt-5.6-luna') from @ai-sdk/openai calls the provider directly.");
    expect(read('tests/example.e2e.ts')).toContain('// Runs once the key the model in e2e.config.ts reads is in the environment:');
    expect(read('e2e.config.ts')).toContain("playwright({\n      url: process.env.APP_URL ?? 'http://localhost:3000',");
    expect(read('e2e.config.ts')).toContain('// command: {');
    expect(read('tests/example.e2e.ts')).toContain("test('app opens'");
    expect(read('tests/example.e2e.ts')).toContain("await app.open('/');");
    expect(read('tests/example.e2e.ts')).toContain("await expect(web.locator('body')).toBeVisible();");
    expect(read('tests/example.e2e.ts')).toContain('// test(');
    expect(read('tests/example.e2e.ts')).not.toContain('fetch(');
    expect(JSON.parse(read('.mcp.json'))).toEqual({ mcpServers: { e2e: { command: 'npx', args: ['--no-install', 'e2e', 'mcp'] } } });
    expect(JSON.parse(read('.cursor/mcp.json'))).toEqual({ mcpServers: { e2e: { command: 'npx', args: ['--no-install', 'e2e', 'mcp'] } } });
    expect(read('.gitignore')).toContain('node_modules/');
    expect(read('.gitignore')).toContain('.e2e/junit.xml');
    expect(read('.gitignore')).toContain('.e2e/cache/');
    expect(output()).toContain('.e2e/cache/ is ignored; committing agent.act replays is opt-in, see https://e2e.mintlify.app/cache#commit-your-traces');
    expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(read('.claude/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('add scripts: test:e2e (e2e run)');
    expect(output()).toContain('no tsconfig.json');
    expect(output()).toContain('next: npm install, then APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('keeps quiet about tsconfig.json when the project has one', async () => {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n');
    expect(await init(dir, { yes: true })).toBe(0);
    expect(output()).not.toContain('tsconfig.json');
  });

  it.each([
    { engine: 'none', ai: false },
    { engine: 'none', ai: true },
    { engine: 'playwright', ai: false },
    { engine: 'playwright', ai: true },
    { engine: 'agent-device', ai: false },
    { engine: 'agent-device', ai: true },
  ] as const)('matches imports and dependencies to engine=$engine, ai=$ai', async ({ engine, ai }) => {
    vi.mocked(clack.select).mockResolvedValueOnce(engine).mockResolvedValueOnce(ai ? 'openrouter' : 'none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const manifest = JSON.parse(read('package.json'));
    const device = engine === 'agent-device';
    expect(Object.keys(manifest.devDependencies)).toEqual([
      '@e2edev/e2e',
      ...(engine === 'playwright' ? ['@e2edev/playwright', 'playwright'] : []),
      ...(device ? ['@e2edev/agent-device'] : []),
      ...(ai ? ['ai', '@openrouter/ai-sdk-provider'] : []),
    ]);
    expect(manifest.devDependencies.ai).toBe(ai ? '^7.0.0' : undefined);
    expect(manifest.devDependencies['@openrouter/ai-sdk-provider']).toBe(ai ? '^3.0.0' : undefined);
    expect(read('e2e.config.ts').includes('createAgent')).toBe(ai);
    expect(read('e2e.config.ts').includes("import { openrouter } from '@openrouter/ai-sdk-provider';")).toBe(ai);
    expect(read('e2e.config.ts').includes("model: openrouter('openai/gpt-5.6-luna'),")).toBe(ai);
    expect(read('e2e.config.ts').includes('// OpenRouter serves the model id and reads OPENROUTER_API_KEY.')).toBe(ai);
    expect(clack.text).not.toHaveBeenCalled();
    expect(read('e2e.config.ts').includes('@e2edev/playwright')).toBe(engine === 'playwright');
    expect(read('tests/example.e2e.ts').includes('@e2edev/playwright')).toBe(engine === 'playwright');
    expect(read('e2e.config.ts').includes('@e2edev/agent-device')).toBe(device);
    expect(read('tests/example.e2e.ts').includes('@e2edev/agent-device')).toBe(device);
    expect(read('e2e.config.ts').includes('APP_URL')).toBe(engine === 'playwright');
    expect(output()).toContain(`next: npm install, then ${device ? '' : 'APP_URL=http://localhost:3000 '}npm run test:e2e`);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    { host: 'darwin', platform: 'ios', app: 'Settings', label: 'General' },
    { host: 'linux', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
    { host: 'win32', platform: 'android', app: 'com.android.settings', label: 'Network & internet' },
  ] as const)('defaults agent-device to $platform on $host', async ({ host, platform, app, label }) => {
    vi.spyOn(os, 'platform').mockReturnValue(host);
    vi.mocked(clack.select).mockResolvedValueOnce('agent-device').mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await init(dir)).toBe(0);
    expect(clack.select).toHaveBeenCalledTimes(2);
    expect(clack.select).toHaveBeenCalledWith(expect.objectContaining({
      initialValue: 'playwright',
      options: [
        expect.objectContaining({ value: 'playwright', label: 'Web', hint: 'Playwright' }),
        expect.objectContaining({ value: 'agent-device', label: 'Mobile (iOS/Android)', hint: 'agent-device' }),
        expect.objectContaining({ value: 'none', label: 'None' }),
      ],
    }));
    expect(read('e2e.config.ts')).toContain(`agentDevice({ platform: '${platform}', app: '${app}' })`);
    expect(read('tests/example.e2e.ts')).toContain(label);
  });

  it('offers every gateway and none, and asks an OpenAI-compatible endpoint for its URL', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('openai-compatible');
    vi.mocked(clack.text).mockResolvedValueOnce(' http://127.0.0.1:11434/v1 ');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await init(dir)).toBe(0);
    expect(clack.select).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.stringContaining('Which model gateway'),
      initialValue: 'vercel',
      options: [
        expect.objectContaining({ value: 'vercel', label: 'Vercel AI Gateway' }),
        expect.objectContaining({ value: 'openrouter', label: 'OpenRouter' }),
        expect.objectContaining({ value: 'openai-compatible', label: 'OpenAI-compatible endpoint' }),
        expect.objectContaining({ value: 'none' }),
      ],
    }));
    expect(clack.text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ placeholder: 'http://127.0.0.1:11434/v1' }));
    expect(read('e2e.config.ts')).toContain("import { createOpenAICompatible } from '@ai-sdk/openai-compatible';");
    expect(read('e2e.config.ts')).toContain(
      "      model: createOpenAICompatible({\n        name: 'openai-compatible',\n        baseURL: 'http://127.0.0.1:11434/v1',\n        // apiKey: process.env.LLM_API_KEY,\n      }).chatModel('gpt-5.6-luna'),",
    );
    expect(read('e2e.config.ts')).toContain('// The endpoint serves the model id over the OpenAI chat API; pass apiKey when it needs one.');
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('@ai-sdk/openai-compatible', '^3.0.0');
  });

  it('validates the endpoint the way config resolution will', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('openai-compatible');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
    const { validate } = vi.mocked(clack.text).mock.calls[0]![0] as { validate: (value: string | undefined) => string | undefined };
    expect(validate(undefined)).toContain('enter the base URL');
    expect(validate('   ')).toContain('enter the base URL');
    expect(validate('not a url')).toContain('not a URL');
    expect(validate('http://llm.example/v1')).toContain('HTTPS');
    expect(validate('http://localhost:11434/v1')).toBeUndefined();
    expect(validate('https://llm.example/v1')).toBeUndefined();
  });

  it('accepts interactive selections and installs once after writing all files', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
      expect(read('e2e.config.ts')).toContain('createAgent');
      expect(existsSync(path.join(dir, 'tests/example.e2e.ts'))).toBe(true);
      return spawnResult(0);
    });

    expect(await init(dir)).toBe(0);
    expect(clack.select).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('AI SDK v7'), initialValue: 'vercel' }));
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'Install dependencies with npm?' }));
    expect(spawnSync).toHaveBeenCalledExactlyOnceWith('npm', ['install'], {
      cwd: dir, stdio: 'inherit', shell: process.platform === 'win32',
    });
    expect(output()).toContain('next: APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('writes the selected dependencies when installation is declined', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
    expect(JSON.parse(read('package.json')).devDependencies).toHaveProperty('ai', '^7.0.0');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toContain('next: npm install, then APP_URL=');
  });

  it.each(['engine', 'gateway', 'endpoint', 'skill', 'mcp', 'files', 'install'])('leaves the directory untouched when cancelling at %s', async (stage) => {
    const cancel = Symbol('cancel');
    vi.mocked(clack.select)
      .mockResolvedValueOnce(stage === 'engine' ? cancel : 'playwright')
      .mockResolvedValueOnce(stage === 'gateway' ? cancel : 'openai-compatible');
    vi.mocked(clack.text).mockResolvedValueOnce(stage === 'endpoint' ? cancel : 'http://127.0.0.1:11434/v1');
    vi.mocked(clack.multiselect)
      .mockResolvedValueOnce(stage === 'skill' ? cancel : ['.agents/skills'])
      .mockResolvedValueOnce(stage === 'mcp' ? cancel : ['.mcp.json']);
    vi.mocked(clack.confirm)
      .mockResolvedValueOnce(stage !== 'files')
      .mockResolvedValueOnce(cancel);

    expect(await init(dir)).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([undefined, 'commonjs', 'module'])(
    'preserves existing dependency versions and type %s',
    async (type) => {
      const manifest = `${JSON.stringify({
        name: 'existing-app', type, scripts: { 'test:e2e': 'e2e run --workers 1' },
        dependencies: { '@e2edev/e2e': 'workspace:*', '@e2edev/playwright': 'workspace:*', playwright: '1.59.0-alpha-2026-01-01', ai: '^7.0.12' },
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
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
    expect(JSON.parse(read('package.json')).scripts).toEqual({ 'test:e2e': script });
    expect(output()).toContain(`next: npm install, then APP_URL=http://localhost:3000 ${step}`);
  });

  it('adds missing dependencies without changing existing fields, ranges, or formatting', async () => {
    const manifest = {
      name: 'existing-app', type: 'commonjs', scripts: { dev: 'vite' },
      dependencies: { ai: '^7.0.12' },
      devDependencies: { '@e2edev/playwright': 'file:../engine', vite: '^7.0.0' },
      custom: { enabled: true },
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 4).replaceAll('\n', '\r\n')}\r\n`);
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    expect(JSON.parse(read('package.json'))).toEqual({
      ...manifest,
      scripts: { dev: 'vite', 'test:e2e': 'e2e run' },
      devDependencies: { ...manifest.devDependencies, '@e2edev/e2e': expect.any(String), playwright: '^1' },
    });
    expect(read('package.json')).toContain('\r\n    "name"');
  });

  it("keeps the app's own playwright and adds only the engine next to it", async () => {
    const manifest = {
      name: 'existing-app',
      dependencies: { playwright: '1.59.0-alpha-2026-01-01' },
    };
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('none');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const written = JSON.parse(read('package.json'));
    expect(written.dependencies).toEqual(manifest.dependencies);
    expect(Object.keys(written.devDependencies)).toEqual(['@e2edev/e2e', '@e2edev/playwright']);
  });

  it.each([
    ['{broken', /package\.json could not be read: .*JSON/],
    ['null', /package\.json could not be read: .*/],
    ['{"devDependencies":false}', /package\.json could not be read: devDependencies: /],
  ])('rejects invalid package.json before writing and says what is wrong (%s)', async (manifest, reason) => {
    writeFileSync(path.join(dir, 'package.json'), manifest);
    expect(await init(dir, { yes: true })).toBe(2);
    expect(read('package.json')).toBe(manifest);
    expect(readdirSync(dir)).toEqual(['package.json']);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output()).toMatch(reason);
    expect(output()).toContain('fix it before running e2e init');
  });

  it('refuses to prompt without a terminal and names --yes', async () => {
    expect(await init(dir, { interactive: false })).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(output()).toContain('needs an interactive terminal');
    expect(output()).toContain('pass --yes to accept the defaults (Playwright, the Vercel AI Gateway, no installation)');
  });

  it('scaffolds with --yes without a terminal', async () => {
    expect(await init(dir, { yes: true, interactive: false })).toBe(0);
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
  });

  it('creates a named directory and starts the next steps with cd into it', async () => {
    const target = path.join(dir, 'apps', 'web');
    expect(await init(target, { yes: true, directory: 'apps/web' })).toBe(0);
    expect(existsSync(path.join(target, 'e2e.config.ts'))).toBe(true);
    expect(existsSync(path.join(target, 'tests', 'example.e2e.ts'))).toBe(true);
    expect(output()).toContain('e2e init apps/web');
    expect(output()).toContain('next: cd apps/web, then npm install, then APP_URL=http://localhost:3000 npm run test:e2e');
  });

  it('quotes a directory the shell would otherwise split, for the platform it runs on', async () => {
    expect(await init(path.join(dir, 'apps', 'my web'), { yes: true, directory: 'apps/my web' })).toBe(0);
    expect(output()).toContain("next: cd 'apps/my web', then npm install, then");
    expect(existsSync(path.join(dir, 'apps', 'my web', 'e2e.config.ts'))).toBe(true);

    stdoutSpy.mockClear();
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    expect(await init(path.join(dir, 'my app'), { yes: true, directory: 'my app' })).toBe(0);
    expect(output()).toContain('next: cd "my app", then npm install, then');
  });

  it('does not create the directory when cancelling', async () => {
    const target = path.join(dir, 'later');
    vi.mocked(clack.select).mockResolvedValueOnce(Symbol('cancel'));
    expect(await init(target, { directory: 'later' })).toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it('stays quiet about placement inside a workspace member directory', async () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/e2e-tests'\n");
    expect(await init(path.join(dir, 'apps', 'web'), { yes: true, directory: 'apps/web' })).toBe(0);
    expect(output()).not.toContain('outside the workspace');
    expect(output()).not.toContain('workspace root');

    stdoutSpy.mockClear();
    rmSync(path.join(dir, 'pnpm-workspace.yaml'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: { packages: ['apps/*'] } }));
    expect(await init(path.join(dir, 'apps', 'admin'), { yes: true, directory: 'apps/admin' })).toBe(0);
    expect(output()).not.toContain('outside the workspace');
  });

  it('warns with the root and its globs when the new directory falls outside the workspace', async () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/e2e-tests'\n");
    expect(await init(path.join(dir, 'packages', 'e2e-tests'), { yes: true, directory: 'packages/e2e-tests' })).toBe(0);
    expect(output()).toContain(
      `packages/e2e-tests is outside the workspace at ${dir} (pnpm-workspace.yaml lists packages: apps/*, packages/*, !packages/e2e-tests); an install here will not share its lockfile. Add a matching entry to pnpm-workspace.yaml, or run e2e init inside the app's package`,
    );
    expect(existsSync(path.join(dir, 'packages', 'e2e-tests', 'e2e.config.ts'))).toBe(true);

    stdoutSpy.mockClear();
    rmSync(path.join(dir, 'pnpm-workspace.yaml'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'repo', private: true, workspaces: ['apps/*'] }));
    expect(await init(path.join(dir, 'tools', 'e2e'), { yes: true, directory: 'tools/e2e' })).toBe(0);
    expect(output()).toContain(`tools/e2e is outside the workspace at ${dir} (package.json lists packages: apps/*)`);
  });

  it('judges a directory that is already its own install root by the workspace enclosing it', async () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!packages/e2e-tests'\n");
    const target = path.join(dir, 'packages', 'e2e-tests');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(await init(target, { yes: true, directory: 'packages/e2e-tests' })).toBe(0);
    expect(output()).toContain(`packages/e2e-tests is outside the workspace at ${dir} (pnpm-workspace.yaml lists packages: apps/*, packages/*, !packages/e2e-tests)`);
    expect(output()).not.toContain('workspace root');
  });

  it('points at the app package when run at the workspace root', async () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    expect(await init(dir, { yes: true })).toBe(0);
    expect(output()).toContain("this is the workspace root (pnpm-workspace.yaml); the suite usually lives in the app's package, e.g. e2e init apps/<app>");
    expect(output()).not.toContain('outside the workspace');
  });

  it('rejects a directory argument that names a file', async () => {
    writeFileSync(path.join(dir, 'notes.txt'), '');
    expect(await init(path.join(dir, 'notes.txt'), { yes: true, directory: 'notes.txt' })).toBe(2);
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
    expect(await init(dir)).toBe(2);
    expect(existsSync(path.join(dir, 'e2e.config.ts'))).toBe(true);
    expect(output()).toContain('retry with npm install');
  });

  it.each(['e2e.config.ts', 'e2e.config.mts'])('never overwrites an existing %s or assumes its optional packages', async (config) => {
    writeFileSync(path.join(dir, config), '// custom config\n');
    await init(dir, { yes: true });
    expect(read(config)).toBe('// custom config\n');
    expect(Object.keys(JSON.parse(read('package.json')).devDependencies)).toEqual(['@e2edev/e2e']);
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
    expect(read('.gitignore')).toBe(`${older}.e2e/ai-trace.json\n.e2e/junit.xml\n.e2e/logs/\n`);
    expect(output()).not.toContain('commit-your-traces');
  });

  it('installs the skill where selected, then refreshes only those copies', async () => {
    vi.mocked(clack.multiselect).mockResolvedValueOnce(['.claude/skills']);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
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
    expect(clack.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('create .claude/skills/e2e/') }));
    expect(existsSync(path.join(dir, '.agents/skills'))).toBe(false);
    expect(output()).toContain('created .claude/skills/e2e/');
    const reference = path.join(dir, '.claude/skills/e2e/references/setup.md');
    const shipped = read('.claude/skills/e2e/references/setup.md');

    writeFileSync(reference, 'stale\n');
    stdoutSpy.mockClear();
    expect(await init(dir, { yes: true })).toBe(0);
    expect(read('.claude/skills/e2e/references/setup.md')).toBe(shipped);
    expect(existsSync(path.join(dir, '.agents/skills'))).toBe(false);
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
    expect(output()).toContain('updated .claude/skills/e2e/');
  });

  it('repairs a damaged copy without asking and leaves other locations alone', async () => {
    mkdirSync(path.join(dir, '.agents/skills/e2e/references'), { recursive: true });
    writeFileSync(path.join(dir, '.agents/skills/e2e/references/setup.md'), 'stale\n');
    expect(await init(dir, { yes: true })).toBe(0);
    expect(read('.agents/skills/e2e/SKILL.md')).toMatch(/^---\nname: e2e\n/);
    expect(read('.agents/skills/e2e/references/setup.md')).toContain('# Setting up e2e');
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(output()).toContain('updated .agents/skills/e2e/');
  });

  it('fails before any prompt or write when the package lacks its skill files', async () => {
    vi.mocked(readSkillFiles).mockReturnValueOnce([]);
    expect(await init(dir)).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).not.toHaveBeenCalled();
    expect(output()).toContain('reinstall @e2edev/e2e');
  });

  it('offers the skill to an initialized project and points at e2e guide when declined', async () => {
    writeFileSync(path.join(dir, 'e2e.config.ts'), '// custom config\n');
    vi.mocked(clack.multiselect).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await init(dir)).toBe(0);
    expect(clack.select).not.toHaveBeenCalled();
    expect(clack.multiselect).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(dir, '.agents'))).toBe(false);
    expect(existsSync(path.join(dir, '.claude'))).toBe(false);
    expect(existsSync(path.join(dir, '.mcp.json'))).toBe(false);
    expect(output()).toContain('npm exec e2e guide');
    expect(output()).toContain('claude mcp add e2e -- npx --no-install e2e mcp');
  });

  it('is idempotent', async () => {
    vi.mocked(clack.select).mockResolvedValueOnce('playwright').mockResolvedValueOnce('vercel');
    vi.mocked(clack.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await init(dir);
    const files = ['package.json', 'e2e.config.ts', 'tests/example.e2e.ts', '.gitignore', '.agents/skills/e2e/SKILL.md'];
    const before = files.map(read);
    stdoutSpy.mockClear();
    await init(dir, { yes: true });
    expect(files.map(read)).toEqual(before);
    expect(output()).toContain('nothing to create; project already initialized');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('preserves existing ignores and appends only missing entries', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\r\n.e2e/artifacts/');
    await init(dir, { yes: true });
    expect(read('.gitignore').startsWith('node_modules/\r\n.e2e/artifacts/\n')).toBe(true);
    expect(read('.gitignore').match(/\.e2e\/artifacts\//g)).toHaveLength(1);
    expect(read('.gitignore')).toContain('.e2e/sessions/');
  });
});
