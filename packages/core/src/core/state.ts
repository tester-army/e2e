/**
 * `SessionState`: what an `e2e-core` session's `saveState()` captures (the
 * engine's cookies, storage, or app data), held in memory. It leaves the
 * process only encrypted, under a key the caller holds, as a `session-state-1`
 * document; there is no plaintext export.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EngineState } from '../engine/index.ts';
import { ConfigurationError, TestError } from '../internal/errors.ts';
import { canonicalJson, timestamp } from '../internal/ids.ts';
import type { RestoredState } from '../run/engine-sessions.ts';
import type { SavedSecrets } from '../run/secrecy.ts';

/** What a state is bound to: it restores only on a host of the same engine, platform, and app. */
export interface StateIdentity {
  readonly engine: string;
  readonly platform: string;
  readonly appIdentity: string;
}

/** The `session-state-1` wire format, pinned by `schema/session-state-v1.schema.json`. */
interface StateDocument {
  schemaVersion: 'session-state-1';
  engine: string;
  platform: string;
  appIdentity: string;
  createdAt: string;
  expiresAt?: string;
  /** Authenticated, never encrypted: which secrets the payload carries values for. */
  secrecy: { names: string[] };
  state: {
    format: string;
    version: number;
    algorithm: 'A256GCM';
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

/** The encrypted payload: the engine's state data beside the secret values the document names. */
interface StatePayload {
  data: unknown;
  secrets: [string, string][];
}

const KEY_BYTES = 32;

/** The options of `export` and `import`: the AES-256-GCM key, 32 bytes the caller keeps. */
export interface SessionStateKeyOptions {
  readonly key: Uint8Array;
}

const held = new WeakMap<SessionState, { readonly identity: StateIdentity; readonly saved: RestoredState }>();

/**
 * A captured session state. Pass it to `host.newSession({ state })` to start
 * a session from it, on a host of the same engine, platform, and app.
 */
export class SessionState {
  /** The engine that captured it, by name. */
  readonly engine: string;
  /** The platform it was captured on. */
  readonly platform: string;

  private constructor(identity: StateIdentity, saved: RestoredState) {
    this.engine = identity.engine;
    this.platform = identity.platform;
    held.set(this, { identity, saved });
    Object.freeze(this);
  }

  /**
   * Encrypts the state with `key` (AES-256-GCM, 32 bytes) into a
   * `session-state-1` document, as UTF-8 bytes. The document names the
   * engine, platform, and app in the clear, authenticated; everything the
   * state holds is in the ciphertext.
   */
  // oxlint-disable-next-line typescript/require-await -- async so a bad key rejects instead of throwing
  async export(options: SessionStateKeyOptions): Promise<Uint8Array> {
    const key = requireKey(options, 'SessionState.export');
    const { identity, saved } = held.get(this)!;
    const iv = randomBytes(12);
    const unsealed = {
      schemaVersion: 'session-state-1' as const,
      engine: identity.engine,
      platform: identity.platform,
      appIdentity: identity.appIdentity,
      createdAt: timestamp(),
      ...(saved.state.expiresAt === undefined ? {} : { expiresAt: timestamp(new Date(saved.state.expiresAt)) }),
      secrecy: { names: [...new Set(saved.secrets.map(([name]) => name))] },
      state: { format: saved.state.format, version: saved.state.version, algorithm: 'A256GCM' as const, iv: iv.toString('base64') },
    };
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(canonicalJson(unsealed), 'utf8'));
    const payload: StatePayload = { data: saved.state.data, secrets: saved.secrets.map(([name, value]) => [name, value]) };
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
    const document: StateDocument = {
      ...unsealed,
      state: { ...unsealed.state, tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
    };
    return new TextEncoder().encode(`${JSON.stringify(document)}\n`);
  }

  /**
   * Decrypts a document `export` wrote. A document that is not
   * `session-state-1`, or that fails authentication under `key` (a wrong
   * key, an edited byte), is `SESSION_INVALID`; an expired one is
   * `SESSION_EXPIRED`.
   */
  // oxlint-disable-next-line typescript/require-await -- async so a bad document rejects instead of throwing
  static async import(data: Uint8Array, options: SessionStateKeyOptions): Promise<SessionState> {
    const key = requireKey(options, 'SessionState.import');
    if (!(data instanceof Uint8Array)) throw new TestError('INVALID_ARGUMENT', 'SessionState.import data must be a Uint8Array');
    const document = parseDocument(new TextDecoder().decode(data));
    if (document.expiresAt !== undefined && Date.parse(document.expiresAt) <= Date.now()) {
      throw new ConfigurationError('SESSION_EXPIRED', 'the session state is expired');
    }
    const { tag, ciphertext, ...unsealedState } = document.state;
    let plaintext: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(document.state.iv, 'base64'));
      decipher.setAAD(Buffer.from(canonicalJson({ ...document, state: unsealedState }), 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch (cause) {
      throw new ConfigurationError('SESSION_INVALID', 'the session state failed authentication: a different key, or the document was changed', { cause });
    }
    const payload = parsePayload(plaintext);
    return new SessionState(
      { engine: document.engine, platform: document.platform, appIdentity: document.appIdentity },
      {
        state: {
          format: document.state.format,
          version: document.state.version,
          data: payload.data,
          ...(document.expiresAt === undefined ? {} : { expiresAt: document.expiresAt }),
        },
        secrets: payload.secrets,
      },
    );
  }

  /** A state a session just captured. */
  static captured(identity: StateIdentity, state: EngineState, secrets: SavedSecrets): SessionState {
    return new SessionState(identity, { state, secrets });
  }
}

/**
 * What a host restores from `state`, checked against the host's own identity:
 * another engine, platform, or app is `SESSION_MISMATCH`, an expired state
 * `SESSION_EXPIRED`.
 */
export function restoredStateFor(state: unknown, host: StateIdentity): RestoredState {
  const entry = state instanceof SessionState ? held.get(state) : undefined;
  if (entry === undefined) throw new TestError('INVALID_ARGUMENT', 'newSession state must be a SessionState from saveState() or SessionState.import()');
  const { identity, saved } = entry;
  if (identity.engine !== host.engine || identity.platform !== host.platform || identity.appIdentity !== host.appIdentity) {
    throw new ConfigurationError(
      'SESSION_MISMATCH',
      `the session state was captured on engine ${identity.engine} (${identity.platform}) for another app or engine than this host's ${host.engine} (${host.platform})`,
    );
  }
  if (saved.state.expiresAt !== undefined && Date.parse(saved.state.expiresAt) <= Date.now()) {
    throw new ConfigurationError('SESSION_EXPIRED', 'the session state is expired');
  }
  return saved;
}

function requireKey(options: SessionStateKeyOptions | undefined, api: string): Buffer {
  const key: unknown = options?.key;
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new TestError('INVALID_ARGUMENT', `${api} key must be a Uint8Array of ${KEY_BYTES} bytes, such as crypto.randomBytes(${KEY_BYTES})`);
  }
  return Buffer.from(key);
}

const isString = (value: unknown): value is string => typeof value === 'string';
/** A 12-byte IV and a 16-byte tag in base64, as `schema/session-state-v1.schema.json` pins them. */
const IV_PATTERN = /^[A-Za-z0-9+/]{16}$/u;
const TAG_PATTERN = /^[A-Za-z0-9+/]{22}==$/u;

/** Parses a document's clear part; anything `export` would not have written is `SESSION_INVALID`. */
function parseDocument(text: string): StateDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigurationError('SESSION_INVALID', 'the session state is not valid JSON', { cause });
  }
  const document = parsed as Partial<StateDocument> | null;
  const state = typeof document?.state === 'object' ? document.state as Partial<StateDocument['state']> | null : undefined;
  if (
    typeof document !== 'object' || document === null ||
    document.schemaVersion !== 'session-state-1' ||
    !isString(document.engine) || !isString(document.platform) || !isString(document.appIdentity) || !isString(document.createdAt) ||
    (document.expiresAt !== undefined && !isString(document.expiresAt)) ||
    typeof document.secrecy !== 'object' || document.secrecy === null || !Array.isArray(document.secrecy.names) || !document.secrecy.names.every(isString) ||
    typeof state !== 'object' || state === null ||
    !isString(state.format) || !Number.isInteger(state.version) || state.algorithm !== 'A256GCM' ||
    !isString(state.iv) || !IV_PATTERN.test(state.iv) || !isString(state.tag) || !TAG_PATTERN.test(state.tag) || !isString(state.ciphertext)
  ) {
    throw new ConfigurationError('SESSION_INVALID', 'the session state is not a session-state-1 document');
  }
  return document as StateDocument;
}

/** Parses an authenticated payload; one `export` did not write is `SESSION_INVALID`. */
function parsePayload(text: string): StatePayload {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' || parsed === null || !('data' in parsed) || !('secrets' in parsed) ||
    !Array.isArray(parsed.secrets) ||
    !parsed.secrets.every((entry) => Array.isArray(entry) && entry.length === 2 && entry.every(isString))
  ) {
    throw new ConfigurationError('SESSION_INVALID', 'the session state has an unexpected payload');
  }
  return parsed as StatePayload;
}
