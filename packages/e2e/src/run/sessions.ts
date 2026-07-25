/** Per-run encrypted session store (spec 11-lifecycle.md, 13-reporting.md). */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { DriverState } from '../driver/index.js';
import { ConfigurationError, E2EError } from '../internal/errors.js';
import { canonicalJson, timestamp } from '../internal/ids.js';

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface SessionIdentity {
  readonly targetId: string;
  readonly driverId: string;
  readonly driverVersion: string;
  readonly spiVersion: number;
  readonly platform: string;
  readonly appIdentity: string;
}

interface SessionEnvelope {
  schemaVersion: 'session-1';
  runId: string;
  name: string;
  targetId: string;
  driver: { id: string; version: string; spiVersion: number };
  platform: string;
  appIdentity: string;
  createdAt: string;
  expiresAt: string;
  state: {
    format: string;
    version: number;
    algorithm: 'aes-256-gcm';
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
  private readonly staged = new Map<string, DriverState>();

  constructor(private readonly declared: readonly string[]) {}

  /** Stages one captured state, rejecting duplicate or undeclared names. */
  stage(name: string, state: DriverState): void {
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

  entries(): IterableIterator<[string, DriverState]> {
    return this.staged.entries();
  }
}

/** Holds the per-run AES-256-GCM key in memory and owns the session directory. */
export class SessionStore {
  private readonly key = randomBytes(32);
  private readonly directory: string;

  constructor(
    private readonly runId: string,
    sessionsRoot: string,
  ) {
    this.directory = path.join(sessionsRoot, runId);
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  private filePath(targetId: string, name: string): string {
    return path.join(this.directory, `${targetId}--${name}.json`);
  }

  /** Encrypts and atomically persists one captured driver state. */
  async save(name: string, identity: SessionIdentity, state: DriverState): Promise<void> {
    this.ensureDirectory();
    const createdAt = timestamp();
    let expiresAt = new Date(Date.now() + MAX_SESSION_AGE_MS).toISOString();
    if (state.expiresAt !== undefined) {
      const driverExpiry = Date.parse(state.expiresAt);
      if (Number.isNaN(driverExpiry) || driverExpiry <= Date.now()) {
        throw new E2EError('test', 'SESSION_EXPIRED', 'driver state expiry is at or before creation');
      }
      if (driverExpiry < Date.parse(expiresAt)) expiresAt = new Date(driverExpiry).toISOString();
    }

    const iv = randomBytes(12);
    const ivBase64 = iv.toString('base64');

    const envelopeWithoutCipher = {
      schemaVersion: 'session-1' as const,
      runId: this.runId,
      name,
      targetId: identity.targetId,
      driver: {
        id: identity.driverId,
        version: identity.driverVersion,
        spiVersion: identity.spiVersion,
      },
      platform: identity.platform,
      appIdentity: identity.appIdentity,
      createdAt,
      expiresAt,
      state: {
        format: state.format,
        version: state.version,
        algorithm: 'aes-256-gcm' as const,
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

  /** Validates identity and expiry, then decrypts one session state. */
  async load(name: string, identity: SessionIdentity): Promise<DriverState> {
    let rawText: string;
    try {
      rawText = await readFile(this.filePath(identity.targetId, name), 'utf8');
    } catch (cause) {
      throw new ConfigurationError('SESSION_UNAVAILABLE', `session "${name}" was not produced`, {
        cause,
      });
    }
    const envelope = JSON.parse(rawText) as SessionEnvelope;
    if (
      envelope.schemaVersion !== 'session-1' ||
      envelope.runId !== this.runId ||
      envelope.targetId !== identity.targetId ||
      envelope.driver.id !== identity.driverId ||
      envelope.driver.version !== identity.driverVersion ||
      envelope.driver.spiVersion !== identity.spiVersion ||
      envelope.platform !== identity.platform ||
      envelope.appIdentity !== identity.appIdentity
    ) {
      throw new ConfigurationError(
        'SESSION_MISMATCH',
        `session "${name}" does not match the current run/target/driver identity`,
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
