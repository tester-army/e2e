/**
 * The CI pipeline `e2e init` writes: GitHub Actions or GitLab CI/CD, one job
 * per platform the config's targets run on. The web job runs on a hosted
 * Linux runner. The iOS and Android jobs build the app, boot a simulator or
 * an emulator, install the app, and run its targets; init writes the build
 * for Expo and bare React Native apps and a step to replace for anything else.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parseDocument, type Document, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import type { PackageManager } from '../../internal/package-manager.ts';
import { isLoopbackHost } from '../../internal/urls.ts';
import type { E2EConfig } from '../../types.ts';
import { resolvePlatform, targetName } from '../../config/targets.ts';
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
  /** Something else the main pipeline needs before the included jobs can run. */
  readonly note?: string;
  /** Appended to every job name when the pipeline already has a job of one of those names. */
  readonly jobSuffix?: string;
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
    hint: 'on every pull request and push to main',
    docs: '/ci/github-actions',
    locate: locateGithubWorkflow,
    render: (context) => renderGithubWorkflow(context),
    secretHint: (name) => `The workflow reads ${name} from the repository secrets; add it with gh secret set ${name}`,
  },
  {
    id: 'gitlab',
    label: 'GitLab CI/CD',
    hint: 'in every merge request and on the default branch',
    docs: '/ci/gitlab',
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
  // The jobs run in GitLab's default `test` stage, which a pipeline that lists its own stages may leave out.
  const stages = gitlabStages(pipeline);
  // GitLab merges jobs of the same name across included files, so the jobs step aside for ones the pipeline already has.
  const taken = GITLAB_JOBS.some((name) => new RegExp(`^${name.replaceAll('.', '\\.')}\\s*:`, 'mu').test(pipeline));
  return {
    file: GITLAB_INCLUDED,
    existing: existsSync(path.join(root, GITLAB_INCLUDED)),
    include: `include:\n  - local: ${GITLAB_INCLUDED}`,
    ...(stages !== undefined && !stages.includes('test')
      ? { note: `The e2e jobs run in the test stage; add test to the stages in ${GITLAB_PIPELINE}` }
      : {}),
    ...(taken ? { jobSuffix: '-run' } : {}),
  };
}

/** The jobs the GitLab template defines, which an existing pipeline's own jobs must not share names with. */
const GITLAB_JOBS = ['e2e-web', '.e2e-mobile', 'e2e-ios', 'e2e-android'] as const;

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
  /** The jobs to write, each with the targets it runs. */
  readonly jobs: CiJobs;
  /** Appended to every GitLab job name; see {@link CiFile.jobSuffix}. */
  readonly jobSuffix?: string;
}

/**
 * The jobs a pipeline holds, one per platform. `web` runs every target that
 * is not on a phone, or every target at all when the config has no phone
 * target (`'all'`, no `--target`); `ios` and `android` name their targets.
 * A platform with no targets gets no job.
 */
export interface CiJobs {
  readonly web?: readonly string[] | 'all';
  readonly ios?: { readonly targets: readonly string[]; readonly build: IosBuild };
  readonly android?: { readonly targets: readonly string[]; readonly build: AndroidBuild };
}

/**
 * How the iOS job builds the app for the simulator: Expo generates `ios/`
 * and builds it, a bare React Native app builds its workspace with
 * `xcodebuild`, and anything else gets a step that fails until it is replaced.
 */
export type IosBuild =
  | { readonly kind: 'expo' }
  | { readonly kind: 'react-native'; readonly workspace: string; readonly bundler: boolean }
  | { readonly kind: 'custom' };

/** How the Android job builds a release APK; `prebuild` when Expo still has to generate `android/`. */
export type AndroidBuild =
  | { readonly kind: 'expo'; readonly prebuild: boolean }
  | { readonly kind: 'react-native' }
  | { readonly kind: 'custom' };

/** A target as the pipeline sees it: its name, for `--target`, and the platform its engine drives. */
export interface CiTarget {
  readonly name: string;
  readonly platform: string;
}

