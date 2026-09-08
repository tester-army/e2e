/**
 * The anonymous machine facts every event carries: platform, architecture,
 * resource class, container, CI vendor, the coding agent driving the shell,
 * and the runtime versions. Each field is a closed enumeration, a number, or
 * a version string; none is a path, a hostname, a username, or a value read
 * from the project.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { isCiMode } from '../config/resolve.ts';
import { envValue } from '../internal/env.ts';
import { detectPackageManager } from '../internal/package-manager.ts';

export interface TelemetryEnvironment {
  readonly os: NodeJS.Platform;
  readonly os_release: string;
  readonly arch: string;
  readonly cpu_count: number;
  readonly memory_gb: number;
  readonly docker: boolean;
  readonly wsl: boolean;
  readonly tty: boolean;
  readonly ci: boolean;
  /** The CI vendor, `unknown` for a `CI` variable nobody claims, null outside CI. */
  readonly ci_name: string | null;
  /** The coding agent whose shell ran the command, when one announces itself. */
  readonly coding_agent: string | null;
  readonly node_version: string;
  readonly package_manager: string;
  readonly e2e_version: string;
}

/** Environment variables a CI vendor sets, and the name we report for it. */
const CI_VENDORS: readonly (readonly [variable: string, name: string])[] = [
  ['GITHUB_ACTIONS', 'github-actions'],
  ['GITLAB_CI', 'gitlab'],
  ['CIRCLECI', 'circleci'],
  ['BUILDKITE', 'buildkite'],
  ['JENKINS_URL', 'jenkins'],
  ['TRAVIS', 'travis'],
  ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
  ['TF_BUILD', 'azure-pipelines'],
  ['TEAMCITY_VERSION', 'teamcity'],
  ['CODEBUILD_BUILD_ID', 'aws-codebuild'],
  ['VERCEL', 'vercel'],
  ['NETLIFY', 'netlify'],
  ['DRONE', 'drone'],
  ['SEMAPHORE', 'semaphore'],
  ['APPVEYOR', 'appveyor'],
  ['WOODPECKER', 'woodpecker'],
];

/**
 * Environment variables coding agents set in the shells they spawn. The
 * markers are the ones `@vercel/detect-agent` checks; the value never matters,
 * only that the variable is set.
 */
const CODING_AGENTS: readonly (readonly [variable: string, name: string])[] = [
  ['CLAUDECODE', 'claude-code'],
  ['CLAUDE_CODE', 'claude-code'],
  ['CURSOR_AGENT', 'cursor'],
  ['CURSOR_TRACE_ID', 'cursor'],
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_THREAD_ID', 'codex'],
  ['CODEX_CI', 'codex'],
  ['GEMINI_CLI', 'gemini-cli'],
  ['COPILOT_GITHUB_TOKEN', 'copilot'],
  ['COPILOT_MODEL', 'copilot'],
  ['COPILOT_ALLOW_ALL', 'copilot'],
  ['OPENCODE_CLIENT', 'opencode'],
  ['AUGMENT_AGENT', 'augment'],
  ['ANTIGRAVITY_AGENT', 'antigravity'],
  ['REPL_ID', 'replit'],
  ['AI_AGENT', 'other'],
];

/** The name paired with the first marker variable that is set. */
function firstMarker(env: NodeJS.ProcessEnv, markers: readonly (readonly [string, string])[]): string | undefined {
  return markers.find(([variable]) => envValue(env, variable) !== undefined)?.[1];
}

/** The first vendor whose marker is set; `unknown` when only `CI` is. */
export function ciName(env: NodeJS.ProcessEnv): string | null {
  return firstMarker(env, CI_VENDORS) ?? (isCiMode(env) ? 'unknown' : null);
}

function inDocker(): boolean {
  if (existsSync('/.dockerenv')) return true;
  try {
    return readFileSync('/proc/1/cgroup', 'utf8').includes('docker');
  } catch {
    return false;
  }
}

function inWsl(env: NodeJS.ProcessEnv, release: string): boolean {
  return envValue(env, 'WSL_DISTRO_NAME') !== undefined || release.toLowerCase().includes('microsoft');
}

export function collectEnvironment(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly version: string;
}): TelemetryEnvironment {
  const { env } = options;
  const release = os.release();
  return {
    os: os.platform(),
    os_release: release,
    arch: os.arch(),
    cpu_count: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30),
    docker: inDocker(),
    wsl: inWsl(env, release),
    tty: process.stdout.isTTY === true,
    ci: isCiMode(env),
    ci_name: ciName(env),
    coding_agent: firstMarker(env, CODING_AGENTS) ?? null,
    node_version: process.versions.node,
    package_manager: detectPackageManager(options.cwd, undefined, env),
    e2e_version: options.version,
  };
}
