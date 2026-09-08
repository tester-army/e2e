/**
 * Anonymous usage telemetry for the CLI.
 *
 * One instance lives for one CLI invocation. Commands hand it events; at the
 * end of the invocation `flush` sends them in a single bounded request, so a
 * command never waits on the network for more than the flush budget and never
 * fails because of it. Telemetry is a CLI concern only: a host embedding the
 * runner through `@e2edev/e2e/run` never constructs this class, and its runs
 * send nothing.
 *
 * Off means off at every step. `E2E_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, an
 * `e2e telemetry disable`, or a preferences directory that cannot be written
 * each stop events from being queued, and `flush` checks again before sending.
 * `E2E_TELEMETRY_DEBUG` prints every event to stderr instead of sending it, so
 * anyone can read exactly what would have left the machine.
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
import { timestamp } from '../internal/ids.ts';
import { ciName, collectEnvironment, type TelemetryEnvironment } from './environment.ts';
import type { TelemetryEvent } from './events.ts';
import { POSTHOG_HOST, POSTHOG_PROJECT_KEY, postBatch, type PostHogEvent } from './posthog.ts';
import { anonymousProjectId } from './project.ts';
import { preferencesPath, TelemetryStore, telemetryConfigDir } from './store.ts';

/** Bumped when what is collected changes enough that the notice must show again. */
export const NOTICE_VERSION = 1;
/** The longest a flush may hold the process; the request aborts at the deadline. */
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
  readonly destination?: { readonly host: string; readonly apiKey: string };
  readonly fetch?: typeof fetch;
  /** Where the notice and the debug output go; stderr when absent. */
  readonly write?: (text: string) => void;
}

/** True for a set variable that is not empty, `0`, or `false`, as `CI` is read. */
function flagSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
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

export class Telemetry {
  /** Random per-invocation id, so one invocation's events can be grouped. */
  readonly sessionId = randomBytes(16).toString('hex');

  private readonly version: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly configDir: string;
  private readonly destination: { readonly host: string; readonly apiKey: string };
  private readonly fetchImpl: typeof fetch;
  private readonly write: (text: string) => void;
  private readonly ci: boolean;
  /** `null` until first needed: `--version` and `--help` never touch the disk. */
  private store: TelemetryStore | undefined | null = null;
  private readonly queue: TelemetryEvent[] = [];
  private environment: TelemetryEnvironment | undefined;
  private project: Promise<string | undefined> | undefined;

  constructor(options: TelemetryOptions) {
    this.version = options.version;
    this.env = options.env ?? process.env;
    this.cwd = options.cwd ?? process.cwd();
    this.configDir = options.configDir ?? telemetryConfigDir(this.env);
    this.destination = options.destination ?? { host: POSTHOG_HOST, apiKey: POSTHOG_PROJECT_KEY };
    this.fetchImpl = options.fetch ?? fetch;
    this.write = options.write ?? ((text) => void process.stderr.write(text));
    this.ci = isCiMode(this.env);
  }

  /** Why telemetry is off, or undefined when it is on. */
  get disabledBy(): TelemetryDisabledBy | undefined {
    if (flagSet(this.env['E2E_TELEMETRY_DISABLED'])) return 'E2E_TELEMETRY_DISABLED';
    if (flagSet(this.env['DO_NOT_TRACK'])) return 'DO_NOT_TRACK';
    if (this.ci) return undefined;
    const store = this.openStore();
    if (store === undefined) return 'store';
    return store.enabled ? undefined : 'preference';
  }

  get enabled(): boolean {
    return this.disabledBy === undefined;
  }

  /** `E2E_TELEMETRY_DEBUG`: print every event, send nothing. */
  get debug(): boolean {
    return flagSet(this.env['E2E_TELEMETRY_DEBUG']);
  }

  /** Whether this build knows where to send; without a key nothing leaves. */
  get configured(): boolean {
    return this.destination.apiKey !== '';
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
    const store = this.openStore();
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
    const store = this.openStore();
    if (store === undefined || store.wasNotified(NOTICE_VERSION)) return;
    store.markNotified(NOTICE_VERSION, timestamp());
    this.write(noticeText());
  }

  /** Queues one event for the flush; a no-op when off. */
  record(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.queue.push(event);
    // Git is asked for the project id now, while the command runs, so the
    // flush at the end waits on the network alone.
    this.project ??= this.resolveProject();
  }

  /**
   * Sends everything queued in one request, or prints it under debug. The
   * request aborts at `maxWaitMs`; a lost batch is the accepted cost of a
   * command that never waits on telemetry.
   */
  async flush(maxWaitMs: number = DEFAULT_FLUSH_MS): Promise<void> {
    const events = this.queue.splice(0);
    if (events.length === 0 || !this.enabled) return;
    if (!this.debug && !this.configured) return;
    this.environment ??= collectEnvironment({ env: this.env, cwd: this.cwd, version: this.version });
    const project = await (this.project ??= this.resolveProject());
    const distinctId = this.distinctId();
    // The debug output and the request body are the same objects, so what
    // `E2E_TELEMETRY_DEBUG` shows is what would have been sent, key for key.
    const items: PostHogEvent[] = events.map((event) => ({
      event: event.name,
      timestamp: event.at ?? timestamp(),
      properties: {
        ...this.environment,
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
    await postBatch(items, {
      host: this.destination.host,
      apiKey: this.destination.apiKey,
      timeoutMs: maxWaitMs,
      fetch: this.fetchImpl,
    });
  }

  /** The CI vendor for a CI run, otherwise the machine's random id. */
  private distinctId(): string {
    if (this.ci) return `ci:${ciName(this.env) ?? 'unknown'}`;
    return this.openStore()?.anonymousId ?? 'unknown';
  }

  private resolveProject(): Promise<string | undefined> {
    // In CI there is no store, so a path outside git has nothing to salt it and yields no id.
    const store = this.ci ? undefined : this.openStore();
    return anonymousProjectId(this.cwd, store?.pathSalt);
  }

  private openStore(): TelemetryStore | undefined {
    if (this.store === null) this.store = TelemetryStore.open(this.configDir);
    return this.store;
  }
}
