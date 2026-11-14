import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  ciJobs,
  configStartsApp,
  configTargets,
  configUsesLocalModel,
  detectMobileBuilds,
  findNodeVersionFile,
  findRepositoryRoot,
  gatewaysInConfig,
  detectCiService,
  getCiService,
  readNodeMajor,
  renderGithubWorkflow,
  renderGitlabPipeline,
  type CiJobs,
  type WorkflowContext,
} from '../../src/cli/init/ci.ts';

const base: WorkflowContext = { manager: 'npm', projectDir: '', installDir: '', secrets: [], jobs: { web: 'all' } };

/** Expo on both phones beside a web target: the template's own case. */
const expoJobs: CiJobs = {
  web: ['web'],
  ios: { targets: ['ios'], build: { kind: 'expo' } },
  android: { targets: ['android'], build: { kind: 'expo', prebuild: true } },
};

/** One step or job of a rendered pipeline, as YAML reads it. */
type Node = Record<string, unknown>;

/** A rendered GitHub workflow's job and its steps. */
function githubJob(text: string, name = 'web'): { job: Node; steps: Node[]; step: (name: string) => Node; uses: (action: string) => Node | undefined } {
  const job = (parse(text) as { jobs: Record<string, Node> }).jobs[name]!;
  const steps = job['steps'] as Node[];
  return {
    job,
    steps,
    step: (stepName) => steps.find((step) => step['name'] === stepName)!,
    uses: (action) => steps.find((step) => String(step['uses']).startsWith(`${action}@`)),
  };
}

/** The templates as shipped, read the way init reads them. */
const templates = path.resolve(import.meta.dirname, '../../templates/ci');

