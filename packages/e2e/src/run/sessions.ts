/** Per-run encrypted session store. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedTarget } from '../config/resolve.ts';
import { ENGINE_SPI_VERSION } from '../engine/contract.ts';
import type { EngineSpiVersion, EngineState } from '../engine/surface.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { ConfigurationError, E2EError } from '../internal/errors.ts';
import { canonicalDigest, canonicalJson, timestamp } from '../internal/ids.ts';
import { obj } from '../internal/objects.ts';
import type { SavedSecrecy } from './secrecy.ts';

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionIdentity {
  readonly targetId: string;
  readonly engineName: string;
  readonly engineVersion: string;
  readonly spiVersion: EngineSpiVersion;
  readonly platform: string;
  readonly appIdentity: string;
}

/**
 * The identity session and replay cache entries key on for one target.
 * It comes from the engine's name and version and the target's resolved
 * app, so an engine swap never restores another engine's state. The app's
 * declared identity (else its URL, bundle id, or build path) keys entries,
 * so an ephemeral per-deploy origin (a PR preview) can share them with the
 * app it is a deployment of. The environment always joins the digest: an
 * identity must never bleed entries across environments.
 */
export function targetIdentity(target: ResolvedTarget): SessionIdentity {
  return {
    targetId: target.name,
    engineName: target.engine?.name ?? 'none',
    engineVersion: target.engine?.version ?? 'unversioned',
    spiVersion: target.engine?.spiVersion ?? ENGINE_SPI_VERSION,
    platform: target.platform,
    appIdentity: canonicalDigest(obj({ identity: target.app.identity, environment: target.app.environment })),
  };
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
  /** Authenticated, never encrypted: which secrets the payload carries values for, and whether the saving session was tainted. */
  secrecy?: { tainted: boolean; names: string[] };
  state: {
    format: string;
    version: number;
    algorithm: 'A256GCM';
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

/** What one saved session holds once decrypted. */
export interface SavedSession {
  readonly state: EngineState;
  readonly secrecy: SavedSecrecy;
}

/** The encrypted payload: the engine's state data beside the secret values the envelope names. */
interface SessionPayload {
  data: unknown;
  secrets: [string, string][];
}

/**
 * Collects states saved by one setup attempt and owns the setup session
 * contract: each declared name saved exactly once, nothing undeclared.
 */
export class SessionStaging {
  private readonly staged = new Map<string, SavedSession>();

  constructor(private readonly declared: readonly string[]) {}

  /** Stages one captured state with the secrecy of the session it came from, rejecting duplicate or undeclared names. */
  stage(name: string, state: EngineState, secrecy: SavedSecrecy): void {
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
    this.staged.set(name, { state, secrecy });
  }

  /** Declared names the attempt finished without saving. */
  missing(): string[] {
    return this.declared.filter((name) => !this.staged.has(name));
  }

  entries(): IterableIterator<[string, SavedSession]> {
    return this.staged.entries();
  }
}

/** Holds the per-run AES-256-GCM key in memory and owns the session directory. */
export class SessionStore {
  private readonly key: Buffer;
  private readonly directory: string;
  /** Decrypted states by target and name; see `load`. */
  private readonly loaded = new Map<string, Promise<SavedSession>>();

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
    const digest = createHash('sha256')
      .update(`${targetId}\u0000${name}`)
      .digest('hex')
      .slice(0, 16);
    return path.join(
      this.directory,
      `${fileNamePart(targetId)}--${fileNamePart(name)}-${digest}.json`,
    );
  }

  /**
   * Encrypts and atomically persists one captured engine state. The secret
   * values the saving session learned ride inside the ciphertext, beside the
   * state they may be stored in, so the session that restores it redacts
   * them too; the envelope names them and carries the taint in the clear,
   * authenticated.
   */
  async save(name: string, identity: SessionIdentity, { state, secrecy }: SavedSession): Promise<void> {
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
      secrecy: { tainted: secrecy.tainted, names: [...new Set(secrecy.secrets.map(([secretName]) => secretName))] },
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
    const payload: SessionPayload = { data: state.data, secrets: secrecy.secrets.map(([secretName, value]) => [secretName, value]) };
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
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
   * of one session reads and decrypts its file once. Its expiry is still
   * checked on every load: an immutable state can expire between consumers.
   */
  async load(name: string, identity: SessionIdentity): Promise<SavedSession> {
    const memoKey = `${identity.targetId}\u0000${name}`;
    const cached = this.loaded.get(memoKey);
    if (cached !== undefined) {
      const saved = await cached;
      assertSessionNotExpired(name, saved.state.expiresAt);
      return saved;
    }
    const loading = this.loadUncached(name, identity);
    this.loaded.set(memoKey, loading);
    try {
      return await loading;
    } catch (cause) {
      this.loaded.delete(memoKey);
      throw cause;
    }
  }

  private async loadUncached(name: string, identity: SessionIdentity): Promise<SavedSession> {
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
    assertSessionNotExpired(name, envelope.expiresAt);

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
    const payload = parsePayload(plaintext.toString('utf8'), name);
    return {
      state: {
        format: envelope.state.format,
        version: envelope.state.version,
        data: payload.data,
        expiresAt: envelope.expiresAt,
      },
      secrecy: { secrets: payload.secrets, tainted: envelope.secrecy?.tainted === true },
    };
  }

  /** Deletes the run's session directory. */
  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Refuses an expired saved session, whether freshly decrypted or already cached. */
function assertSessionNotExpired(name: string, expiresAt: string | undefined): void {
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
    throw new ConfigurationError('SESSION_EXPIRED', `session "${name}" is expired`);
  }
}

const FILE_NAME_PART_MAX = 40;

/**
 * The readable prefix of a session file name for one of its parts: every
 * character outside `[A-Za-z0-9_]`, `-` and `.` included, becomes `%XX`, so
 * the part carries no path separator or `..` segment, then the result is cut
 * to a fixed length. A session name may be 128 characters and a target name
 * any length, and the escape triples a dash, so the cut keeps the whole file
 * name, with the atomic-write suffix, far under the 255-byte component limit.
 * The digest `filePath` appends is what tells two pairs apart, so target
 * `a--b` with session `c` and target `a` with session `b--c` are two files
 * even where their prefixes agree.
 */
function fileNamePart(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  })
    .join('')
    .slice(0, FILE_NAME_PART_MAX);
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

/** Parses an authenticated payload; one this runner did not write is SESSION_INVALID. */
function parsePayload(text: string, name: string): SessionPayload {
  const parsed = JSON.parse(text) as { data?: unknown; secrets?: unknown } | null;
  const secrets = parsed?.secrets;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('data' in parsed) ||
    !Array.isArray(secrets) ||
    !secrets.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === 'string'),
    )
  ) {
    throw new ConfigurationError('SESSION_INVALID', `session "${name}" has an unexpected payload`);
  }
  return parsed as SessionPayload;
}
