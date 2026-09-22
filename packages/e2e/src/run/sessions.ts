/** Per-run encrypted session store. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineSpiVersion, EngineState } from '../engine/surface.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { canonicalJson, timestamp } from '../internal/ids.ts';

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;
/** The lease a run writes into its directory; never an envelope name, those carry `--`. */
const OWNER_FILE = 'owner.json';

export interface SessionIdentity {
  readonly targetId: string;
  readonly engineName: string;
  readonly engineVersion: string;
  readonly spiVersion: EngineSpiVersion;
  readonly platform: string;
  readonly appIdentity: string;
}

interface SessionEnvelope {
  schemaVersion: 'session-1';
  runId: string;
  name: string;
  targetId: string;
  engine: { name: string; version: string; spiVersion: number };
  platform: string;
  appIdentity: string;
  createdAt: string;
  expiresAt: string;
  state: {
    format: string;
    version: number;
    algorithm: 'A256GCM';
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

/**
 * Collects states saved by one setup attempt and owns the setup session
 * contract: each declared name saved exactly once, nothing undeclared.
 */
export class SessionStaging {
  private readonly staged = new Map<string, EngineState>();

  constructor(private readonly declared: readonly string[]) {}

  /** Stages one captured state, rejecting duplicate or undeclared names. */
  stage(name: string, state: EngineState): void {
    if (this.staged.has(name)) {
      throw new E2EError('test', 'SESSION_CONTRACT', `session "${name}" saved twice`);
    }
    if (!this.declared.includes(name)) {
      throw new E2EError(
        'test',
        'SESSION_CONTRACT',
        `session "${name}" was not declared by this setup test`,
      );
    }
    this.staged.set(name, state);
  }

  /** Declared names the attempt finished without saving. */
  missing(): string[] {
    return this.declared.filter((name) => !this.staged.has(name));
  }

  entries(): IterableIterator<[string, EngineState]> {
    return this.staged.entries();
  }
}

/** Holds the per-run AES-256-GCM key in memory and owns the session directory. */
export class SessionStore {
  private readonly key: Buffer;
  private readonly directory: string;
  /** Decrypted states by target and name; see `load`. */
  private readonly loaded = new Map<string, Promise<EngineState>>();

  private constructor(
    private readonly runId: string,
    sessionsRoot: string,
    key: Buffer,
  ) {
    this.key = key;
    this.directory = path.join(sessionsRoot, runId);
  }

  /**
   * Opens the store for a new run, generating its key. Sweeps the
   * directories of runs that never reached `cleanup`, then claims this run's
   * directory with an owner file naming this process, so a later run's sweep
   * can tell a run still going from one that died.
   */
  static create(runId: string, sessionsRoot: string): SessionStore {
    sweepStaleRuns(sessionsRoot, runId);
    const store = new SessionStore(runId, sessionsRoot, randomBytes(32));
    store.claim();
    return store;
  }

  /** Opens the store in a worker, reusing the key the runner generated. */
  static forWorker(runId: string, sessionsRoot: string, key: Buffer): SessionStore {
    if (key.length !== 32) {
      throw new E2EError('infrastructure', 'SESSION_KEY_INVALID', 'session key must be 32 bytes');
    }
    return new SessionStore(runId, sessionsRoot, key);
  }

  /** Base64 key for transfer to worker processes over IPC (never disk/env). */
  exportKeyForWorker(): string {
    return this.key.toString('base64');
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  /**
   * Writes the owner file. Best effort: a directory this process cannot
   * create fails the first `save` with its own error, and leaves nothing for
   * a sweep to remove.
   */
  private claim(): void {
    try {
      this.ensureDirectory();
      writeFileSync(
        path.join(this.directory, OWNER_FILE),
        `${JSON.stringify({ pid: process.pid, startedAt: timestamp() })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // See above.
    }
  }

  private filePath(targetId: string, name: string): string {
    return path.join(this.directory, `${targetId}--${name}.json`);
  }

  /** Encrypts and atomically persists one captured engine state. */
  async save(name: string, identity: SessionIdentity, state: EngineState): Promise<void> {
    this.ensureDirectory();
    const createdAt = timestamp();
    let expiresAt = new Date(Date.now() + MAX_SESSION_AGE_MS).toISOString();
    if (state.expiresAt !== undefined) {
      const stateExpiry = Date.parse(state.expiresAt);
      if (Number.isNaN(stateExpiry) || stateExpiry <= Date.now()) {
        throw new E2EError('test', 'SESSION_EXPIRED', 'state expiry is at or before creation');
      }
      if (stateExpiry < Date.parse(expiresAt)) expiresAt = new Date(stateExpiry).toISOString();
    }

    const iv = randomBytes(12);
    const ivBase64 = iv.toString('base64');

    const envelopeWithoutCipher = {
      schemaVersion: 'session-1' as const,
      runId: this.runId,
      name,
      targetId: identity.targetId,
      engine: {
        name: identity.engineName,
        version: identity.engineVersion,
        spiVersion: identity.spiVersion,
      },
      platform: identity.platform,
      appIdentity: identity.appIdentity,
      createdAt,
      expiresAt,
      state: {
        format: state.format,
        version: state.version,
        algorithm: 'A256GCM' as const,
        iv: ivBase64,
      },
    };

    const aad = Buffer.from(canonicalJson(envelopeWithoutCipher), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(state.data), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: SessionEnvelope = {
      ...envelopeWithoutCipher,
      state: {
        ...envelopeWithoutCipher.state,
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    };

    const target = this.filePath(identity.targetId, name);
    await writeFileAtomic(target, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Validates identity and expiry, then decrypts one session state. A
   * session is immutable for the life of the run that produced it, so the
   * decrypted state is memoized per store: a worker running many consumers
   * of one session reads and decrypts its file once.
   */
  async load(name: string, identity: SessionIdentity): Promise<EngineState> {
    const memoKey = `${identity.targetId}\u0000${name}`;
    const cached = this.loaded.get(memoKey);
    if (cached !== undefined) return cached;
    const loading = this.loadUncached(name, identity);
    this.loaded.set(memoKey, loading);
    try {
      return await loading;
    } catch (cause) {
      this.loaded.delete(memoKey);
      throw cause;
    }
  }

  private async loadUncached(name: string, identity: SessionIdentity): Promise<EngineState> {
    let rawText: string;
    try {
      rawText = await readFile(this.filePath(identity.targetId, name), 'utf8');
    } catch (cause) {
      throw new ConfigurationError('SESSION_UNAVAILABLE', `session "${name}" was not produced`, {
        cause,
      });
    }
    const envelope = parseEnvelope(rawText, name);
    if (
      envelope.schemaVersion !== 'session-1' ||
      envelope.runId !== this.runId ||
      envelope.targetId !== identity.targetId ||
      envelope.engine.name !== identity.engineName ||
      envelope.engine.version !== identity.engineVersion ||
      envelope.engine.spiVersion !== identity.spiVersion ||
      envelope.platform !== identity.platform ||
      envelope.appIdentity !== identity.appIdentity
    ) {
      throw new ConfigurationError(
        'SESSION_MISMATCH',
        `session "${name}" does not match the current run/target/engine identity`,
      );
    }
    if (Date.parse(envelope.expiresAt) <= Date.now()) {
      throw new ConfigurationError('SESSION_EXPIRED', `session "${name}" is expired`);
    }

    const { tag, ciphertext, ...aadState } = envelope.state;
    const aadEnvelope = { ...envelope, state: aadState };
    const aad = Buffer.from(canonicalJson(aadEnvelope), 'utf8');
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.state.iv, 'base64'),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]);
    } catch (cause) {
      throw new ConfigurationError('SESSION_INVALID', `session "${name}" failed authentication`, {
        cause,
      });
    }
    return {
      format: envelope.state.format,
      version: envelope.state.version,
      data: JSON.parse(plaintext.toString('utf8')),
      expiresAt: envelope.expiresAt,
    };
  }

  /** Deletes the run's session directory. */
  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Parses an envelope file, classifying a corrupt or truncated one as SESSION_INVALID. */
function parseEnvelope(rawText: string, name: string): SessionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" is not valid JSON`, {
      cause,
    });
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { engine?: unknown }).engine !== 'object' ||
    (parsed as { engine: unknown }).engine === null ||
    !hasCipherFields((parsed as { state?: unknown }).state)
  ) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" has an unexpected shape`);
  }
  return parsed as SessionEnvelope;
}

/** Whether `state` carries the non-empty strings decryption reads: `iv`, `tag`, `ciphertext`. */
function hasCipherFields(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  const { iv, tag, ciphertext } = state as Record<string, unknown>;
  return [iv, tag, ciphertext].every((field) => typeof field === 'string' && field.length > 0);
}

/**
 * Removes sibling run directories whose runner is gone and whose last write
 * is older than a session may live. A run killed before `cleanup` (a third
 * Ctrl-C, SIGKILL, a crash) leaves its directory behind with its memory-only
 * key gone, so nothing can read what is in it. A run still going after a day
 * keeps its directory: its owner file names a live pid. Sessions never leave
 * the machine, so pid liveness is the portable check; a pid an unrelated
 * process has since taken keeps a dead run's directory until that process
 * exits too. Best effort: the sweep never fails the run, skips the current
 * run's directory, and never follows a symlink.
 */
function sweepStaleRuns(sessionsRoot: string, runId: string): void {
  const cutoff = Date.now() - MAX_SESSION_AGE_MS;
  try {
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (entry.name === runId || !entry.isDirectory()) continue;
      const directory = path.join(sessionsRoot, entry.name);
      try {
        if (lstatSync(directory).mtimeMs >= cutoff || ownerAlive(directory)) continue;
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A sibling another process holds or already removed is left for the next run.
      }
    }
  } catch {
    // No sessions root yet, or one this process cannot list.
  }
}

/** Whether the directory's owner file names a process that is still running. */
function ownerAlive(directory: string): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(path.join(directory, OWNER_FILE), 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists under another user. Anything else: gone.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