/** Phone platforms run in their own job, on a runner with a simulator or an emulator. */
const PHONES = new Set(['ios', 'android']);

/**
 * The jobs for a config's targets. iOS and Android targets get a job each;
 * the rest, web and HTTP-only alike, run in the web job, which names them
 * with `--target` only when the config has phone targets too.
 */
export function ciJobs(targets: readonly CiTarget[], builds: { ios: IosBuild; android: AndroidBuild }): CiJobs {
  const named = (platform: string) => targets.filter((target) => target.platform === platform).map((target) => target.name);
  const others = targets.filter((target) => !PHONES.has(target.platform)).map((target) => target.name);
  const phones = targets.some((target) => PHONES.has(target.platform));
  return {
    ...(others.length === 0 ? {} : { web: phones ? others : 'all' }),
    ...(named('ios').length === 0 ? {} : { ios: { targets: named('ios'), build: builds.ios } }),
    ...(named('android').length === 0 ? {} : { android: { targets: named('android'), build: builds.android } }),
  };
}

/**
 * The targets of a loaded config, named and placed by the rules `e2e run`
 * resolves them with. A target those rules reject is left out; `e2e run`
 * would refuse it too.
 */
export function configTargets(config: E2EConfig): CiTarget[] {
  return (Array.isArray(config.targets) ? config.targets : []).flatMap((target, index) => {
    try {
      const platform = resolvePlatform(target, `targets[${index}]`);
      const name = targetName(target, platform);
      return typeof name === 'string' ? [{ name, platform }] : [];
    } catch {
      return [];
    }
  });
}

/** Where every build writes the APK the Android job installs. */
const APK = 'android/app/build/outputs/apk/release/app-release.apk';

/**
 * The app build for each phone platform, from the project's package.json and
 * native folders: Expo when it depends on `expo`, bare React Native when it
 * depends on `react-native` and has the native project, else custom.
 */
export function detectMobileBuilds(projectDir: string, dependsOn: (name: string) => boolean): { ios: IosBuild; android: AndroidBuild } {
  const ios = path.join(projectDir, 'ios');
  const workspace = existsSync(ios) && statSync(ios).isDirectory()
    ? readdirSync(ios).find((name) => name.endsWith('.xcworkspace') && name !== 'Pods.xcworkspace')
    : undefined;
  const gradle = existsSync(path.join(projectDir, 'android', 'gradlew'));
  if (dependsOn('expo')) {
    return { ios: { kind: 'expo' }, android: { kind: 'expo', prebuild: !gradle } };
  }
  if (dependsOn('react-native')) {
    return {
      ios: workspace === undefined
        ? { kind: 'custom' }
        : { kind: 'react-native', workspace: workspace.replace(/\.xcworkspace$/u, ''), bundler: existsSync(path.join(projectDir, 'Gemfile')) },
      android: gradle ? { kind: 'react-native' } : { kind: 'custom' },
    };
  }
  return { ios: { kind: 'custom' }, android: { kind: 'custom' } };
}

/** The iOS build's commands and the comment above them; every build leaves the `.app` under `build/`. */
function iosBuild(manager: PackageManager, build: IosBuild): { comment: string; lines: string[] } {
  switch (build.kind) {
    case 'expo':
      return {
        comment: ' Expo generates ios/ (CNG): expo run:ios prebuilds it, installs the pods, and builds without a simulator.',
        lines: [exec(manager, 'expo run:ios --configuration Release --device generic --no-bundler --output build/ios')],
      };
    case 'react-native':
      return {
        comment: ' Installs the pods, then builds the workspace for the simulator into build/.',
        lines: [
          ...(build.bundler ? ['bundle install', '(cd ios && bundle exec pod install)'] : ['(cd ios && pod install)']),
          `xcodebuild -workspace ios/${build.workspace}.xcworkspace -scheme ${build.workspace} -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build`,
        ],
      };
    case 'custom':
      return {
        comment: ' Replace this step with your app\'s Release build for the iOS simulator, with the .app under build/.',
        lines: ['echo "Replace this step with your app\'s build for the simulator, with the .app under build/" >&2', 'exit 1'],
      };
  }
}

