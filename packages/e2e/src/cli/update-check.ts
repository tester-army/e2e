/**
 * The upgrade notice: after a command on a terminal, two lines naming a newer
 * e2e release and the `e2e upgrade` command that installs it. The registry is asked at most
 * once a day, in the background while the command runs, and the answer is kept
 * in `update-check.json` beside the telemetry preferences, so every command in
 * between reminds without a request. Nothing in CI, from a source checkout,
 * off a terminal, or with `E2E_UPDATE_CHECK_DISABLED`, `NO_UPDATE_NOTIFIER`,
 * or one of the telemetry opt-outs set: the request is not needed to run.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picocolors from 'picocolors';
import { isCiMode } from '../config/resolve.ts';
import { writeFileAtomicSync } from '../internal/atomic-write.ts';
import { envFlag } from '../internal/env.ts';
import { detectWorkspacePackageManager, execCommand, readPackageManifest } from '../internal/package-manager.ts';
import { isPlainObject } from '../internal/options.ts';
import { isRelease, latestRelease, olderThan } from '../internal/release.ts';
import { telemetryConfigDir } from '../telemetry/store.ts';

const FILE_NAME = 'update-check.json';
const CHECK_INTERVAL_MS = 86_400_000;
/** The longest the check may hold the process after the command, once a day at most. */
const FETCH_TIMEOUT_MS = 1_500;
const CHANGELOG_URL = 'https://github.com/tester-army/e2e/blob/main/packages/e2e/CHANGELOG.md';
/**
 * `mcp` speaks JSON-RPC on stdio to a client, not to a person. `upgrade` is
 * the step the notice asks for; the version running it is the old one.
 */
const SILENT_COMMANDS: ReadonlySet<string> = new Set(['mcp', 'upgrade']);

interface CheckRecord {
  readonly checkedAt: number;
  readonly latest?: string;
}

export interface UpdateCheckOptions {
  /** The installed e2e version. */
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether the CLI runs from a source checkout of the repository, where nothing is checked. */
  readonly checkout?: boolean;
  /** Whether a person reads stderr; `process.stderr.isTTY` when absent. */
  readonly interactive?: boolean;
  /** Where the record lives; the telemetry config directory when absent. */
  readonly configDir?: string;
  /** The project directory, whose package manager the install command names. */
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
  /** Where the notice goes; stderr when absent. */
  readonly write?: (text: string) => void;
  readonly now?: () => number;
}

/** The record in the file, or undefined when it is missing or malformed. */
function readRecord(filePath: string): CheckRecord | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isPlainObject(raw)) return undefined;
    const { checkedAt, latest } = raw;
    if (typeof checkedAt !== 'number') return undefined;
    return typeof latest === 'string' && isRelease(latest) ? { checkedAt, latest } : { checkedAt };
  } catch {
    return undefined;
  }
}

/**
 * `e2e upgrade`, run through the package manager of the package it would
 * upgrade: the nearest one at or above `cwd` that lists e2e, else the nearest
 * one (its workspace's manager, for a workspace member).
 */
function upgradeCommand(cwd: string, env: NodeJS.ProcessEnv): string {
  let nearest: string | undefined;
  let project: string | undefined;
  for (let dir = cwd; project === undefined; dir = path.dirname(dir)) {
    const manifest = readPackageManifest(dir);
    if (manifest !== undefined) nearest ??= dir;
    if (manifest !== undefined && DEPENDENCY_SECTIONS.some((section) => isPlainObject(manifest[section]) && manifest[section]['e2e'] !== undefined)) project = dir;
    if (path.dirname(dir) === dir) break;
  }
  return execCommand(detectWorkspacePackageManager(project ?? nearest ?? cwd, env).manager, 'e2e upgrade');
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;


export class UpdateCheck {
  private readonly options: UpdateCheckOptions;
  private readonly enabled: boolean;
  private started = false;
  private latest: string | undefined;
  private pending: Promise<void> | undefined;

  constructor(options: UpdateCheckOptions) {
    this.options = options;
    const env = options.env ?? process.env;
    this.enabled =
      options.checkout !== true &&
      (options.interactive ?? process.stderr.isTTY === true) &&
      !isCiMode(env) &&
      !['E2E_UPDATE_CHECK_DISABLED', 'NO_UPDATE_NOTIFIER', 'E2E_TELEMETRY_DISABLED', 'DO_NOT_TRACK'].some((name) =>
        envFlag(env, name),
      );
  }

  private get filePath(): string {
    return path.join(this.options.configDir ?? telemetryConfigDir(this.options.env), FILE_NAME);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Reads the last answer for `command`, and asks the registry again in the
   * background when that answer is a day old or missing. A no-op when off.
   */
  start(command: string): void {
    if (!this.enabled || this.started || SILENT_COMMANDS.has(command)) return;
    this.started = true;
    const record = readRecord(this.filePath);
    this.latest = record?.latest;
    if (record === undefined || this.now() - record.checkedAt >= CHECK_INTERVAL_MS) this.pending = this.refresh();
  }

  /**
   * Asks the registry and saves the answer. A failed request is saved as a
   * check too, so an offline machine waits a day before the next one.
   */
  private async refresh(): Promise<void> {
    const latest = (await latestRelease(this.options.fetch ?? fetch, FETCH_TIMEOUT_MS)) ?? this.latest;
    this.latest = latest;
    const record: CheckRecord = latest === undefined ? { checkedAt: this.now() } : { checkedAt: this.now(), latest };
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileAtomicSync(this.filePath, `${JSON.stringify(record)}\n`);
    } catch {
      // An unwritable directory only means the next command asks again.
    }
  }

  /** Prints the notice when a newer release is known; waits for a check still in flight. */
  async notify(): Promise<void> {
    if (!this.started) return;
    await this.pending;
    const latest = this.latest;
    if (latest === undefined || !olderThan(this.options.version, latest)) return;
    const install = upgradeCommand(this.options.cwd ?? process.cwd(), this.options.env ?? process.env);
    const write = this.options.write ?? ((text: string) => void process.stderr.write(text));
    write(
      [
        '',
        `${picocolors.yellow('Update available')} ${picocolors.dim(this.options.version)} → ${picocolors.green(latest)}`,
        `Run ${picocolors.cyan(install)} to update. Changelog: ${picocolors.underline(CHANGELOG_URL)}`,
        '',
      ].join('\n'),
    );
  }
}
