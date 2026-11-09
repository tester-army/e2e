import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configStartsApp,
  configUsesLocalModel,
  findNodeVersionFile,
  findRepositoryRoot,
  gatewaysInConfig,
  detectCiService,
  GITHUB_ACTIONS,
  getCiService,
  readNodeMajor,
  renderGithubWorkflow,
  renderGitlabPipeline,
  type WorkflowContext,
} from '../../src/cli/init/ci.ts';

const base: WorkflowContext = { manager: 'npm', projectDir: '', installDir: '', secrets: [] };

describe('renderGithubWorkflow', () => {
  it('writes the npm workflow at the repository root with the model key from secrets', () => {
    const workflow = renderGithubWorkflow({ ...base, secrets: ['AI_GATEWAY_API_KEY'] });
    expect(workflow).toContain(`      - uses: ${GITHUB_ACTIONS.setupNode}\n        with:\n          node-version: 24\n          cache: npm\n      - run: npm ci\n`);
    expect(workflow).toContain("key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}");
    expect(workflow).toContain('run: npx e2e-web install chromium --with-deps');
    expect(workflow).toContain('run: npx e2e run --reporter list,junit\n        env:\n          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}\n');
    expect(workflow).toContain('            .e2e/report.json\n            .e2e/junit.xml\n            .e2e/results\n');
    expect(workflow).not.toContain('working-directory');
    expect(workflow).not.toContain('cache-dependency-path');
  });

  it('sets no env block when the run reads no key', () => {
    expect(renderGithubWorkflow(base)).not.toContain('env:');
  });

  it('runs a workspace member from its folder and installs at the workspace root', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'pnpm', projectDir: 'apps/web', installDir: '', pnpmVersion: '10' });
    expect(workflow).toContain('    defaults:\n      run:\n        working-directory: apps/web\n');
    expect(workflow).toContain(`      - uses: ${GITHUB_ACTIONS.setupPnpm}\n        with:\n          version: '10'\n`);
    expect(workflow).toContain('      - run: pnpm install --frozen-lockfile\n        working-directory: .\n');
    expect(workflow).toContain("hashFiles('pnpm-lock.yaml')");
    expect(workflow).toContain('run: pnpm exec e2e run --reporter list,junit');
    expect(workflow).toContain('            apps/web/.e2e/report.json\n');
  });

  it('points the cache at a lockfile below the root, and pnpm at the package.json with its packageManager field', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'pnpm', projectDir: 'e2e', installDir: 'e2e', nodeVersionFile: '.nvmrc' });
    expect(workflow).toContain(`      - uses: ${GITHUB_ACTIONS.setupPnpm}\n        with:\n          package_json_file: e2e/package.json\n      - uses: `);
    expect(renderGithubWorkflow({ ...base, manager: 'pnpm' })).toContain(`      - uses: ${GITHUB_ACTIONS.setupPnpm}\n      - uses: `);
    expect(workflow).toContain('          node-version-file: .nvmrc\n          cache: pnpm\n          cache-dependency-path: e2e/pnpm-lock.yaml\n');
    expect(workflow).toContain('      - run: pnpm install --frozen-lockfile\n      - uses: ');
  });

  it.each([
    { yarnBerry: false, install: 'yarn install --frozen-lockfile' },
    { yarnBerry: true, install: 'yarn install --immutable' },
  ])('enables corepack for Yarn and installs with $install', ({ yarnBerry, install }) => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'yarn', yarnBerry });
    expect(workflow).toContain('      - run: corepack enable\n');
    expect(workflow).toContain(`      - run: ${install}\n`);
    expect(workflow).toContain('run: yarn e2e run --reporter list,junit');
  });

  it('sets up Bun and keeps setup-node for the runner without a cache', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'bun' });
    expect(workflow).toContain(`      - uses: ${GITHUB_ACTIONS.setupBun}\n`);
    expect(workflow).toContain('          node-version: 24\n      - run: bun install --frozen-lockfile\n');
    expect(workflow).toContain("hashFiles('bun.lock')");
    expect(workflow).toContain('run: bunx e2e run --reporter list,junit');
  });

  it('runs only the web target when a mobile target shares the config', () => {
    expect(renderGithubWorkflow({ ...base, target: 'web' })).toContain('run: npx e2e run --target web --reporter list,junit');
  });

  it('quotes a folder YAML would read as something else', () => {
    expect(renderGithubWorkflow({ ...base, projectDir: 'my app', installDir: 'my app' })).toContain("working-directory: 'my app'");
  });
});

