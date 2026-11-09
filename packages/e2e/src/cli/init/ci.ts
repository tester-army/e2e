/**
 * The CI pipeline `e2e init` writes: GitHub Actions or GitLab CI/CD, one job
 * that runs the web targets on a hosted Linux runner. A mobile job needs the
 * app's build command, scheme, and paths, which init cannot know, so init
 * points at the docs page instead of writing a job that fails on its first push.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PackageManager } from '../../internal/package-manager.ts';
import { GATEWAYS, type GatewayPreset } from './gateways.ts';

export type CiId = 'github-actions' | 'gitlab';
export type CiChoice = CiId | 'none';

/** Where a service's pipeline goes, relative to the repository root. */
export interface CiFile {
  readonly file: string;
  /** Whether e2e already runs there, so init writes nothing. */
  readonly existing: boolean;
  /** For a file the main pipeline must include: the lines to add to it. */
  readonly include?: string;
  /** Something else the main pipeline needs before the included job can run. */
  readonly note?: string;
}

export interface CiService {
  readonly id: CiId;
  readonly label: string;
  readonly hint: string;
  /** The docs page for the service's mobile jobs and everything init does not write. */
  readonly docs: string;
  locate(repositoryRoot: string): CiFile;
  render(context: WorkflowContext): string;
  /** How to give the run a model key it reads from the environment. */
  secretHint(name: string): string;
}

/** Where the GitHub Actions workflow goes, relative to the repository root. */
const GITHUB_WORKFLOW = '.github/workflows/e2e.yml';
/** GitLab's pipeline file, and the file init writes beside one that already exists. */
export const GITLAB_PIPELINE = '.gitlab-ci.yml';
const GITLAB_INCLUDED = '.gitlab/e2e.gitlab-ci.yml';

export const CI_SERVICES: readonly CiService[] = [
  {
    id: 'github-actions',
    label: 'GitHub Actions',
    hint: 'web tests on every pull request and push to main',
    docs: '/ci/github-actions',
    locate: locateGithubWorkflow,
    render: (context) => renderGithubWorkflow(context),
    secretHint: (name) => `The workflow reads ${name} from the repository secrets; add it with gh secret set ${name}`,
  },
  {
    id: 'gitlab',
    label: 'GitLab CI/CD',
    hint: 'web tests in every merge request and on the default branch',
    // The GitLab page is not published yet; the CI overview lists every service.
    docs: '/ci',
    locate: locateGitlabPipeline,
    render: (context) => renderGitlabPipeline(context),
    secretHint: (name) =>
      `The pipeline reads ${name} from the project's CI/CD variables; add it masked and hidden with glab variable set ${name} --masked --hidden --raw`,
  },
];

/** The service with this id. */
export function getCiService(id: CiId): CiService {
  const service = CI_SERVICES.find((entry) => entry.id === id);
  if (service === undefined) throw new Error(`unknown CI service: ${id}`);
  return service;
}

/**
 * Where the GitHub workflow goes: `.github/workflows/e2e.yml`, unless that
 * file or another workflow already runs `e2e run`, in which case e2e is set up.
 */
function locateGithubWorkflow(root: string): CiFile {
  const workflows = path.join(root, '.github', 'workflows');
  const running = existsSync(workflows)
    ? readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name)).find((name) => readFileSync(path.join(workflows, name), 'utf8').includes('e2e run'))
    : undefined;
  if (running !== undefined) return { file: `.github/workflows/${running}`, existing: true };
  return { file: GITHUB_WORKFLOW, existing: existsSync(path.join(root, GITHUB_WORKFLOW)) };
}

/**
 * Where the GitLab job goes: `.gitlab-ci.yml` when the project has none, else
 * a file of its own that `.gitlab-ci.yml` includes, so init never edits the
 * project's pipeline. A pipeline file that already runs `e2e run` counts as set up.
 */
function locateGitlabPipeline(root: string): CiFile {
  const main = path.join(root, GITLAB_PIPELINE);
  if (!existsSync(main)) return { file: GITLAB_PIPELINE, existing: false };
  const pipeline = readFileSync(main, 'utf8');
  if (pipeline.includes('e2e run')) return { file: GITLAB_PIPELINE, existing: true };
  // The job runs in GitLab's default `test` stage, which a pipeline that lists its own stages may leave out.
  const stages = /^stages:(.*(?:\n[ \t-].*)*)/mu.exec(pipeline)?.[1];
  const missingTest = stages !== undefined && !/\btest\b/u.test(stages);
  return {
    file: GITLAB_INCLUDED,
    existing: existsSync(path.join(root, GITLAB_INCLUDED)),
    include: `include:\n  - local: ${GITLAB_INCLUDED}`,
    ...(missingTest ? { note: `The e2e job runs in the test stage; add test to the stages in ${GITLAB_PIPELINE}` } : {}),
  };
}

