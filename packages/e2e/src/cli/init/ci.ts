/**
 * The CI pipeline `e2e init` writes: GitHub Actions or GitLab CI/CD, one job
 * that runs the web targets on a hosted Linux runner. A mobile job needs the
 * app's build command, scheme, and paths, which init cannot know, so init
 * points at the docs page instead of writing a job that fails on its first push.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parseDocument, type Document, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import type { PackageManager } from '../../internal/package-manager.ts';
import { isLoopbackHost } from '../../internal/urls.ts';
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
  /** The job's name when the pipeline already has a job named `e2e`. */
  readonly jobName?: string;
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
  const stages = gitlabStages(pipeline);
  // GitLab merges jobs of the same name across included files, so the job steps aside for one the pipeline already has.
  const jobName = /^e2e\s*:/mu.test(pipeline) ? 'e2e-run' : 'e2e';
  return {
    file: GITLAB_INCLUDED,
    existing: existsSync(path.join(root, GITLAB_INCLUDED)),
    include: `include:\n  - local: ${GITLAB_INCLUDED}`,
    ...(stages !== undefined && !stages.includes('test')
      ? { note: `The ${jobName} job runs in the test stage; add test to the stages in ${GITLAB_PIPELINE}` }
      : {}),
    ...(jobName === 'e2e' ? {} : { jobName }),
  };
}