describe('renderGithubWorkflow', () => {
  it('writes the template unchanged for npm at the repository root, Expo on both phones, and the model key from secrets', () => {
    expect(renderGithubWorkflow({ ...base, secrets: ['AI_GATEWAY_API_KEY'], jobs: expoJobs })).toBe(readFileSync(path.join(templates, 'github-actions.yml'), 'utf8'));
  });

  it('writes only the web job, running every target, when the config has no phone target', () => {
    const workflow = parse(renderGithubWorkflow(base)) as { jobs: Record<string, Node> };
    expect(Object.keys(workflow.jobs)).toEqual(['web']);
    expect(githubJob(renderGithubWorkflow(base)).step('Run e2e')['run']).toBe('npx e2e run --reporter list,junit');
  });

  it('writes only the phone jobs for a mobile-only config, each naming its targets', () => {
    const workflow = renderGithubWorkflow({ ...base, jobs: { ios: { targets: ['iphone', 'ipad'], build: { kind: 'expo' } }, android: expoJobs.android! } });
    expect(Object.keys((parse(workflow) as { jobs: object }).jobs)).toEqual(['ios', 'android']);
    // No line of only spaces where the web job was.
    expect(workflow).toContain('jobs:\n  ios:\n');
    expect(workflow).not.toMatch(/^ +$/mu);
    // The emulator's E2E_DEVICE stays when there is no model key to pass.
    expect(githubJob(workflow, 'android').step('Run e2e')['env']).toEqual({ E2E_DEVICE: 'emulator-5554' });
    expect(githubJob(workflow, 'ios').step('Run e2e')['run']).toBe('npx e2e run --target iphone,ipad --workers 1 --reporter list,junit');
    expect((githubJob(workflow, 'android').step('Run e2e')['with'] as Node)['script']).toBe(
      'adb install -r android/app/build/outputs/apk/release/app-release.apk\nnpx e2e run --target android --workers 1 --reporter list,junit\n',
    );
  });

  it('runs the web job on every target off the phones when a config has both', () => {
    const workflow = renderGithubWorkflow({ ...base, jobs: { ...expoJobs, web: ['web', 'api'] } });
    expect(githubJob(workflow).step('Run e2e')['run']).toBe('npx e2e run --target web,api --reporter list,junit');
  });

  it('builds a bare React Native app with its workspace, through Bundler when it has a Gemfile', () => {
    const workflow = renderGithubWorkflow({ ...base, jobs: {
      ios: { targets: ['ios'], build: { kind: 'react-native', workspace: 'MyApp', bundler: true } },
      android: { targets: ['android'], build: { kind: 'react-native' } },
    } });
    expect(githubJob(workflow, 'ios').step('Build the app')['run']).toBe(
      "bundle install\n(cd ios && bundle exec pod install)\nxcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build\n",
    );
    expect(githubJob(workflow, 'android').step('Build the app')['run']).toBe('(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64)');
    expect(workflow).toContain('      # Installs the pods, then builds the workspace for the simulator into build/.\n      - name: Build the app\n');
  });

  it('skips Expo prebuild when android/ is already there', () => {
    const workflow = renderGithubWorkflow({ ...base, jobs: { android: { targets: ['android'], build: { kind: 'expo', prebuild: false } } } });
    expect(githubJob(workflow, 'android').step('Build the app')['run']).toBe('(cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64)');
  });

  it('writes a build step that fails until it is replaced for any other app, saying where the build goes', () => {
    const workflow = renderGithubWorkflow({ ...base, jobs: { ios: { targets: ['ios'], build: { kind: 'custom' } }, android: { targets: ['android'], build: { kind: 'custom' } } } });
    expect(githubJob(workflow, 'ios').step('Build the app')['run']).toBe('echo "Replace this step with your app\'s build for the simulator, with the .app under build/" >&2\nexit 1\n');
    expect(workflow).toContain("      # Replace this step with your app's release build, an APK at android/app/build/outputs/apk/release/app-release.apk.\n");
  });

  it('keeps the template comments and pinned tags', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'pnpm', pnpmVersion: '10' });
    expect(workflow).toMatch(/^# Written by `e2e init --ci github-actions`/u);
    expect(workflow).toContain('    branches: [main]\n');
    expect(workflow).toMatch(/uses: pnpm\/action-setup@[0-9a-f]{40} # v\d/u);
  });

  it('sets no env block when the run reads no key', () => {
    expect(githubJob(renderGithubWorkflow(base)).step('Run e2e')).not.toHaveProperty('env');
    expect(githubJob(renderGithubWorkflow({ ...base, jobs: expoJobs }), 'ios').step('Run e2e')).not.toHaveProperty('env');
  });

  it('sets up every job for a workspace member: its folder, the install at the workspace root, and the cache keys', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'pnpm', projectDir: 'apps/app', installDir: '', pnpmVersion: '10', jobs: expoJobs });
    for (const name of ['web', 'ios', 'android']) {
      const { job, step, uses } = githubJob(workflow, name);
      expect(job['defaults']).toEqual({ run: { 'working-directory': 'apps/app' } });
      expect(Object.keys(job).indexOf('defaults')).toBe(Object.keys(job).indexOf('steps') - 1);
      expect(uses('pnpm/action-setup')?.['with']).toEqual({ version: '10' });
      expect(step('Install dependencies')).toEqual({ name: 'Install dependencies', run: 'pnpm install --frozen-lockfile', 'working-directory': '.' });
      expect((step('Upload the report')['with'] as Node)['path']).toBe('apps/app/.e2e/report.json\napps/app/.e2e/junit.xml\napps/app/.e2e/results\n');
      expect(workflow).not.toContain("hashFiles('package-lock.json')");
    }
    // The emulator action runs its script from the project, which defaults.run does not reach.
    expect((githubJob(workflow, 'android').step('Run e2e')['with'] as Node)['working-directory']).toBe('apps/app');
    expect(githubJob(workflow, 'ios').step('Build the app')['run']).toBe('pnpm exec expo run:ios --configuration Release --device generic --no-bundler --output build/ios');
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
    expect(uses('oven-sh/setup-bun')).not.toHaveProperty('with');
    const below = githubJob(renderGithubWorkflow({ ...base, manager: 'bun', projectDir: 'site', installDir: 'site' }));
    expect(below.uses('oven-sh/setup-bun')?.['with']).toEqual({ 'bun-version-file': 'site/package.json' });
  });

  it('keys the caches on Bun\'s older bun.lockb when that is the lockfile', () => {
    const workflow = renderGithubWorkflow({ ...base, manager: 'bun', lockfile: 'bun.lockb', jobs: expoJobs });
    expect(workflow).toContain("hashFiles('bun.lockb')");
    expect(workflow).not.toContain("hashFiles('bun.lock')");
    expect((gitlabJob(renderGitlabPipeline({ ...base, manager: 'bun', lockfile: 'bun.lockb' }))['cache'] as Node)['key']).toEqual({ files: ['bun.lockb'] });
  });

  it('keeps a folder name with a space as one value', () => {
    expect(githubJob(renderGithubWorkflow({ ...base, projectDir: 'my app', installDir: 'my app' })).job['defaults']).toEqual({ run: { 'working-directory': 'my app' } });
  });
});