/**
 * Every action the workflow uses, pinned by commit with its tag beside it.
 * The docs and the e2e skill pin the same commits; `tests/unit/init-ci.test.ts` holds them together.
 */
export const GITHUB_ACTIONS = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
  setupPnpm: 'pnpm/action-setup@9fd676a19091d4595eefd76e4bd31c97133911f1 # v4.2.0',
  setupBun: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0',
  cache: 'actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0',
  uploadArtifact: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
} as const;

/** The Node version a pipeline sets up when the project pins none. */
const DEFAULT_NODE = '24';

const LOCKFILE: Record<PackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};

/** What the workflow is rendered from; every path is POSIX and relative to the repository root, `''` for the root itself. */
export interface WorkflowContext {
  readonly manager: PackageManager;
  /** The e2e project: where `e2e.config.ts` is and the run starts. */
  readonly projectDir: string;
  /** Where the install runs and the lockfile is: the workspace root for a workspace member. */
  readonly installDir: string;
  /** A `.nvmrc` or `.node-version` file to read the Node version from. */
  readonly nodeVersionFile?: string;
  /** The major Node version that file names, for a service that takes a version rather than a file. */
  readonly nodeMajor?: string;
  /** The pnpm version to install when `package.json` has no `packageManager` field naming one. */
  readonly pnpmVersion?: string;
  /** Yarn 2 or later, whose frozen install is `--immutable`. */
  readonly yarnBerry?: boolean;
  /** Environment variables the run reads from repository secrets of the same name. */
  readonly secrets: readonly string[];
  /** The target to run when the config also has targets this runner cannot drive. */
  readonly target?: string;
}

/**
 * The command that runs a package's bin in a pipeline file. It differs from
 * `execCommand` on purpose: CI files use the short forms the CI docs and
 * vendor examples use (`npx`, `bunx`), not `npm exec --` or `bun run`.
 */
function exec(manager: PackageManager, command: string): string {
  switch (manager) {
    case 'npm':
      return `npx ${command}`;
    case 'pnpm':
      return `pnpm exec ${command}`;
    case 'yarn':
      return `yarn ${command}`;
    case 'bun':
      return `bunx ${command}`;
  }
}

/** The install that fails instead of updating the lockfile. */
function frozenInstall(manager: PackageManager, yarnBerry: boolean): string {
  switch (manager) {
    case 'npm':
      return 'npm ci';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return yarnBerry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
  }
}

/** `dir/file`, or `file` at the root. */
function join(dir: string, file: string): string {
  return dir === '' ? file : `${dir}/${file}`;
}

