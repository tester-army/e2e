/**
 * Credentials between runs: one JSON file keyed by provider id, mode 0600.
 * Writes hold an advisory lock and replace the file atomically, so two runs
 * refreshing at once neither tear the file nor lose each other's entries.
 * `E2E_OAUTH_CREDENTIALS` holding the same JSON stands in for the file on a
 * machine the user cannot sign in on; that store refuses to write.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { OAuthError } from './errors.ts';
import type { CredentialStore, OAuthCredentials } from './types.ts';

export const CREDENTIALS_ENV = 'E2E_OAUTH_CREDENTIALS';

type CredentialsFile = Record<string, OAuthCredentials>;

/** `$XDG_CONFIG_HOME/e2e/oauth.json`, or `~/.config/e2e/oauth.json`. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME'];
  const base = configHome !== undefined && configHome !== '' ? configHome : path.join(homedir(), '.config');
  return path.join(base, 'e2e', 'oauth.json');
}

/** The store the model constructors and the CLI use: the environment variable when set, else the file. */
export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const fromEnv = env[CREDENTIALS_ENV];
  return fromEnv !== undefined && fromEnv !== '' ? new EnvCredentialStore(fromEnv) : new FileCredentialStore(defaultCredentialsPath(env));
}

const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(file: string = defaultCredentialsPath()) {
    this.path = file;
  }

  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.read()[providerId];
  }

  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    await this.update((all) => ({ ...all, [providerId]: credentials }));
  }

  async remove(providerId: string): Promise<void> {
    await this.update((all) => {
      const { [providerId]: _removed, ...rest } = all;
      return rest;
    });
  }

  async list(): Promise<string[]> {
    return Object.keys(this.read());
  }

  private read(): CredentialsFile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw cause;
    }
    return parseCredentials(text, this.path);
  }

  /** Read-modify-write under the lock, then an atomic replace. */
  private async update(change: (all: CredentialsFile) => CredentialsFile): Promise<void> {
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const release = await this.lock();
    try {
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(change(this.read()), null, 2)}\n`, { mode: 0o600 });
      try {
        renameSync(temp, this.path);
      } catch (cause) {
        rmSync(temp, { force: true });
        throw cause;
      }
    } finally {
      release();
    }
  }

  /** An advisory lock file created exclusively; a lock older than the stale bound is taken over. */
  private async lock(): Promise<() => void> {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(lockPath, 'wx', 0o600));
        return () => rmSync(lockPath, { force: true });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        const age = Date.now() - lockAge(lockPath);
        if (age > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`${lockPath} is held by another process; remove it if that process is gone`, { cause });
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }
}

function lockAge(lockPath: string): number {
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** Credentials from the environment variable: readable everywhere, changed nowhere. */
export class EnvCredentialStore implements CredentialStore {
  private readonly entries: CredentialsFile;
  constructor(json: string, source: string = CREDENTIALS_ENV) {
    this.entries = parseCredentials(json, source);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries[providerId];
  }
  async set(): Promise<void> {
    throw new OAuthError('MISCONFIGURED', `${CREDENTIALS_ENV} is set, so logins come from the environment and cannot be changed here; unset it to sign in on this machine`);
  }
  async remove(): Promise<void> {
    return this.set();
  }
  async list(): Promise<string[]> {
    return Object.keys(this.entries);
  }
}

/** A store for tests and embedders that keep credentials elsewhere. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, OAuthCredentials>();
  constructor(initial: Record<string, OAuthCredentials> = {}) {
    for (const [id, credentials] of Object.entries(initial)) this.entries.set(id, credentials);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries.get(providerId);
  }
  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    this.entries.set(providerId, credentials);
  }
  async remove(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
  async list(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}

/** The file's entries; one damaged entry is dropped rather than taking every login down with it. */
function parseCredentials(text: string, source: string): CredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must hold an object keyed by provider id`);
  }
  const out: CredentialsFile = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isCredentials(value)) out[id] = value;
  }
  return out;
}

function isCredentials(value: unknown): value is OAuthCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['access'] === 'string' && typeof record['refresh'] === 'string' && typeof record['expires'] === 'number';
}
