/**
 * The anonymous machine facts every event carries: platform, architecture,
 * resource class, container, sandbox, CI vendor, the fleet running e2e on
 * someone's behalf, the coding agent driving the shell, and the runtime
 * versions. Each field is a closed enumeration, a number, a version string,
 * or a plain token; none is a path, a hostname, a username, or a value read
 * from the project.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { isCiMode } from '../config/resolve.ts';
import { envValue } from '../internal/env.ts';
import { detectPackageManager } from '../internal/package-manager.ts';
import { plainToken } from './token.ts';

export interface TelemetryEnvironment {
  readonly os: NodeJS.Platform;
  readonly os_release: string;
  readonly arch: string;
  readonly cpu_count: number;
  readonly memory_gb: number;
  readonly docker: boolean;
  readonly wsl: boolean;
  /** The microVM or sandbox the kernel announces itself as, when one does. */
  readonly sandbox: string | null;
  readonly tty: boolean;
  readonly ci: boolean;
  /** The CI vendor, `unknown` for a `CI` variable nobody claims, null outside CI. */
  readonly ci_name: string | null;
  /** The platform running e2e on a user's behalf, from `E2E_TELEMETRY_FLEET`; null on a person's machine. */
  readonly fleet: string | null;
  /** The coding agent whose shell ran the command, when one announces itself. */
  readonly coding_agent: string | null;
  /** The JavaScript runtime the CLI runs under; `node_version` is its Node compatibility version elsewhere. */
  readonly runtime: JsRuntime;
  readonly runtime_version: string;
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
  ['EAS_BUILD', 'eas'],
  ['BITRISE_IO', 'bitrise'],
  ['CM_BUILD_ID', 'codemagic'],
  ['CI_XCODE_CLOUD', 'xcode-cloud'],
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

export type JsRuntime = 'node' | 'bun' | 'deno';

/**
 * Kernel release fragments that name the sandbox a machine is: a Firecracker
 * microVM (Cloudflare Sandboxes, Fly Machines, Lambda) builds its own kernel
 * and says so. WSL is read separately; Docker by its files.
 */
const SANDBOXES: readonly (readonly [fragment: string, name: string])[] = [['firecracker', 'firecracker']];

/** The name paired with the first marker variable that is set. */
function firstMarker(env: NodeJS.ProcessEnv, markers: readonly (readonly [string, string])[]): string | undefined {
  return markers.find(([variable]) => envValue(env, variable) !== undefined)?.[1];
}

/** The first vendor whose marker is set; `unknown` when only `CI` is. */
function ciName(env: NodeJS.ProcessEnv): string | null {
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

/** The sandbox named in the kernel release, when one is. */
function sandboxName(release: string): string | null {
  const lower = release.toLowerCase();
  return SANDBOXES.find(([fragment]) => lower.includes(fragment))?.[1] ?? null;
}

/**
 * The platform that runs e2e for its users, when it says so. Every machine
 * of such a fleet is new and runs once, so left to itself it would count as
 * a new user; named, the fleet counts as one.
 */
export function fleetName(env: NodeJS.ProcessEnv): string | null {
  const value = envValue(env, 'E2E_TELEMETRY_FLEET')?.trim();
  return value === undefined ? null : plainToken(value);
}

/**
 * The id the environment states for itself, standing in for a machine that
 * has no preferences file: a fleet by its name, else the CI vendor when `CI`
 * is set. Undefined on a person's machine, where the random per-machine id
 * is the unit: a vendor marker without `CI` is a shell on a runner, and `CI`
 * with a coding agent but no vendor is the agent's shell on a laptop.
 */
export function statedIdentity(env: NodeJS.ProcessEnv): string | undefined {
  const fleet = fleetName(env);
  if (fleet !== null) return `fleet:${fleet}`;
  if (!isCiMode(env)) return undefined;
  const vendor = firstMarker(env, CI_VENDORS);
  if (vendor === undefined && firstMarker(env, CODING_AGENTS) !== undefined) return undefined;
  return `ci:${vendor ?? 'unknown'}`;
}

/** The runtime executing this process: Bun and Deno each announce themselves in `process.versions`. */
function runtime(versions: NodeJS.ProcessVersions): { readonly runtime: JsRuntime; readonly runtime_version: string } {
  const bun = versions['bun'];
  if (bun !== undefined) return { runtime: 'bun', runtime_version: bun };
  const deno = versions['deno'];
  if (deno !== undefined) return { runtime: 'deno', runtime_version: deno };
  return { runtime: 'node', runtime_version: versions.node };
}


export function collectEnvironment(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly version: string;
  /** The kernel release and runtime versions to describe; this machine's when absent. */
  readonly host?: { readonly release: string; readonly versions: NodeJS.ProcessVersions };
}): TelemetryEnvironment {
  const { env } = options;
  const { release, versions } = options.host ?? { release: os.release(), versions: process.versions };
  return {
    os: os.platform(),
    os_release: release,
    arch: os.arch(),
    cpu_count: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 2 ** 30),
    docker: inDocker(),
    wsl: inWsl(env, release),
    sandbox: sandboxName(release),
    tty: process.stdout.isTTY === true,
    ci: isCiMode(env),
    ci_name: ciName(env),
    fleet: fleetName(env),
    coding_agent: firstMarker(env, CODING_AGENTS) ?? null,
    ...runtime(versions),
    node_version: versions.node,
    package_manager: detectPackageManager(options.cwd, undefined, env),
    e2e_version: options.version,
  };
}