/** A YAML scalar: bare when it reads back as the same string, single-quoted otherwise. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./-]+$/u.test(value) && !/^[0-9.]+$/u.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** The GitHub Actions workflow that runs the project's web targets on pull requests and on pushes to main. */
export function renderGithubWorkflow(context: WorkflowContext): string {
  const { manager, projectDir, installDir } = context;
  const lockfile = join(installDir, LOCKFILE[manager]);
  const output = join(projectDir, '.e2e');
  const installElsewhere = installDir !== projectDir;
  const nodeVersion = context.nodeVersionFile === undefined
    ? [`          node-version: ${DEFAULT_NODE}`]
    : [`          node-version-file: ${scalar(context.nodeVersionFile)}`];
  // setup-node caches the store of npm, pnpm, and Yarn; Bun keeps its own.
  const nodeCache = manager === 'bun'
    ? []
    : [`          cache: ${manager}`, ...(lockfile === LOCKFILE[manager] ? [] : [`          cache-dependency-path: ${scalar(lockfile)}`])];
  const run = ['e2e run', ...(context.target === undefined ? [] : [`--target ${context.target}`]), '--reporter list,junit'].join(' ');

  return [
    'name: e2e',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    '  group: ${{ github.workflow }}-${{ github.ref }}',
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    '',
    'jobs:',
    '  e2e:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    ...(projectDir === '' ? [] : ['    defaults:', '      run:', `        working-directory: ${scalar(projectDir)}`]),
    '    steps:',
    `      - uses: ${GITHUB_ACTIONS.checkout}`,
    ...(manager === 'pnpm'
      ? [
          `      - uses: ${GITHUB_ACTIONS.setupPnpm}`,
          // Without a version, the action reads packageManager from the repository root's package.json unless told where the project's is.
          ...(context.pnpmVersion !== undefined
            ? ['        with:', `          version: ${scalar(context.pnpmVersion)}`]
            : installDir === ''
              ? []
              : ['        with:', `          package_json_file: ${scalar(join(installDir, 'package.json'))}`]),
        ]
      : []),
    ...(manager === 'bun' ? [`      - uses: ${GITHUB_ACTIONS.setupBun}`] : []),
    // Yarn 2 and later come from the packageManager field through corepack; the runner image has only Yarn 1.
    ...(manager === 'yarn' ? ['      - run: corepack enable'] : []),
    `      - uses: ${GITHUB_ACTIONS.setupNode}`,
    '        with:',
    ...nodeVersion,
    ...nodeCache,
    `      - run: ${frozenInstall(manager, context.yarnBerry === true)}`,
    ...(installElsewhere ? [`        working-directory: ${installDir === '' ? '.' : scalar(installDir)}`] : []),
    `      - uses: ${GITHUB_ACTIONS.cache}`,
    '        with:',
    '          path: ~/.cache/ms-playwright',
    `          key: playwright-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('${lockfile}') }}`,
    '',
    '      - name: Install browsers',
    `        run: ${exec(manager, 'e2e-web install chromium --with-deps')}`,
    '',
    '      - name: Run e2e',
    `        run: ${exec(manager, run)}`,
    ...(context.secrets.length === 0
      ? []
      : ['        env:', ...context.secrets.map((name) => `          ${name}: \${{ secrets.${name} }}`)]),
    '',
    '      - name: Upload the report',
    '        if: ${{ !cancelled() }}',
    `        uses: ${GITHUB_ACTIONS.uploadArtifact}`,
    '        with:',
    '          name: e2e-report',
    '          path: |',
    `            ${output}/report.json`,
    `            ${output}/junit.xml`,
    `            ${output}/results`,
    '          if-no-files-found: warn',
    '          retention-days: 7',
    '',
  ].join('\n');
}

/** The `npm`, `pnpm`, Yarn 1, or Bun cache a GitLab job keeps in the project, since GitLab caches only paths inside it. */
const GITLAB_STORE: Record<PackageManager, string | undefined> = {
  npm: '.npm',
  pnpm: '.pnpm-store',
  yarn: '.yarn-cache',
  bun: undefined,
};

/** Node 25 and later ship no corepack, and their `node` images no Yarn; these install it where it is missing. */
const COREPACK = ['command -v corepack || npm install --global corepack', 'corepack enable'];

/** The commands that install the package manager and the dependencies in a `node` image, with the cache inside the project. */
function gitlabInstall(context: WorkflowContext): string[] {
  const { manager } = context;
  switch (manager) {
    case 'npm':
      return ['npm ci --cache .npm --prefer-offline'];
    case 'pnpm':
      return [
        ...(context.pnpmVersion === undefined ? COREPACK : [`npm install --global pnpm@${context.pnpmVersion}`]),
        'pnpm config set store-dir .pnpm-store',
        'pnpm install --frozen-lockfile',
      ];
    case 'yarn':
      return context.yarnBerry === true
        ? [...COREPACK, 'yarn install --immutable']
        : ['command -v yarn || npm install --global yarn', 'yarn install --frozen-lockfile --cache-folder .yarn-cache'];
    case 'bun':
      return ['npm install --global bun', 'bun install --frozen-lockfile'];
  }
}

/**
 * The GitLab CI/CD job that runs the project's web targets in merge request
 * pipelines and on the default branch. The rules sit on the job, not in a
 * `workflow:` block, so the same file works as `.gitlab-ci.yml` and as a file
 * another pipeline includes.
 */
