import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  configStartsApp,
  configUsesLocalModel,
  findNodeVersionFile,
  findRepositoryRoot,
  gatewaysInConfig,
  detectCiService,
  getCiService,
  readNodeMajor,
  renderGithubWorkflow,
  renderGitlabPipeline,
  type WorkflowContext,
} from '../../src/cli/init/ci.ts';

const base: WorkflowContext = { manager: 'npm', projectDir: '', installDir: '', secrets: [] };

/** One step or job of a rendered pipeline, as YAML reads it. */
type Node = Record<string, unknown>;

/** A rendered GitHub workflow's job and its steps. */
function githubJob(text: string): { job: Node; steps: Node[]; step: (name: string) => Node; uses: (action: string) => Node | undefined } {
  const job = (parse(text) as { jobs: { e2e: Node } }).jobs.e2e;
  const steps = job['steps'] as Node[];
  return {
    job,
    steps,
    step: (name) => steps.find((step) => step['name'] === name)!,
    uses: (action) => steps.find((step) => String(step['uses']).startsWith(`${action}@`)),
  };
}

/** The templates as shipped, read the way init reads them. */
const templates = path.resolve(import.meta.dirname, '../../templates/ci');

describe('renderGithubWorkflow', () => {
  it('writes the template unchanged for npm at the repository root, the model key read from secrets', () => {
    expect(renderGithubWorkflow({ ...base, secrets: ['AI_GATEWAY_API_KEY'] })).toBe(readFileSync(path.join(templates, 'github-actions.yml'), 'utf8'));
  });

  it('keeps the template comments and pinned tags', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'pnpm', pnpmVersion: '10' });
    expect(workflow).toMatch(/^# Written by `e2e init --ci github-actions`/u);
    expect(workflow).toContain('    branches: [main]\n');
    expect(workflow).toMatch(/uses: pnpm\/action-setup@[0-9a-f]{40} # v\d/u);
  });

  it('sets no env block when the run reads no key', () => {
    expect(githubJob(renderGithubWorkflow(base)).step('Run e2e')).not.toHaveProperty('env');
  });

  it('runs a workspace member from its folder and installs at the workspace root', () => {
    const { job, step, uses } = githubJob(renderGithubWorkflow({ ...base, manager: 'pnpm', projectDir: 'apps/web', installDir: '', pnpmVersion: '10' }));
    expect(job['defaults']).toEqual({ run: { 'working-directory': 'apps/web' } });
    expect(Object.keys(job)).toEqual(['runs-on', 'timeout-minutes', 'defaults', 'steps']);
    expect(uses('pnpm/action-setup')?.['with']).toEqual({ version: '10' });
    expect(step('Install dependencies')).toEqual({ name: 'Install dependencies', run: 'pnpm install --frozen-lockfile', 'working-directory': '.' });
    expect(uses('actions/cache')?.['with']).toMatchObject({ key: "playwright-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}" });
    expect(step('Run e2e')['run']).toBe('pnpm exec e2e run --reporter list,junit');
    expect((step('Upload the report')['with'] as Node)['path']).toBe('apps/web/.e2e/report.json\napps/web/.e2e/junit.xml\napps/web/.e2e/results\n');
  });

  it('points the cache at a lockfile below the root, and pnpm at the package.json with its packageManager field', () => {
    const below = githubJob(renderGithubWorkflow({ ...base, manager: 'pnpm', projectDir: 'e2e', installDir: 'e2e', nodeVersionFile: '.nvmrc' }));
    expect(below.uses('pnpm/action-setup')?.['with']).toEqual({ package_json_file: 'e2e/package.json' });
    expect(below.uses('actions/setup-node')?.['with']).toEqual({ 'node-version-file': '.nvmrc', cache: 'pnpm', 'cache-dependency-path': 'e2e/pnpm-lock.yaml' });
    expect(below.step('Install dependencies')).not.toHaveProperty('working-directory');
    expect(githubJob(renderGithubWorkflow({ ...base, manager: 'pnpm' })).uses('pnpm/action-setup')).not.toHaveProperty('with');
  });

  it.each([
    { yarnBerry: false, install: 'yarn install --frozen-lockfile' },
    { yarnBerry: true, install: 'yarn install --immutable' },
  ])('enables corepack before setup-node for Yarn and installs with $install', ({ yarnBerry, install }) => {
    const { steps, step } = githubJob(renderGithubWorkflow({ ...base, manager: 'yarn', yarnBerry }));
    expect(steps.findIndex((item) => item['run'] === 'corepack enable')).toBe(steps.findIndex((item) => String(item['uses']).startsWith('actions/setup-node@')) - 1);
    expect(step('Install dependencies')['run']).toBe(install);
    expect(step('Run e2e')['run']).toBe('yarn e2e run --reporter list,junit');
  });

  it('sets up Bun and keeps setup-node for the runner without a cache', () => {
    const { step, uses } = githubJob(renderGithubWorkflow({ ...base, manager: 'bun' }));
    expect(uses('oven-sh/setup-bun')).toBeDefined();
    expect(uses('actions/setup-node')?.['with']).toEqual({ 'node-version': 24 });
    expect(step('Install dependencies')['run']).toBe('bun install --frozen-lockfile');
    expect(uses('actions/cache')?.['with']).toMatchObject({ key: expect.stringContaining("hashFiles('bun.lock')") });
    expect(step('Run e2e')['run']).toBe('bunx e2e run --reporter list,junit');
  });

  it('runs only the web target when a mobile target shares the config', () => {
    expect(githubJob(renderGithubWorkflow({ ...base, target: 'web' })).step('Run e2e')['run']).toBe('npx e2e run --target web --reporter list,junit');
  });

  it('keeps a folder name with a space as one value', () => {
    expect(githubJob(renderGithubWorkflow({ ...base, projectDir: 'my app', installDir: 'my app' })).job['defaults']).toEqual({ run: { 'working-directory': 'my app' } });
  });
});

