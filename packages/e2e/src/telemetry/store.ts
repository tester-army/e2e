/**
 * The user-level telemetry preferences: `~/.config/e2e/telemetry.json`
 * (`$XDG_CONFIG_HOME/e2e` when set, `%APPDATA%\e2e` on Windows). The file
 * holds the opt-out, the random id every event from this machine is
 * attributed to, the salt that keeps a hashed path unrecoverable, and which
 * notice was shown when. Nothing in it names the person or the machine: the
 * id and the salt are random bytes, generated here and never derived.
 *
 * The store fails closed. When the directory cannot be created or the file
 * cannot be written, there is no store, and telemetry treats the absence as an
 * opt-out rather than sending events it could neither attribute nor
 * de-duplicate.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Preferences {
  enabled?: boolean;
  anonymousId?: string;
  salt?: string;
  /** When the notice was printed, and which version of it. */
  notifiedAt?: string;
  noticeVersion?: number;
}

const FILE_NAME = 'telemetry.json';
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
    const appData = nonEmpty(env['APPDATA']) ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'e2e');
  }
  const configHome = nonEmpty(env['XDG_CONFIG_HOME']) ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'e2e');
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
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
  if (typeof raw['notifiedAt'] === 'string') preferences.notifiedAt = raw['notifiedAt'];
  if (typeof raw['noticeVersion'] === 'number') preferences.noticeVersion = raw['noticeVersion'];
  return preferences;
}

export class TelemetryStore {
  /** The preferences file, for messages that tell the user where a choice was saved. */
  readonly path: string;
  private preferences: Preferences;
  private writeFailed = false;
  /** False only during `open`, when a write failure must surface. */
  private opened = false;

  private constructor(filePath: string, preferences: Preferences) {
    this.path = filePath;
    this.preferences = preferences;
  }

  /**
   * Opens the store in `directory`, creating the directory and the file when
   * they are missing. A file that is not JSON is started over: a torn write
   * must not turn into a permanent opt-in or opt-out either way. Returns
   * undefined when the file cannot exist, which the caller reads as off.
   */
  static open(directory: string): TelemetryStore | undefined {
    const filePath = preferencesPath(directory);
    let preferences: Preferences | undefined;
    try {
      preferences = sanitize(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch {
      preferences = undefined;
    }
    const store = new TelemetryStore(filePath, preferences ?? {});
    if (preferences === undefined) {
      try {
        mkdirSync(directory, { recursive: true });
        store.write();
      } catch {
        return undefined;
      }
    }
    store.opened = true;
    return store;
  }

  /** The user's choice; unset means participating. */
  get enabled(): boolean {
    return this.preferences.enabled !== false;
  }

  /** Saves the choice; false when it stayed in memory because the file could not be written. */
  saveEnabled(value: boolean): boolean {
    this.preferences.enabled = value;
    this.write();
    return !this.writeFailed;
  }

  /** The random per-machine id, generated on first use and kept. */
  get anonymousId(): string {
    if (this.preferences.anonymousId === undefined) {
      this.preferences.anonymousId = randomBytes(16).toString('hex');
      this.write();
    }
    return this.preferences.anonymousId;
  }

  /** The local salt that keeps a hashed project path unrecoverable; never leaves the machine. */
  get pathSalt(): string {
    if (this.preferences.salt === undefined) {
      this.preferences.salt = randomBytes(16).toString('hex');
      this.write();
    }
    return this.preferences.salt;
  }

  /** Whether this version of the notice has been shown. */
  wasNotified(version: number): boolean {
    return this.preferences.notifiedAt !== undefined && (this.preferences.noticeVersion ?? 0) >= version;
  }

  markNotified(version: number, at: string): void {
    this.preferences.notifiedAt = at;
    this.preferences.noticeVersion = version;
    this.write();
  }

  /**
   * Persists through a temporary file and a rename, so a crash cannot leave
   * half a file behind. `open` lets the failure propagate, since a store that
   * cannot exist is no store; later, the choice lives on in this process and
   * `saveEnabled` tells the caller it did not reach the file.
   */
  private write(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.preferences, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      this.writeFailed = false;
    } catch (cause) {
      this.writeFailed = true;
      if (!this.opened) throw cause;
    }
  }
}