export function renderGitlabPipeline(context: WorkflowContext): string {
  const { manager, projectDir, installDir } = context;
  const lockfile = join(installDir, LOCKFILE[manager]);
  const output = join(projectDir, '.e2e');
  const store = GITLAB_STORE[manager];
  const run = ['e2e run', ...(context.target === undefined ? [] : [`--target ${context.target}`]), '--reporter list,junit'].join(' ');
  const cd = (dir: string): string[] => (dir === '' ? [] : [`cd "$CI_PROJECT_DIR/${dir}"`]);
  const usesCorepack = (manager === 'pnpm' && context.pnpmVersion === undefined) || (manager === 'yarn' && context.yarnBerry === true);

  return [
    'e2e:',
    `  image: node:${context.nodeMajor ?? DEFAULT_NODE}`,
    '  interruptible: true',
    '  timeout: 30 minutes',
    '  rules:',
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
    '    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH',
    '  variables:',
    '    # GitLab caches only paths inside the project.',
    '    PLAYWRIGHT_BROWSERS_PATH: $CI_PROJECT_DIR/.cache/ms-playwright',
    ...(usesCorepack ? ["    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'"] : []),
    '  cache:',
    '    key:',
    '      files:',
    `        - ${scalar(lockfile)}`,
    '    paths:',
    '      - .cache/ms-playwright/',
    ...(store === undefined ? [] : [`      - ${scalar(`${join(installDir, store)}/`)}`]),
    '  script:',
    ...[
      ...cd(installDir),
      ...gitlabInstall(context),
      ...(installDir === projectDir ? [] : projectDir === '' ? ['cd "$CI_PROJECT_DIR"'] : cd(projectDir)),
      exec(manager, 'e2e-web install chromium --with-deps'),
      exec(manager, run),
    ].map((line) => `    - ${line}`),
    '  artifacts:',
    '    when: always',
    '    expire_in: 7 days',
    '    paths:',
    `      - ${scalar(`${output}/report.json`)}`,
    `      - ${scalar(`${output}/junit.xml`)}`,
    `      - ${scalar(`${output}/results/`)}`,
    '    reports:',
    `      junit: ${scalar(`${output}/junit.xml`)}`,
    '',
  ].join('\n');
}

/**
 * The repository the project is in: the nearest directory at or above `dir`
 * with a `.git` entry (a directory, or a file in a worktree or submodule),
 * else `fallback`, the directory `e2e init` was pointed at.
 */
export function findRepositoryRoot(dir: string, fallback: string): string {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return path.resolve(fallback);
  }
}

/**
 * The service the repository looks hosted on: GitLab for a `.gitlab-ci.yml`
 * or a remote on a `gitlab.` host, GitHub for a `.github/` directory or a
 * github.com remote. Undefined when nothing points either way.
 */
export function detectCiService(repositoryRoot: string): CiId | undefined {
  let remotes = '';
  const gitConfig = path.join(repositoryRoot, '.git', 'config');
  try {
    if (statSync(gitConfig).isFile()) remotes = readFileSync(gitConfig, 'utf8');
  } catch {
    // No git config: a worktree, a submodule, or no repository yet.
  }
  if (existsSync(path.join(repositoryRoot, GITLAB_PIPELINE)) || /url\s*=.*\bgitlab\./u.test(remotes)) return 'gitlab';
  if (existsSync(path.join(repositoryRoot, '.github')) || /url\s*=.*github\.com[:/]/u.test(remotes)) return 'github-actions';
  return undefined;
}

/** The `.nvmrc` or `.node-version` nearest the project, up to the repository root. */
export function findNodeVersionFile(projectDir: string, repositoryRoot: string): string | undefined {
  const root = path.resolve(repositoryRoot);
  for (let current = path.resolve(projectDir); ; current = path.dirname(current)) {
    for (const name of ['.nvmrc', '.node-version']) {
      if (existsSync(path.join(current, name))) return path.join(current, name);
    }
    if (current === root || path.dirname(current) === current) return undefined;
  }
}

/** The major version a `.nvmrc` or `.node-version` names (`24`, `v24.8.0`, `24.8`), or undefined for an alias such as `lts/*`. */
export function readNodeMajor(file: string): string | undefined {
  try {
    return /^v?(\d+)(?:\.|\s|$)/u.exec(readFileSync(file, 'utf8').trim())?.[1];
  } catch {
    return undefined;
  }
}

/** `target` relative to `root` with forward slashes; `''` for the root itself. */
export function posixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

/**
 * The gateways an existing config uses, recognized by the import `e2e init`
 * writes for each, in any quoting or alongside other names. A config that
 * builds its model another way matches none, and the pipeline sets no model key.
 */
export function gatewaysInConfig(config: string): readonly GatewayPreset[] {
  return GATEWAYS.filter((gateway) => importPattern(gateway.import)?.test(config) === true);
}

/**
 * A pattern for an import line like `import { gateway } from 'ai';` that
 * also matches it with double quotes, other names beside it, or other spacing.
 */
function importPattern(line: string): RegExp | undefined {
  const parts = /^import \{ (\w+) \} from '([^']+)';$/u.exec(line);
  if (parts === null) return undefined;
  const [, name, specifier] = parts;
  const escaped = specifier!.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
  return new RegExp(`import\\s*\\{[^}]*\\b${name!}\\b[^}]*\\}\\s*from\\s*['"]${escaped}['"]`, 'u');
}

/** Whether a config sets an app `command`, so the runner can start the app on a fresh CI machine. */
export function configStartsApp(config: string): boolean {
  return config.split('\n').some((line) => !line.trimStart().startsWith('//') && /\bcommand\s*:/u.test(line));
}
