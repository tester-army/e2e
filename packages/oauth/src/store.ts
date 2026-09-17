/**
 * Credentials on disk: one JSON file keyed by provider id, mode 0600, written
 * atomically so a run that refreshes while another reads never sees half a
 * file. `E2E_OAUTH_CREDENTIALS` holding the same JSON overrides the file for
 * a machine the user cannot log in on; that copy is read-only.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CredentialStore, OAuthCredentials } from './types.ts';

export const CREDENTIALS_ENV = 'E2E_OAUTH_CREDENTIALS';

type CredentialsFile = Record<string, OAuthCredentials>;

/** `$XDG_CONFIG_HOME/e2e/oauth.json`, or `~/.config/e2e/oauth.json`. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME'];
  const base = configHome !== undefined && configHome !== '' ? configHome : path.join(homedir(), '.config');
  return path.join(base, 'e2e', 'oauth.json');
}

export interface FileCredentialStoreOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: FileCredentialStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.path = options.path ?? defaultCredentialsPath(this.env);
  }

  /** True when the environment variable, not the file, is the source. */
  get readOnly(): boolean {
    const value = this.env[CREDENTIALS_ENV];
    return value !== undefined && value !== '';
  }

  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.read()[providerId];
  }

  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    if (this.readOnly) return;
    this.write({ ...this.read(), [providerId]: credentials });
  }

  async remove(providerId: string): Promise<void> {
    if (this.readOnly) return;
    const all = this.read();
    if (!(providerId in all)) return;
    delete all[providerId];
    this.write(all);
  }

  async list(): Promise<string[]> {
    return Object.keys(this.read());
  }

  private read(): CredentialsFile {
    const fromEnv = this.env[CREDENTIALS_ENV];
    if (fromEnv !== undefined && fromEnv !== '') return parseCredentials(fromEnv, CREDENTIALS_ENV);
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw cause;
    }
    return parseCredentials(text, this.path);
  }

  private write(all: CredentialsFile): void {
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(temp, this.path);
    } catch (cause) {
      try {
        unlinkSync(temp);
      } catch {
        // The rename failed first; that error is the one to report.
      }
      throw cause;
    }
  }
}

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
    if (!isCredentials(value)) throw new Error(`${source}: the entry for ${id} is not a credential record`);
    out[id] = value;
  }
  return out;
}

function isCredentials(value: unknown): value is OAuthCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['access'] === 'string' && typeof record['refresh'] === 'string' && typeof record['expires'] === 'number';
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