/** A rendered GitLab pipeline's one job. */
function gitlabJob(text: string, name = 'e2e'): Node {
  return (parse(text) as Record<string, Node>)[name]!;
}

describe('renderGitlabPipeline', () => {
  it('writes the template unchanged for npm at the repository root, with no key in the file', () => {
    // CI/CD variables reach the job's environment on their own; the file names no key.
    expect(renderGitlabPipeline({ ...base, secrets: ['AI_GATEWAY_API_KEY'] })).toBe(readFileSync(path.join(templates, 'gitlab-ci.yml'), 'utf8'));
  });

  it('installs at the workspace root and runs in the project folder', () => {
    const job = gitlabJob(renderGitlabPipeline({ ...base, manager: 'pnpm', projectDir: 'apps/web', installDir: '', pnpmVersion: '10', nodeMajor: '26' }));
    expect(job['image']).toBe('node:26');
    expect(job['script']).toEqual([
      'npm install --global pnpm@10',
      'pnpm config set store-dir .pnpm-store',
      'pnpm install --frozen-lockfile',
      'cd "$CI_PROJECT_DIR/apps/web"',
      'pnpm exec e2e-web install chromium --with-deps',
      'pnpm exec e2e run --reporter list,junit',
    ]);
    expect(job['cache']).toEqual({ key: { files: ['pnpm-lock.yaml'] }, paths: ['.cache/ms-playwright/', '.pnpm-store/'] });
    expect(job['artifacts']).toMatchObject({
      paths: ['apps/web/.e2e/report.json', 'apps/web/.e2e/junit.xml', 'apps/web/.e2e/results/'],
      reports: { junit: 'apps/web/.e2e/junit.xml' },
    });
    expect(job['variables']).not.toHaveProperty('COREPACK_ENABLE_DOWNLOAD_PROMPT');
  });

  it('changes into a project below the root before the install, and lets corepack read packageManager', () => {
    const job = gitlabJob(renderGitlabPipeline({ ...base, manager: 'pnpm', projectDir: 'site', installDir: 'site' }));
    expect(job['variables']).toMatchObject({ COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
    // Node 25 and later ship no corepack.
    expect((job['script'] as string[]).slice(0, 3)).toEqual(['cd "$CI_PROJECT_DIR/site"', 'command -v corepack || npm install --global corepack', 'corepack enable']);
    expect(job['cache']).toEqual({ key: { files: ['site/pnpm-lock.yaml'] }, paths: ['.cache/ms-playwright/', 'site/.pnpm-store/'] });
  });

  it.each([
    // The node:26 image has no Yarn 1, and Node 25 and later no corepack.
    { yarnBerry: false, install: ['command -v yarn || npm install --global yarn', 'yarn install --frozen-lockfile --cache-folder .yarn-cache'], store: ['.yarn-cache/'] },
    { yarnBerry: true, install: ['command -v corepack || npm install --global corepack', 'corepack enable', 'yarn install --immutable'], store: [] },
  ])('installs Yarn dependencies with $install', ({ yarnBerry, install, store }) => {
    const job = gitlabJob(renderGitlabPipeline({ ...base, manager: 'yarn', yarnBerry }));
    expect((job['script'] as string[]).slice(0, install.length)).toEqual(install);
    expect((job['cache'] as Node)['paths']).toEqual(['.cache/ms-playwright/', ...store]);
  });

  it('installs Bun into the node image and runs only the web target beside a mobile one', () => {
    const job = gitlabJob(renderGitlabPipeline({ ...base, manager: 'bun', target: 'web' }));
    expect((job['script'] as string[]).slice(0, 2)).toEqual(['npm install --global bun', 'bun install --frozen-lockfile']);
    expect((job['script'] as string[]).at(-1)).toBe('bunx e2e run --target web --reporter list,junit');
    expect((job['cache'] as Node)['paths']).toEqual(['.cache/ms-playwright/']);
  });

  it('renames the job and keeps the template comments', () => {
    const pipeline = renderGitlabPipeline({ ...base, jobName: 'e2e-run' });
    expect(pipeline).toMatch(/^# Written by `e2e init --ci gitlab`/u);
    expect(pipeline).toContain('    # GitLab caches only paths inside the project.\n');
    expect(Object.keys(parse(pipeline) as object)).toEqual(['e2e-run']);
  });
});

describe('the pinned actions', () => {
  const repository = path.resolve(import.meta.dirname, '../../../..');

  /** Every Markdown page under `dir`, recursively, leaving out installed packages. */
  function pages(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : pages(absolute);
      return entry.isFile() && /\.mdx?$/u.test(entry.name) ? [absolute] : [];
    });
  }

  /** Every `uses: owner/action@<sha> # <tag>` in `text`, as [action, pin]. */
  function pinsIn(text: string): [string, string][] {
    return [...text.matchAll(/uses: ([\w.-]+\/[\w.-]+)@(\S+ # \S+)/gu)].map(([, action, ref]) => [action!, `${action!}@${ref!}`]);
  }

  it('match the pins in the docs and the e2e skill, so a user copying either gets what init writes', () => {
    const pins = new Map(readdirSync(templates).flatMap((file) => pinsIn(readFileSync(path.join(templates, file), 'utf8'))));
    expect([...pins.keys()]).toEqual(expect.arrayContaining(['actions/checkout', 'actions/setup-node', 'pnpm/action-setup', 'oven-sh/setup-bun']));
    const mismatches = [...pages(path.join(repository, 'docs')), ...pages(path.join(repository, 'skills/e2e'))].flatMap((file) =>
      pinsIn(readFileSync(file, 'utf8'))
        .filter(([action, pin]) => pins.has(action) && pins.get(action) !== pin)
        .map(([, pin]) => `${path.relative(repository, file)}: ${pin}`));
    expect(mismatches).toEqual([]);
  });
});

describe('project detection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-ci-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the repository above the project, or falls back to the init directory', () => {
    const project = path.join(dir, 'apps', 'web');
    mkdirSync(project, { recursive: true });
    expect(findRepositoryRoot(project, project)).toBe(project);
    mkdirSync(path.join(dir, '.git'));
    expect(findRepositoryRoot(project, project)).toBe(dir);
    // A worktree or submodule has a .git file.
    writeFileSync(path.join(dir, 'apps', '.git'), 'gitdir: elsewhere\n');
    expect(findRepositoryRoot(project, project)).toBe(path.join(dir, 'apps'));
  });

  it('tells GitHub from GitLab by the remote, a .github folder, or a .gitlab-ci.yml', () => {
    mkdirSync(path.join(dir, '.git'));
    expect(detectCiService(dir)).toBeUndefined();
    writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:acme/app.git\n');
    expect(detectCiService(dir)).toBe('gitlab');
    writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
    expect(detectCiService(dir)).toBe('github-actions');
    rmSync(path.join(dir, '.git'), { recursive: true });
    mkdirSync(path.join(dir, '.github'));
    expect(detectCiService(dir)).toBe('github-actions');
    // A GitLab pipeline file wins over a .github folder that holds only templates.
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'build:\n  script: [make]\n');
    expect(detectCiService(dir)).toBe('gitlab');
  });

  it('writes .gitlab-ci.yml, or a file beside an existing one, and counts a pipeline that runs e2e as set up', () => {
    const gitlab = getCiService('gitlab');
    expect(gitlab.locate(dir)).toEqual({ file: '.gitlab-ci.yml', existing: false });
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'build:\n  script: [make]\n');
    expect(gitlab.locate(dir)).toEqual({
      file: '.gitlab/e2e.gitlab-ci.yml',
      existing: false,
      include: 'include:\n  - local: .gitlab/e2e.gitlab-ci.yml',
    });
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'e2e:\n  script: [npx e2e run]\n');
    expect(gitlab.locate(dir)).toEqual({ file: '.gitlab-ci.yml', existing: true });
  });

  it('says when an existing pipeline lists stages without test, where the included job runs', () => {
    const gitlab = getCiService('gitlab');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages: [build, deploy]\nbuild:\n  script: [make]\n');
    expect(gitlab.locate(dir).note).toBe('The e2e job runs in the test stage; add test to the stages in .gitlab-ci.yml');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages:\n  - build\n  - test\nbuild:\n  script: [make]\n');
    expect(gitlab.locate(dir).note).toBeUndefined();
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'build:\n  script: [make]\n');
    expect(gitlab.locate(dir).note).toBeUndefined();
    // A stage whose name only contains test is another stage.
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages: [build, unit-test]\n');
    expect(gitlab.locate(dir).note).toBe('The e2e job runs in the test stage; add test to the stages in .gitlab-ci.yml');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), "stages:\n  - 'build'\n  - \"test\" # unit and e2e\nvariables: {}\n");
    expect(gitlab.locate(dir).note).toBeUndefined();
  });

  it('names the job e2e-run beside a pipeline that already has a job named e2e', () => {
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'e2e:\n  script: [npx cypress run]\n');
    expect(getCiService('gitlab').locate(dir)).toMatchObject({ file: '.gitlab/e2e.gitlab-ci.yml', jobName: 'e2e-run' });
  });

  it('counts any GitHub workflow that runs e2e as set up', () => {
    const github = getCiService('github-actions');
    expect(github.locate(dir)).toEqual({ file: '.github/workflows/e2e.yml', existing: false });
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(path.join(dir, '.github', 'workflows', 'lint.yml'), 'jobs: {}\n');
    expect(github.locate(dir).existing).toBe(false);
    writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yaml'), 'jobs:\n  test:\n    steps:\n      - run: npx e2e run\n');
    expect(github.locate(dir)).toEqual({ file: '.github/workflows/ci.yaml', existing: true });
  });

  it.each([
    ['24\n', '24'],
    ['v24.8.0', '24'],
    ['26.1', '26'],
    ['lts/*', undefined],
  ])('reads the Node major from %j', (content, major) => {
    writeFileSync(path.join(dir, '.nvmrc'), content);
    expect(readNodeMajor(path.join(dir, '.nvmrc'))).toBe(major);
  });

  it('reads the Node version file nearest the project, never above the repository', () => {
    const project = path.join(dir, 'repo', 'e2e');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(dir, '.nvmrc'), '22\n');
    expect(findNodeVersionFile(project, path.join(dir, 'repo'))).toBeUndefined();
    writeFileSync(path.join(dir, 'repo', '.node-version'), '24\n');
    expect(findNodeVersionFile(project, path.join(dir, 'repo'))).toBe(path.join(dir, 'repo', '.node-version'));
    writeFileSync(path.join(project, '.nvmrc'), '26\n');
    expect(findNodeVersionFile(project, path.join(dir, 'repo'))).toBe(path.join(project, '.nvmrc'));
  });
});