/** The names a pipeline's top-level `stages:` lists, flow (`[build, test]`) or block style; undefined without one. */
function gitlabStages(pipeline: string): string[] | undefined {
  const block = /^stages:[ \t]*(.*(?:\n[ \t]+-.*)*)/mu.exec(pipeline)?.[1];
  if (block === undefined) return undefined;
  return block
    .replaceAll(/[[\]]/gu, '')
    .split(/[,\n]/u)
    .map((item) => item.replace(/^\s*-?\s*/u, '').replace(/#.*$/u, '').trim().replaceAll(/^['"]|['"]$/gu, ''))
    .filter((item) => item !== '');
}

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
  /** The GitLab job's name; `e2e` unless the pipeline it joins has one. */
  readonly jobName?: string;
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

/** Options that print a template back the way it is written: no wrapping, `[main]` without padding. */
const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

/**
 * A pipeline template from `templates/ci/`, shipped beside `dist/`. Each is
 * a complete pipeline for npm at the repository root, so linters and the
 * docs read it as it is; init edits a copy for the project.
 */
function readTemplate(name: string): Document {
  return parseDocument(readFileSync(new URL(`../../../templates/ci/${name}`, import.meta.url), 'utf8'));
}

/** A template's `npx <bin> ...` command for the project's package manager, with `--target` after `e2e run`. */
function templateCommand(manager: PackageManager, template: string, target: string | undefined): string {
  const bare = template.replace(/^npx /u, '');
  return exec(manager, target === undefined ? bare : bare.replace(/^e2e run/u, `e2e run --target ${target}`));
}

/** The map in `items` whose `key` holds `value`, which the template guarantees. */
function findItem(items: readonly unknown[], key: string, matches: (value: string) => boolean): YAMLMap {
  const found = items.find((item): item is YAMLMap => isMap(item) && matches(String(item.get(key) ?? '')));
  if (found === undefined) throw new Error(`the CI template has no step with ${key} ${matches.toString()}`);
  return found;
}

/** Sets `key` in `map` right before `before`, or at the end when `before` is absent. */
function setBefore(doc: Document, map: YAMLMap, key: string, value: unknown, before: string): void {
  map.delete(key);
  const at = map.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === before);
  const pair = doc.createPair(key, value);
  if (at === -1) map.items.push(pair);
  else map.items.splice(at, 0, pair);
}

/** The GitHub Actions workflow that runs the project's web targets on pull requests and on pushes to main. */
export function renderGithubWorkflow(context: WorkflowContext): string {
  const { manager, projectDir, installDir } = context;
  const lockfile = join(installDir, LOCKFILE[manager]);
  const doc = readTemplate('github-actions.yml');
  const job = doc.getIn(['jobs', 'e2e']) as YAMLMap;
  const steps = job.get('steps') as YAMLSeq;
  const byUses = (action: string): YAMLMap => findItem(steps.items, 'uses', (uses) => uses.startsWith(`${action}@`));
  const byName = (name: string): YAMLMap => findItem(steps.items, 'name', (value) => value === name);

  if (projectDir !== '') setBefore(doc, job, 'defaults', { run: { 'working-directory': projectDir } }, 'steps');

  const setupNode = byUses('actions/setup-node');
  const nodeOptions = setupNode.get('with') as YAMLMap;
  if (context.nodeVersionFile !== undefined) {
    nodeOptions.delete('node-version');
    setBefore(doc, nodeOptions, 'node-version-file', context.nodeVersionFile, 'cache');
  }
  // setup-node caches the store of npm, pnpm, and Yarn; Bun keeps its own.
  if (manager === 'bun') nodeOptions.delete('cache');
  else nodeOptions.set('cache', manager);
  if (manager !== 'bun' && lockfile !== LOCKFILE[manager]) nodeOptions.set('cache-dependency-path', lockfile);

  const setup = (readTemplate('github-actions-setup.yml').get(manager) as YAMLSeq | undefined)?.items ?? [];
  if (manager === 'pnpm') {
    // Without a version, the action reads packageManager from the repository root's package.json unless told where the project's is.
    const options = context.pnpmVersion !== undefined
      ? { version: context.pnpmVersion }
      : installDir === '' ? undefined : { package_json_file: join(installDir, 'package.json') };
    if (options !== undefined) (setup[0] as YAMLMap).set('with', doc.createNode(options));
  }
  steps.items.splice(steps.items.indexOf(setupNode), 0, ...setup);

  const install = byName('Install dependencies');
  install.set('run', frozenInstall(manager, context.yarnBerry === true));
  if (installDir !== projectDir) install.set('working-directory', installDir === '' ? '.' : installDir);

  const cache = byUses('actions/cache').get('with') as YAMLMap;
  cache.set('key', String(cache.get('key')).replace(`hashFiles('${LOCKFILE.npm}')`, `hashFiles('${lockfile}')`));

  const browsers = byName('Install browsers');
  browsers.set('run', templateCommand(manager, String(browsers.get('run')), undefined));
  const run = byName('Run e2e');
  run.set('run', templateCommand(manager, String(run.get('run')), context.target));
  if (context.secrets.length === 0) run.delete('env');
  else run.set('env', doc.createNode(Object.fromEntries(context.secrets.map((name) => [name, `\${{ secrets.${name} }}`]))));

  if (projectDir !== '') {
    const upload = byName('Upload the report').get('with') as YAMLMap;
    const paths = upload.get('path', true) as Scalar<string>;
    paths.value = paths.value.split('\n').map((line) => (line === '' ? line : join(projectDir, line))).join('\n');
  }
  return doc.toString(STRINGIFY);
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
  const doc = readTemplate('gitlab-ci.yml');
  const job = doc.get('e2e') as YAMLMap;
  // Yarn 2 and later keep their own cache and ignore --cache-folder.
  const store = manager === 'yarn' && context.yarnBerry === true ? undefined : GITLAB_STORE[manager];
  const usesCorepack = (manager === 'pnpm' && context.pnpmVersion === undefined) || (manager === 'yarn' && context.yarnBerry === true);
  const cd = (dir: string): string[] => (dir === '' ? [] : [`cd "$CI_PROJECT_DIR/${dir}"`]);

  if (context.jobName !== undefined) {
    const key = (doc.contents as YAMLMap).items.find((pair) => isScalar(pair.key) && pair.key.value === 'e2e')?.key as Scalar;
    key.value = context.jobName;
  }
  job.set('image', `node:${context.nodeMajor ?? DEFAULT_NODE}`);
  if (usesCorepack) (job.get('variables') as YAMLMap).set('COREPACK_ENABLE_DOWNLOAD_PROMPT', '0');
  (job.getIn(['cache', 'key', 'files']) as YAMLSeq).set(0, join(installDir, LOCKFILE[manager]));
  const cachePaths = job.getIn(['cache', 'paths']) as YAMLSeq;
  if (store === undefined) cachePaths.delete(1);
  else cachePaths.set(1, `${join(installDir, store)}/`);

  const [, browsers, run] = (job.get('script') as YAMLSeq<Scalar<string>>).items;
  job.set('script', doc.createNode([
    ...cd(installDir),
    ...gitlabInstall(context),
    ...(installDir === projectDir ? [] : projectDir === '' ? ['cd "$CI_PROJECT_DIR"'] : cd(projectDir)),
    templateCommand(manager, browsers!.value, undefined),
    templateCommand(manager, run!.value, context.target),
  ]));

  if (projectDir !== '') {
    for (const item of (job.getIn(['artifacts', 'paths']) as YAMLSeq<Scalar<string>>).items) item.value = join(projectDir, item.value);
    const junit = job.getIn(['artifacts', 'reports', 'junit'], true) as Scalar<string>;
    junit.value = join(projectDir, junit.value);
  }
  return doc.toString(STRINGIFY);
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

/** Whether a config points an OpenAI-compatible model at a loopback `baseURL`, which a CI runner cannot reach. */
export function configUsesLocalModel(config: string): boolean {
  return [...config.matchAll(/^\s*baseURL\s*:\s*['"`]([^'"`]+)['"`]/gmu)].some(([, url]) => {
    try {
      return isLoopbackHost(new URL(url!).hostname);
    } catch {
      return false;
    }
  });
}

/** Whether a config sets an app `command`, so the runner can start the app on a fresh CI machine. */
export function configStartsApp(config: string): boolean {
  return config.split('\n').some((line) => !line.trimStart().startsWith('//') && /\bcommand\s*:/u.test(line));
}
