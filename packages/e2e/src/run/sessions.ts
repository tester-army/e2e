/** Per-run encrypted session store. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { EngineSpiVersion, EngineState } from '../engine/surface.ts';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { canonicalJson, timestamp } from '../internal/ids.ts';

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

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

  /** Opens the store for a new run, generating its key. */
  static create(runId: string, sessionsRoot: string): SessionStore {
    return new SessionStore(runId, sessionsRoot, randomBytes(32));
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
    const temporary = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
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
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(envelope.state.iv, 'base64'),
    );
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    let plaintext: Buffer;
    try {
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
    typeof (parsed as { state?: unknown }).state !== 'object' ||
    (parsed as { state: unknown }).state === null ||
    typeof (parsed as { engine?: unknown }).engine !== 'object' ||
    (parsed as { engine: unknown }).engine === null
  ) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" has an unexpected shape`);
  }
  return parsed as SessionEnvelope;
}