/** The Android build's commands and the comment above them; every build writes the APK at {@link APK}. */
function androidBuild(manager: PackageManager, build: AndroidBuild): { comment: string; lines: string[] } {
  const gradle = '(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64)';
  switch (build.kind) {
    case 'expo':
      return {
        comment: ' Expo generates android/ (CNG) and signs release builds with the debug keystore.\n Only the emulator\'s ABI: building all four takes about 25 minutes longer.',
        lines: [...(build.prebuild ? [exec(manager, 'expo prebuild --platform android --no-install')] : []), gradle],
      };
    case 'react-native':
      return {
        comment: ' Only the emulator\'s ABI: building all four takes about 25 minutes longer.',
        lines: [gradle],
      };
    case 'custom':
      return {
        comment: ` Replace this step with your app's release build, an APK at ${APK}.`,
        lines: [`echo "Replace this step with your app's build, an APK at ${APK}" >&2`, 'exit 1'],
      };
  }
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

/**
 * A template's `npx <bin> ...` command for the project's package manager. A
 * template `--target` takes the job's target names, or goes for `'all'`.
 */
function templateCommand(manager: PackageManager, template: string, targets?: readonly string[] | 'all'): string {
  const bare = template.replace(/^npx /u, '');
  if (targets === undefined) return exec(manager, bare);
  return exec(manager, bare.replace(/ --target \S+/u, targets === 'all' ? '' : ` --target ${targets.join(',')}`));
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

/**
 * Sets up one GitHub job for the project: its working directory, the Node
 * version and cache, the package manager's own setup step, the frozen
 * install, and the lockfile in every cache key.
 */
function setUpGithubJob(doc: Document, job: YAMLMap, context: WorkflowContext): void {
  const { manager, projectDir, installDir } = context;
  const lockfile = join(installDir, LOCKFILE[manager]);
  const steps = job.get('steps') as YAMLSeq;
  if (projectDir !== '') setBefore(doc, job, 'defaults', { run: { 'working-directory': projectDir } }, 'steps');

  const setupNode = findItem(steps.items, 'uses', (uses) => uses.startsWith('actions/setup-node@'));
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
  // setup-bun reads the version from the repository root's package.json unless told where the project's is.
  if (manager === 'bun' && installDir !== '') {
    (setup[0] as YAMLMap).set('with', doc.createNode({ 'bun-version-file': join(installDir, 'package.json') }));
  }
  steps.items.splice(steps.items.indexOf(setupNode), 0, ...setup);

  const install = findItem(steps.items, 'name', (name) => name === 'Install dependencies');
  install.set('run', frozenInstall(manager, context.yarnBerry === true));
  if (installDir !== projectDir) install.set('working-directory', installDir === '' ? '.' : installDir);

  for (const step of steps.items) {
    const options = isMap(step) ? step.get('with') : undefined;
    if (isMap(options) && typeof options.get('key') === 'string') {
      options.set('key', String(options.get('key')).replace(`hashFiles('${LOCKFILE.npm}')`, `hashFiles('${lockfile}')`));
    }
  }
}

/** Points the job's run step at its targets with the model keys, and its upload at the project's report. */
function finishGithubJob(doc: Document, job: YAMLMap, context: WorkflowContext, run: YAMLMap, targets: readonly string[] | 'all'): void {
  const steps = (job.get('steps') as YAMLSeq).items;
  const script = run.getIn(['with', 'script'], true);
  if (isScalar(script)) {
    // The emulator action runs a script, line by line, instead of a run step.
    script.value = String(script.value).split('\n').map((line) => (line.startsWith('npx ') ? templateCommand(context.manager, line, targets) : line)).join('\n');
    if (context.projectDir !== '') (run.get('with') as YAMLMap).set('working-directory', context.projectDir);
  } else {
    run.set('run', templateCommand(context.manager, String(run.get('run')), targets));
  }
  // The template's model key stands for the config's; the rest of the env, such as the emulator's E2E_DEVICE, stays.
  const kept = (run.get('env') as YAMLMap | undefined)?.items.filter((pair) => isScalar(pair.key) && pair.key.value !== TEMPLATE_SECRET) ?? [];
  const env = doc.createNode(Object.fromEntries(context.secrets.map((name) => [name, `\${{ secrets.${name} }}`]))) as YAMLMap;
  env.items.push(...kept);
  if (env.items.length === 0) run.delete('env');
  else run.set('env', env);

  if (context.projectDir !== '') {
    const upload = findItem(steps, 'name', (name) => name === 'Upload the report').get('with') as YAMLMap;
    const paths = upload.get('path', true) as Scalar<string>;
    paths.value = paths.value.split('\n').map((line) => (line === '' ? line : join(context.projectDir, line))).join('\n');
  }
}

/** The model key the templates read, which the config's own keys replace. */
const TEMPLATE_SECRET = 'AI_GATEWAY_API_KEY';

/** Replaces a mobile job's build step with the project's build, and the comment above it. */
function setGithubBuild(job: YAMLMap, build: { comment: string; lines: string[] }): void {
  const step = findItem((job.get('steps') as YAMLSeq).items, 'name', (name) => name === 'Build the app');
  step.commentBefore = build.comment;
  step.set('run', build.lines.join('\n') + (build.lines.length > 1 ? '\n' : ''));
}

/**
 * The GitHub Actions workflow: one job per platform in `context.jobs`, on
 * pull requests and on pushes to main. The template holds all three; a
 * platform with no targets loses its job.
 */
export function renderGithubWorkflow(context: WorkflowContext): string {
  const doc = readTemplate('github-actions.yml');
  const jobs = doc.get('jobs') as YAMLMap;
  const byName = (job: YAMLMap, name: string): YAMLMap => findItem((job.get('steps') as YAMLSeq).items, 'name', (value) => value === name);

  for (const platform of ['web', 'ios', 'android'] as const) {
    if (context.jobs[platform] === undefined) jobs.delete(platform);
    else setUpGithubJob(doc, jobs.get(platform) as YAMLMap, context);
  }
  // The first job left keeps no blank line from the one it followed in the template.
  const firstJob = jobs.items[0]?.key;
  if (isScalar(firstJob)) firstJob.spaceBefore = false;
  if (context.jobs.web !== undefined) {
    const job = jobs.get('web') as YAMLMap;
    const browsers = byName(job, 'Install browsers');
    browsers.set('run', templateCommand(context.manager, String(browsers.get('run'))));
    finishGithubJob(doc, job, context, byName(job, 'Run e2e'), context.jobs.web);
  }
  if (context.jobs.ios !== undefined) {
    const job = jobs.get('ios') as YAMLMap;
    setGithubBuild(job, iosBuild(context.manager, context.jobs.ios.build));
    finishGithubJob(doc, job, context, byName(job, 'Run e2e'), context.jobs.ios.targets);
  }
  if (context.jobs.android !== undefined) {
    const job = jobs.get('android') as YAMLMap;
    setGithubBuild(job, androidBuild(context.manager, context.jobs.android.build));
    finishGithubJob(doc, job, context, byName(job, 'Run e2e'), context.jobs.android.targets);
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
 * A mobile job's script on a self-managed shell runner: install, build, then
 * the template's own device lines, with the run pointed at the job's targets.
 * Paths stay relative to the project, which the script changes into.
 */
function gitlabMobileScript(doc: Document, job: YAMLMap, context: WorkflowContext, build: { comment: string; lines: string[] }, targets: readonly string[]): void {
  const { manager, projectDir, installDir } = context;
  const cd = (dir: string): string[] => (dir === '' ? [] : [`cd "$CI_PROJECT_DIR/${dir}"`]);
  const script = job.get('script') as YAMLSeq<Scalar<string>>;
  // The template's lines after its Expo build: the device, the app's install, and the run.
  const lastBuildLine = script.items.findLastIndex((item) => /\bnpx expo |gradlew/u.test(String(item.value)));
  const device = script.items.slice(lastBuildLine + 1);
  const lines = doc.createNode([
    ...cd(installDir),
    frozenInstall(manager, context.yarnBerry === true),
    ...(installDir === projectDir ? [] : projectDir === '' ? ['cd "$CI_PROJECT_DIR"'] : cd(projectDir)),
    ...build.lines,
  ]) as YAMLSeq<Scalar<string>>;
  lines.items[lines.items.length - build.lines.length]!.commentBefore = build.comment;
  for (const item of device) {
    if (String(item.value).startsWith('npx ')) item.value = templateCommand(manager, item.value, targets);
  }
  lines.items.push(...device);
  job.set('script', lines);
}

/**
 * The GitLab CI/CD pipeline: one job per platform in `context.jobs`, in
 * merge request pipelines and on the default branch. The web job runs in a
 * `node` image on GitLab's runners; the mobile jobs need self-managed ones.
 * The rules sit on the jobs, not in a `workflow:` block, so the same file
 * works as `.gitlab-ci.yml` and as a file another pipeline includes.
 */
export function renderGitlabPipeline(context: WorkflowContext): string {
  const { manager, projectDir, installDir } = context;
  const doc = readTemplate('gitlab-ci.yml');
  const root = doc.contents as YAMLMap;
  const cd = (dir: string): string[] => (dir === '' ? [] : [`cd "$CI_PROJECT_DIR/${dir}"`]);
  const prefixed = (seq: YAMLSeq<Scalar<string>>) => {
    for (const item of seq.items) item.value = join(projectDir, item.value);
  };

  if (context.jobs.web === undefined) {
    root.delete('e2e-web');
  } else {
    const job = root.get('e2e-web') as YAMLMap;
    // Yarn 2 and later keep their own cache and ignore --cache-folder.
    const store = manager === 'yarn' && context.yarnBerry === true ? undefined : GITLAB_STORE[manager];
    const usesCorepack = (manager === 'pnpm' && context.pnpmVersion === undefined) || (manager === 'yarn' && context.yarnBerry === true);
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
      templateCommand(manager, browsers!.value),
      templateCommand(manager, run!.value, context.jobs.web),
    ]));
    if (projectDir !== '') {
      prefixed(job.getIn(['artifacts', 'paths']) as YAMLSeq<Scalar<string>>);
      const junit = job.getIn(['artifacts', 'reports', 'junit'], true) as Scalar<string>;
      junit.value = join(projectDir, junit.value);
    }
  }

  if (context.jobs.ios === undefined) root.delete('e2e-ios');
  else gitlabMobileScript(doc, root.get('e2e-ios') as YAMLMap, context, iosBuild(manager, context.jobs.ios.build), context.jobs.ios.targets);
  if (context.jobs.android === undefined) root.delete('e2e-android');
  else gitlabMobileScript(doc, root.get('e2e-android') as YAMLMap, context, androidBuild(manager, context.jobs.android.build), context.jobs.android.targets);
  if (context.jobs.ios === undefined && context.jobs.android === undefined) {
    root.delete('.e2e-mobile');
  } else if (projectDir !== '') {
    const mobile = root.get('.e2e-mobile') as YAMLMap;
    prefixed(mobile.getIn(['artifacts', 'paths']) as YAMLSeq<Scalar<string>>);
    const junit = mobile.getIn(['artifacts', 'reports', 'junit'], true) as Scalar<string>;
    junit.value = join(projectDir, junit.value);
  }

  const firstJob = root.items[0]?.key;
  if (isScalar(firstJob)) firstJob.spaceBefore = false;
  if (context.jobSuffix !== undefined) {
    for (const pair of root.items) {
      if (isScalar(pair.key)) pair.key.value = `${String(pair.key.value)}${context.jobSuffix}`;
      const extended = isMap(pair.value) ? pair.value.get('extends', true) : undefined;
      if (isScalar(extended)) extended.value = `${String(extended.value)}${context.jobSuffix}`;
    }
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