describe('renderGitlabPipeline', () => {
  it('runs the npm job in merge requests and on the default branch, caching inside the project', () => {
    const pipeline = renderGitlabPipeline({ ...base, secrets: ['AI_GATEWAY_API_KEY'] });
    expect(pipeline).toMatch(/^e2e:\n  image: node:24\n/u);
    expect(pipeline).toContain('    - if: $CI_PIPELINE_SOURCE == "merge_request_event"\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n');
    expect(pipeline).toContain('    PLAYWRIGHT_BROWSERS_PATH: $CI_PROJECT_DIR/.cache/ms-playwright\n');
    expect(pipeline).toContain('      files:\n        - package-lock.json\n    paths:\n      - .cache/ms-playwright/\n      - .npm/\n');
    expect(pipeline).toContain(
      '  script:\n    - npm ci --cache .npm --prefer-offline\n    - npx e2e-web install chromium --with-deps\n    - npx e2e run --reporter list,junit\n',
    );
    expect(pipeline).toContain('    reports:\n      junit: .e2e/junit.xml\n');
    // CI/CD variables reach the job's environment on their own; the file names no key.
    expect(pipeline).not.toContain('AI_GATEWAY_API_KEY');
    // No workflow block, so the file works on its own and when another pipeline includes it.
    expect(pipeline).not.toContain('workflow:');
  });

  it('installs at the workspace root and runs in the project folder', () => {
    const pipeline = renderGitlabPipeline({ ...base, manager: 'pnpm', projectDir: 'apps/web', installDir: '', pnpmVersion: '10', nodeMajor: '26' });
    expect(pipeline).toContain('  image: node:26\n');
    expect(pipeline).toContain(
      '    - npm install --global pnpm@10\n    - pnpm config set store-dir .pnpm-store\n    - pnpm install --frozen-lockfile\n    - cd "$CI_PROJECT_DIR/apps/web"\n',
    );
    expect(pipeline).toContain('        - pnpm-lock.yaml\n');
    expect(pipeline).toContain('      - apps/web/.e2e/report.json\n');
    expect(pipeline).toContain('      junit: apps/web/.e2e/junit.xml\n');
    expect(pipeline).not.toContain('COREPACK');
  });

  it('changes into a project below the root before the install, and lets corepack read packageManager', () => {
    const pipeline = renderGitlabPipeline({ ...base, manager: 'pnpm', projectDir: 'site', installDir: 'site' });
    expect(pipeline).toContain("    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'\n");
    // Node 25 and later ship no corepack.
    expect(pipeline).toContain('  script:\n    - cd "$CI_PROJECT_DIR/site"\n    - command -v corepack || npm install --global corepack\n    - corepack enable\n');
    expect(pipeline).toContain('      - site/.pnpm-store/\n');
    expect(pipeline).toContain('        - site/pnpm-lock.yaml\n');
  });

  it.each([
    // The node:26 image has no Yarn 1, and Node 25 and later no corepack.
    { yarnBerry: false, install: ['command -v yarn || npm install --global yarn', 'yarn install --frozen-lockfile --cache-folder .yarn-cache'] },
    { yarnBerry: true, install: ['command -v corepack || npm install --global corepack', 'corepack enable', 'yarn install --immutable'] },
  ])('installs Yarn dependencies with $install', ({ yarnBerry, install }) => {
    expect(renderGitlabPipeline({ ...base, manager: 'yarn', yarnBerry })).toContain(`  script:\n${install.map((line) => `    - ${line}\n`).join('')}`);
  });

  it('installs Bun into the node image and runs only the web target beside a mobile one', () => {
    const pipeline = renderGitlabPipeline({ ...base, manager: 'bun', target: 'web' });
    expect(pipeline).toContain('    - npm install --global bun\n    - bun install --frozen-lockfile\n');
    expect(pipeline).toContain('    - bunx e2e run --target web --reporter list,junit\n');
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

  it('match the pins in the docs and the e2e skill, so a user copying either gets what init writes', () => {
    const pins = new Map(Object.values(GITHUB_ACTIONS).map((pin) => [pin.split('@')[0], pin]));
    const mismatches = [...pages(path.join(repository, 'docs')), ...pages(path.join(repository, 'skills/e2e'))].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/uses: ([\w.-]+\/[\w.-]+)@(\S+ # \S+)/gu)]
        .filter(([, action]) => pins.has(action!))
        .map(([, action, ref]) => `${action}@${ref}`)
        .filter((pin) => pin !== pins.get(pin.split('@')[0]!))
        .map((pin) => `${path.relative(repository, file)}: ${pin}`));
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
    const located = getCiService('gitlab').locate(dir);
    expect(located).toMatchObject({ file: '.gitlab/e2e.gitlab-ci.yml', jobName: 'e2e-run' });
    expect(renderGitlabPipeline({ ...base, jobName: 'e2e-run' })).toMatch(/^e2e-run:\n/u);
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