/** A rendered GitLab pipeline's job. */
function gitlabJob(text: string, name = 'e2e-web'): Node {
  return (parse(text) as Record<string, Node>)[name]!;
}

describe('renderGitlabPipeline', () => {
  it('writes the template unchanged for npm at the repository root and Expo on both phones, with no key in the file', () => {
    // CI/CD variables reach the job's environment on their own; the file names no key.
    expect(renderGitlabPipeline({ ...base, secrets: ['AI_GATEWAY_API_KEY'], jobs: expoJobs })).toBe(readFileSync(path.join(templates, 'gitlab-ci.yml'), 'utf8'));
  });

  it('keeps the header and starts with no blank line when the pipeline has no web job', () => {
    const pipeline = renderGitlabPipeline({ ...base, jobs: { android: expoJobs.android! } });
    expect(pipeline).toMatch(/^# Written by `e2e init --ci gitlab`[^\n]*\n# the default branch, one job per platform\. See https:\/\/e2e\.com\/docs\/ci\/gitlab\n\n# GitLab's hosted runners/u);
    expect(Object.keys(parse(pipeline) as object)).toEqual(['.e2e-mobile', 'e2e-android']);
  });

  it('writes only the web job, without the mobile base or its comment, when the config has no phone target', () => {
    const pipeline = renderGitlabPipeline(base);
    expect(Object.keys(parse(pipeline) as object)).toEqual(['e2e-web']);
    expect(pipeline).not.toContain('self-managed');
    expect(gitlabJob(pipeline)['script']).toContain('npx e2e run --reporter list,junit');
  });

  it('runs the phone jobs on self-managed runners: install, build, a device of their own, then the targets', () => {
    const pipeline = renderGitlabPipeline({ ...base, jobs: { ios: { targets: ['iphone'], build: { kind: 'react-native', workspace: 'MyApp', bundler: false } }, android: { targets: ['android'], build: { kind: 'custom' } } } });
    expect(Object.keys(parse(pipeline) as object)).toEqual(['.e2e-mobile', 'e2e-ios', 'e2e-android']);
    const ios = gitlabJob(pipeline, 'e2e-ios');
    expect(ios['tags']).toEqual(['macos']);
    expect(ios['script']).toEqual([
      'npm ci',
      '(cd ios && pod install)',
      "xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build",
      'export E2E_DEVICE=$(xcrun simctl create "e2e-$CI_JOB_ID" "iPhone 17 Pro" com.apple.CoreSimulator.SimRuntime.iOS-26-5)',
      'echo "$E2E_DEVICE" > "$CI_PROJECT_DIR/.simulator-udid"',
      'xcrun simctl bootstatus "$E2E_DEVICE" -b',
      `xcrun simctl install "$E2E_DEVICE" "$(find build -maxdepth 5 -name '*.app' -type d | head -n 1)"`,
      'npx e2e run --target iphone --workers 1 --reporter list,junit',
    ]);
    const android = gitlabJob(pipeline, 'e2e-android')['script'] as string[];
    expect(android.slice(0, 3)).toEqual(['npm ci', 'echo "Replace this step with your app\'s build, an APK at android/app/build/outputs/apk/release/app-release.apk" >&2', 'exit 1']);
    expect(android.at(-1)).toBe('npx e2e run --target android --workers 1 --reporter list,junit');
    expect(pipeline).toContain("    # Replace this step with your app's release build, an APK at android/app/build/outputs/apk/release/app-release.apk.\n    - echo");
  });

  it('installs at the workspace root and runs in the project folder', () => {
    const pipeline = renderGitlabPipeline({ ...base, manager: 'pnpm', projectDir: 'apps/web', installDir: '', pnpmVersion: '10', nodeMajor: '26', jobs: expoJobs });
    const job = gitlabJob(pipeline);
    expect(job['image']).toBe('node:26');
    expect(job['script']).toEqual([
      'npm install --global pnpm@10',
      'pnpm config set store-dir .pnpm-store',
      'pnpm install --frozen-lockfile',
      'cd "$CI_PROJECT_DIR/apps/web"',
      'pnpm exec e2e-web install chromium --with-deps',
      'pnpm exec e2e run --target web --reporter list,junit',
    ]);
    expect(job['cache']).toEqual({ key: { files: ['pnpm-lock.yaml'] }, paths: ['.cache/ms-playwright/', '.pnpm-store/'] });
    expect(job['artifacts']).toMatchObject({
      paths: ['apps/web/.e2e/report.json', 'apps/web/.e2e/junit.xml', 'apps/web/.e2e/results/'],
      reports: { junit: 'apps/web/.e2e/junit.xml' },
    });
    expect(job['variables']).not.toHaveProperty('COREPACK_ENABLE_DOWNLOAD_PROMPT');
    expect((gitlabJob(pipeline, 'e2e-ios')['script'] as string[]).slice(0, 3)).toEqual([
      'pnpm install --frozen-lockfile',
      'cd "$CI_PROJECT_DIR/apps/web"',
      'pnpm exec expo run:ios --configuration Release --device generic --no-bundler --output build/ios',
    ]);
    expect(gitlabJob(pipeline, '.e2e-mobile')['artifacts']).toMatchObject({ reports: { junit: 'apps/web/.e2e/junit.xml' } });
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

  it('installs Bun into the node image and runs the web job beside a phone job', () => {
    const job = gitlabJob(renderGitlabPipeline({ ...base, manager: 'bun', jobs: { web: ['web'], ios: expoJobs.ios! } }));
    expect((job['script'] as string[]).slice(0, 2)).toEqual(['npm install --global bun', 'bun install --frozen-lockfile']);
    expect((job['script'] as string[]).at(-1)).toBe('bunx e2e run --target web --reporter list,junit');
    expect((job['cache'] as Node)['paths']).toEqual(['.cache/ms-playwright/']);
  });

  it('renames every job, and what the phone jobs extend, beside a pipeline that has one of the names', () => {
    const pipeline = renderGitlabPipeline({ ...base, jobs: expoJobs, jobSuffix: '-run' });
    expect(Object.keys(parse(pipeline) as object)).toEqual(['e2e-web-run', '.e2e-mobile-run', 'e2e-ios-run', 'e2e-android-run']);
    expect(gitlabJob(pipeline, 'e2e-ios-run')['extends']).toBe('.e2e-mobile-run');
    expect(pipeline).toMatch(/^# Written by `e2e init --ci gitlab`/u);
    expect(pipeline).toContain('    # GitLab caches only paths inside the project.\n');
  });
});

describe('ciJobs', () => {
  const builds = { ios: { kind: 'expo' }, android: { kind: 'expo', prebuild: true } } as const;

  it('gives each phone platform its job and runs everything else in the web job', () => {
    expect(ciJobs([{ name: 'web', platform: 'web' }], builds)).toEqual({ web: 'all' });
    expect(ciJobs([{ name: 'chromium', platform: 'web' }, { name: 'api', platform: 'custom' }, { name: 'iphone', platform: 'ios' }, { name: 'pixel', platform: 'android' }], builds)).toEqual({
      web: ['chromium', 'api'],
      ios: { targets: ['iphone'], build: builds.ios },
      android: { targets: ['pixel'], build: builds.android },
    });
    expect(ciJobs([{ name: 'ios', platform: 'ios' }, { name: 'ipad', platform: 'ios' }], builds)).toEqual({ ios: { targets: ['ios', 'ipad'], build: builds.ios } });
  });

  it('runs targets of other platforms, such as HTTP tests, in the web job, beside phone jobs too', () => {
    expect(ciJobs([{ name: 'default', platform: 'custom' }], builds)).toEqual({ web: 'all' });
    expect(ciJobs([{ name: 'api', platform: 'custom' }, { name: 'ios', platform: 'ios' }], builds)).toEqual({ web: ['api'], ios: { targets: ['ios'], build: builds.ios } });
    expect(ciJobs([], builds)).toEqual({});
  });
});

describe('configTargets', () => {
  it('names and places each target the way e2e run resolves it, leaving out a target it would refuse', () => {
    expect(configTargets({ targets: [
      { engine: { platform: 'web' } },
      { name: 'iphone', engine: { platform: 'ios' } },
      { name: 'api', platform: 'custom' },
      { name: 'unknown' },
      // A platform that contradicts its engine is a config error to e2e run.
      { name: 'mixed', platform: 'web', engine: { platform: 'ios' } },
    ] } as never)).toEqual([{ name: 'web', platform: 'web' }, { name: 'iphone', platform: 'ios' }, { name: 'api', platform: 'custom' }]);
    expect(configTargets({} as never)).toEqual([]);
  });
});

describe('detectMobileBuilds', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-builds-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds Expo with CNG, and skips prebuild when android/ is committed', () => {
    expect(detectMobileBuilds(dir, (name) => name === 'expo')).toEqual({ ios: { kind: 'expo' }, android: { kind: 'expo', prebuild: true } });
    mkdirSync(path.join(dir, 'android'));
    writeFileSync(path.join(dir, 'android', 'gradlew'), '');
    expect(detectMobileBuilds(dir, (name) => name === 'expo').android).toEqual({ kind: 'expo', prebuild: false });
  });

  it('builds bare React Native from its workspace and Gradle wrapper, else falls back to a step to replace', () => {
    const rn = (name: string) => name === 'react-native';
    expect(detectMobileBuilds(dir, rn)).toEqual({ ios: { kind: 'custom' }, android: { kind: 'custom' } });
    mkdirSync(path.join(dir, 'ios', 'MyApp.xcworkspace'), { recursive: true });
    mkdirSync(path.join(dir, 'ios', 'Pods.xcworkspace'));
    mkdirSync(path.join(dir, 'android'));
    writeFileSync(path.join(dir, 'android', 'gradlew'), '');
    writeFileSync(path.join(dir, 'Gemfile'), '');
    expect(detectMobileBuilds(dir, rn)).toEqual({ ios: { kind: 'react-native', workspace: 'MyApp', bundler: true }, android: { kind: 'react-native' } });
  });

  it('writes a step to replace for a native app', () => {
    expect(detectMobileBuilds(dir, () => false)).toEqual({ ios: { kind: 'custom' }, android: { kind: 'custom' } });
  });

  it('reads no workspace from an ios that is a file', () => {
    writeFileSync(path.join(dir, 'ios'), '');
    expect(detectMobileBuilds(dir, (name) => name === 'react-native').ios).toEqual({ kind: 'custom' });
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
    expect(gitlab.locate(dir).note).toBe('The e2e jobs run in the test stage; add test to the stages in .gitlab-ci.yml');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages:\n  - build\n  - test\nbuild:\n  script: [make]\n');
    expect(gitlab.locate(dir).note).toBeUndefined();
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'build:\n  script: [make]\n');
    expect(gitlab.locate(dir).note).toBeUndefined();
    // A stage whose name only contains test is another stage.
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages: [build, unit-test]\n');
    expect(gitlab.locate(dir).note).toBe('The e2e jobs run in the test stage; add test to the stages in .gitlab-ci.yml');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), "stages:\n  - 'build'\n  - \"test\" # unit and e2e\nvariables: {}\n");
    expect(gitlab.locate(dir).note).toBeUndefined();
  });

  it('renames the jobs beside a pipeline that already has a job of one of their names', () => {
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'e2e:\n  script: [npx cypress run]\n');
    expect(getCiService('gitlab').locate(dir)).not.toHaveProperty('jobSuffix');
    writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'e2e-ios:\n  script: [npx detox test]\n');
    expect(getCiService('gitlab').locate(dir)).toMatchObject({ file: '.gitlab/e2e.gitlab-ci.yml', jobSuffix: '-run' });
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
