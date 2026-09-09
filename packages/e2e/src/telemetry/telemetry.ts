/**
 * Anonymous usage telemetry for the CLI.
 *
 * One instance lives for one CLI invocation. Commands hand it events; at the
 * end of the invocation `flush` sends them in a single bounded request, so a
 * command never waits on telemetry for more than the flush budget and never
 * fails because of it. Telemetry is a CLI concern only: the runner never
 * constructs this class.
 *
 * Off means off at every step. `E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, an
 * `e2e telemetry disable`, or a preferences directory that cannot be written
 * each stop events from being queued, and `flush` reads the preferences file
 * again before sending, so a choice saved from another terminal while the
 * command ran wins too. `E2E_TELEMETRY_DEBUG` prints every event to stderr
 * instead of sending it, so anyone can read exactly what would have left the
 * machine.
 *
 * Identity is deliberately weak: a random per-machine id from the preferences
 * file, a random per-invocation session id, and a hashed project id. In CI
 * there is no preferences file and every run is attributed to the CI vendor,
 * so a fleet of ephemeral runners does not masquerade as a crowd of users.
 */

import { randomBytes } from 'node:crypto';
import picocolors from 'picocolors';
import { DOCS_URL } from '../cli/docs-url.ts';
import { isCiMode } from '../config/resolve.ts';
import { envFlag } from '../internal/env.ts';
import { timestamp } from '../internal/ids.ts';
import { ciName, collectEnvironment } from './environment.ts';
import type { TelemetryEvent } from './events.ts';
import { postBatch, type PostHogEvent } from './posthog.ts';
import { anonymousProjectId } from './project.ts';
import { preferencesPath, TelemetryStore, telemetryConfigDir } from './store.ts';

/** Bumped when what is collected changes enough that the notice must show again. */
export const NOTICE_VERSION = 1;
/** The longest a flush may hold the process; the project lookup and the request share it. */
const DEFAULT_FLUSH_MS = 2_000;

export type TelemetryDisabledBy = 'E2E_TELEMETRY_DISABLED' | 'DO_NOT_TRACK' | 'preference' | 'store';

export interface TelemetryOptions {
  /** The e2e version, sent with every event. */
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The project directory the command runs in; hashed into the project id, never sent. */
  readonly cwd?: string;
  /** Where the preferences file lives; the platform default when absent. */
  readonly configDir?: string;
  readonly fetch?: typeof fetch;
  /** Where the notice and the debug output go; stderr when absent. */
  readonly write?: (text: string) => void;
  /** Resolves the anonymous project id; git and the salted path when absent. */
  readonly projectId?: typeof anonymousProjectId;
}

/** The one-time notice: what is collected, and the two ways out. */
function noticeText(): string {
  return [
    `${picocolors.bold('e2e collects anonymous usage telemetry')} to improve the framework: the command, the versions, the OS, and run counts. Never test names, app data, or credentials.`,
    `Opt out with ${picocolors.cyan('e2e telemetry disable')} or ${picocolors.cyan('E2E_TELEMETRY_DISABLED=1')}. What is sent: ${picocolors.underline(`${DOCS_URL}/telemetry`)}`,
    '',
    '',
  ].join('\n');
}

/** Resolves to undefined when the signal aborts; whatever loses a race against it is abandoned. */
function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
}

export class Telemetry {
  /** Random per-invocation id, so one invocation's events can be grouped. */
  readonly sessionId = randomBytes(16).toString('hex');

  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly configDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly write: (text: string) => void;
  private readonly projectId: typeof anonymousProjectId;
  private readonly ci: boolean;
  /** The store once `store()` opened it, whether or not the file could exist. */
  private opened: { readonly store: TelemetryStore | undefined } | undefined;
  private readonly queue: TelemetryEvent[] = [];
  private project: Promise<string | undefined> | undefined;

  constructor(options: TelemetryOptions) {
    this.version = options.version;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.configDir = options.configDir ?? telemetryConfigDir(this.env);
    this.fetchImpl = options.fetch ?? fetch;
    this.write = options.write ?? ((text) => void process.stderr.write(text));
    this.projectId = options.projectId ?? anonymousProjectId;
    this.ci = isCiMode(this.env);
  }