describe('reading an existing config', () => {
  it('names the gateways by the import line init writes', () => {
    expect(gatewaysInConfig("import { gateway } from 'ai';\n").map(({ id }) => id)).toEqual(['vercel']);
    expect(gatewaysInConfig("import { chatgpt } from 'e2e/oauth/chatgpt';\n").map(({ id }) => id)).toEqual(['chatgpt']);
    expect(gatewaysInConfig("import { anthropic } from '@ai-sdk/anthropic';\n")).toEqual([]);
    // As a formatter or a hand edit leaves it: double quotes, other names, no semicolon.
    expect(gatewaysInConfig('import { generateText, gateway } from "ai"\n').map(({ id }) => id)).toEqual(['vercel']);
    expect(gatewaysInConfig('import {openrouter} from "@openrouter/ai-sdk-provider";\n').map(({ id }) => id)).toEqual(['openrouter']);
    expect(gatewaysInConfig("import { gatewayish } from 'ai';\n")).toEqual([]);
  });

  it('finds an OpenAI-compatible baseURL on this machine', () => {
    expect(configUsesLocalModel("        baseURL: 'http://127.0.0.1:11434/v1',")).toBe(true);
    expect(configUsesLocalModel('        baseURL: "http://localhost:8080/v1",')).toBe(true);
    expect(configUsesLocalModel("        baseURL: 'https://llm.example/v1',")).toBe(false);
    expect(configUsesLocalModel("        // baseURL: 'http://127.0.0.1:11434/v1',")).toBe(false);
  });

  it('tells a command the runner starts from a commented-out one', () => {
    expect(configStartsApp("    command: { executable: 'npm', args: ['run', 'dev'] },")).toBe(true);
    expect(configStartsApp("    // command: { executable: 'npm', args: ['run', 'dev'] },")).toBe(false);
  });
});
