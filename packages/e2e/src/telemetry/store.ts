/**
 * The user-level telemetry preferences: `~/.config/e2e/telemetry.json`
 * (`$XDG_CONFIG_HOME/e2e` when set, `%APPDATA%\e2e` on Windows). The file
 * holds the opt-out, the random id every event from this machine is
 * attributed to, the salt that keeps a hashed path unrecoverable, and which
 * notice was shown when. Nothing in it names the person or the machine: the
 * id and the salt are random bytes, generated here and never derived.
 *
 * The store fails closed. `open` completes the file in one write when the id
 * or the salt is missing, and when that write cannot happen there is no
 * store: telemetry treats the absence as an opt-out rather than sending
 * events it could neither attribute nor de-duplicate. After `open`, only the
 * user's own choice and the notice mark write, so an ordinary command never
 * rewrites the file while another process may be saving a choice to it.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomicSync } from '../internal/atomic-write.ts';
import { envValue } from '../internal/env.ts';
import { timestamp } from '../internal/ids.ts';

interface Preferences {
  enabled?: boolean;
  anonymousId?: string;
  salt?: string;
  /** When the ids were generated: the first time e2e ran on this machine. */
  createdAt?: string;
  /** When the notice was printed, and which version of it. */
  notifiedAt?: string;
  noticeVersion?: number;
}

/** What an open store holds: the ids are always there. */
type Identified = Preferences & { anonymousId: string; salt: string };

const FILE_NAME = 'telemetry.json';
const DAY_MS = 86_400_000;
const HEX = /^[a-f0-9]{16,128}$/u;

/** The preferences file inside a config directory. */
export function preferencesPath(directory: string): string {
  return path.join(directory, FILE_NAME);
}

/** Where the preferences live for this platform and environment. */
export function telemetryConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA') ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'e2e');
  }
  const configHome = envValue(env, 'XDG_CONFIG_HOME') ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'e2e');
}

/** Keeps only the fields this version knows, each with the type it expects. */
function sanitize(value: unknown): Preferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const preferences: Preferences = {};
  if (typeof raw['enabled'] === 'boolean') preferences.enabled = raw['enabled'];
  if (typeof raw['anonymousId'] === 'string' && HEX.test(raw['anonymousId'])) {
    preferences.anonymousId = raw['anonymousId'];
  }
  if (typeof raw['salt'] === 'string' && HEX.test(raw['salt'])) preferences.salt = raw['salt'];
  if (typeof raw['createdAt'] === 'string' && !Number.isNaN(Date.parse(raw['createdAt']))) {
    preferences.createdAt = raw['createdAt'];
  }
  if (typeof raw['notifiedAt'] === 'string') preferences.notifiedAt = raw['notifiedAt'];
  if (typeof raw['noticeVersion'] === 'number') preferences.noticeVersion = raw['noticeVersion'];
  return preferences;
}

/** The file's preferences, or undefined when it is missing or not JSON. */
function readPreferences(filePath: string): Preferences | undefined {
  try {
    return sanitize(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return undefined;
  }
}

function randomHex(): string {
  return randomBytes(16).toString('hex');
}

export class TelemetryStore {
  /** The preferences file, for messages that tell the user where a choice was saved. */
  readonly path: string;
  /** True when this open generated the ids: the first e2e command on this machine. */
  readonly fresh: boolean;
  private preferences: Identified;

  private constructor(filePath: string, preferences: Identified, fresh: boolean) {
    this.path = filePath;
    this.preferences = preferences;
    this.fresh = fresh;
  }

  /**
   * Opens the store in `directory`. A complete file is only read, so a
   * read-only preferences file keeps working, and a file from before the
   * creation time was recorded stays as it is: its age is unknown, not
   * today. A missing file, a file that is not JSON, or one without an id or
   * a salt is completed in one write that also creates the directory; a torn
   * write must not turn into a permanent opt-in or opt-out either way.
   * Returns undefined when that write fails, which the caller reads as off.
   */
  static open(directory: string): TelemetryStore | undefined {
    const filePath = preferencesPath(directory);
    const read = readPreferences(filePath);
    if (read?.anonymousId !== undefined && read.salt !== undefined) {
      return new TelemetryStore(filePath, { ...read, anonymousId: read.anonymousId, salt: read.salt }, false);
    }
    const store = new TelemetryStore(
      filePath,
      { ...read, anonymousId: randomHex(), salt: randomHex(), createdAt: timestamp() },
      true,
    );
    try {
      mkdirSync(directory, { recursive: true });
    } catch {
      return undefined;
    }
    return store.write() ? store : undefined;
  }

  /** The user's choice; unset means participating. */
  get enabled(): boolean {
    return this.preferences.enabled !== false;
  }

  /** The random per-machine id every event from this machine is attributed to. */
  get anonymousId(): string {
    return this.preferences.anonymousId;
  }

  /** The local salt that keeps a hashed project path unrecoverable; never leaves the machine. */
  get pathSalt(): string {
    return this.preferences.salt;
  }

  /** Whole days since the ids were generated; undefined for a file from before the time was recorded. */
  ageDays(now: number = Date.now()): number | undefined {
    const created = this.preferences.createdAt;
    if (created === undefined) return undefined;
    return Math.max(0, Math.floor((now - Date.parse(created)) / DAY_MS));
  }

  /** Saves the choice; false when the file could not be written and the choice stayed in memory. */
  saveEnabled(value: boolean): boolean {
    this.preferences.enabled = value;
    return this.write();
  }

  /**
   * Re-reads the file, so a choice another process saved since `open` is
   * seen before anything is sent. An unreadable file changes nothing.
   */
  reload(): void {
    const read = readPreferences(this.path);
    if (read === undefined) return;
    this.preferences = {
      ...read,
      anonymousId: read.anonymousId ?? this.preferences.anonymousId,
      salt: read.salt ?? this.preferences.salt,
    };
  }

  /** Whether this version of the notice has been shown. */
  wasNotified(version: number): boolean {
    return this.preferences.notifiedAt !== undefined && (this.preferences.noticeVersion ?? 0) >= version;
  }

  /** Records that the notice was shown; a failed write only means it may show once more. */
  markNotified(version: number, at: string): void {
    this.preferences.notifiedAt = at;
    this.preferences.noticeVersion = version;
    this.write();
  }

  private write(): boolean {
    try {
      writeFileAtomicSync(this.path, `${JSON.stringify(this.preferences, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }
}