  /** Opened on first use, so `--version` and `--help` never touch the disk; undefined when the file cannot exist. */
  private store(): TelemetryStore | undefined {
    this.opened ??= { store: TelemetryStore.open(this.configDir) };
    return this.opened.store;
  }

  /** Why telemetry is off, or undefined when it is on. */
  get disabledBy(): TelemetryDisabledBy | undefined {
    if (envFlag(this.env, 'E2E_TELEMETRY_DISABLED')) return 'E2E_TELEMETRY_DISABLED';
    if (envFlag(this.env, 'DO_NOT_TRACK')) return 'DO_NOT_TRACK';
    if (this.ci) return undefined;
    const store: TelemetryStore | undefined = this.store();
    if (store === undefined) return 'store';
    return store.enabled ? undefined : 'preference';
  }

  get enabled(): boolean {
    return this.disabledBy === undefined;
  }

  /** `E2E_TELEMETRY_DEBUG`: print every event, send nothing. */
  get debug(): boolean {
    return envFlag(this.env, 'E2E_TELEMETRY_DEBUG');
  }

  /** The preferences file, whether or not it exists yet. */
  get preferencesPath(): string {
    return preferencesPath(this.configDir);
  }

  /**
   * Saves the user's choice. Returns the file it was saved to, or undefined
   * when the file could not be written, in which case telemetry is off anyway
   * because there is no store to attribute events with.
   */
  setEnabled(value: boolean): string | undefined {
    const store: TelemetryStore | undefined = this.store();
    if (store === undefined) return undefined;
    return store.saveEnabled(value) ? store.path : undefined;
  }

  /**
   * Prints the notice the first time this machine runs a version of it, and
   * records that it did. Nothing in CI, where the output is a log nobody is
   * reading and there is no file to remember it in; nothing when off.
   */
  notice(): void {
    if (this.ci || !this.enabled) return;
    const store: TelemetryStore | undefined = this.store();
    if (store === undefined || store.wasNotified(NOTICE_VERSION)) return;
    store.markNotified(NOTICE_VERSION, timestamp());
    this.write(noticeText());
  }

  /** Queues one event for the flush; a no-op when off. */
  record(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.queue.push(event);
    // Git is asked for the project id now, while the command runs, so the
    // flush at the end waits on the network alone. In CI there is no store,
    // so a path outside git has nothing to salt it and yields no id.
    const store: TelemetryStore | undefined = this.ci ? undefined : this.store();
    this.project ??= this.projectId(this.cwd, store?.pathSalt);
  }

  /**
   * Sends everything queued in one request, or prints it under debug. One
   * deadline covers the project lookup still running and the request; a
   * lost batch is the accepted cost of a command that never waits on
   * telemetry.
   */
  async flush(maxWaitMs: number = DEFAULT_FLUSH_MS): Promise<void> {
    const events = this.queue.splice(0);
    if (events.length === 0) return;
    // A choice saved from another process while this command ran wins over the snapshot taken at its start.
    const store: TelemetryStore | undefined = this.ci ? undefined : this.store();
    store?.reload();
    if (!this.enabled) return;
    const deadline = AbortSignal.timeout(maxWaitMs);
    const project = await Promise.race([this.project, aborted(deadline)]);
    // Outside CI, `enabled` has just vouched for the store; no store means a CI run, attributed to the vendor.
    const distinctId = store === undefined ? `ci:${ciName(this.env) ?? 'unknown'}` : store.anonymousId;
    const environment = collectEnvironment({ env: this.env, cwd: this.cwd, version: this.version });
    // The debug output and the request body are the same objects, so what
    // `E2E_TELEMETRY_DEBUG` shows is what would have been sent, key for key.
    const items: PostHogEvent[] = events.map((event) => ({
      event: event.name,
      timestamp: event.at ?? timestamp(),
      properties: {
        ...environment,
        ...event.properties,
        distinct_id: distinctId,
        project_id: project ?? null,
        session_id: this.sessionId,
        $lib: 'e2e',
        $lib_version: this.version,
        // Anonymous events: PostHog keeps no person profile for the id.
        $process_person_profile: false,
      },
    }));
    if (this.debug) {
      for (const item of items) this.write(`[telemetry] ${JSON.stringify(item)}\n`);
      return;
    }
    await postBatch(items, { signal: deadline, fetch: this.fetchImpl });
  }
}
