/** Session envelope wire format. */

import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/internal/ids.ts';
import { SessionStore, type SessionIdentity } from '../../src/run/sessions.ts';
import {
  assertValidSessionEnvelope,
  isValidSessionEnvelope,
  specFixture,
} from '../helpers/session-schema.ts';

const identity: SessionIdentity = {
  targetId: 'web',
  engineName: 'playwright',
  engineVersion: '1.61.1',
  spiVersion: 1,
  platform: 'web',
  appIdentity: 'a'.repeat(64),
};

const PLAINTEXT = { cookies: [{ name: 'sid', value: 'plaintext-cookie-value' }] };

/** Saves one state and returns the parsed envelope, its store, and the file it lives in. */
async function saveEnvelope(): Promise<{
  store: SessionStore;
  envelope: Record<string, unknown>;
  file: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
  const runId = uuidv7();
  const store = SessionStore.create(runId, root);
  await store.save('member', identity, {
    format: 'playwright-state',
    version: 1,
    data: PLAINTEXT,
  });
  const file = path.join(root, runId, 'web--member.json');
  const raw = await readFile(file, 'utf8');
  return { store, envelope: JSON.parse(raw) as Record<string, unknown>, file };
}

/**
 * Rewrites the saved envelope with `state` fields replaced and loads it,
 * returning the rejection.
 */
async function loadTampered(state: Record<string, unknown>): Promise<unknown> {
  const { store, envelope, file } = await saveEnvelope();
  try {
    const tampered = { ...envelope, state: { ...(envelope.state as Record<string, unknown>), ...state } };
    await writeFile(file, JSON.stringify(tampered), 'utf8');
    return await store.load('member', identity).then(
      () => undefined,
      (cause: unknown) => cause,
    );
  } finally {
    store.cleanup();
  }
}

/** Every message on the error and its cause chain, joined. */
function messagesOf(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join('\n');
}

/** Sets a directory's mtime to `ageMs` ago. */
function ageDirectory(directory: string, ageMs: number): void {
  const then = new Date(Date.now() - ageMs);
  utimesSync(directory, then, then);
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('session envelope', () => {
  it('produces an envelope that validates against session-v1.schema.json', async () => {
    const { store, envelope } = await saveEnvelope();
    try {
      assertValidSessionEnvelope(envelope);
      expect((envelope.state as { algorithm: string }).algorithm).toBe('A256GCM');
    } finally {
      store.cleanup();
    }
  });

  it('round-trips the produced envelope', async () => {
    const { store } = await saveEnvelope();
    try {
      const loaded = await store.load('member', identity);
      expect(loaded.data).toEqual(PLAINTEXT);
    } finally {
      store.cleanup();
    }
  });

  describe('a tampered envelope is SESSION_INVALID', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing iv', { iv: undefined }],
      ['empty iv', { iv: '' }],
      ['numeric tag', { tag: 12345 }],
      ['short tag', { tag: Buffer.from('abc').toString('base64') }],
      ['non-string ciphertext', { ciphertext: { hex: 'deadbeef' } }],
      ['flipped ciphertext', { ciphertext: Buffer.from('not the ciphertext').toString('base64') }],
    ];
    for (const [label, state] of cases) {
      it(label, async () => {
        const error = await loadTampered(state);
        expect(error).toMatchObject({ category: 'configuration', code: 'SESSION_INVALID' });
        const messages = messagesOf(error);
        expect(messages).not.toContain('plaintext-cookie-value');
        expect(messages).not.toContain('cookies');
        expect(messages).not.toContain('sid');
      });
    }
  });

  it('accepts the canonical valid fixture', () => {
    assertValidSessionEnvelope(specFixture('session-v1.valid.json'));
  });

  it('rejects the canonical invalid fixture', () => {
    expect(isValidSessionEnvelope(specFixture('session-v1.invalid.json'))).toBe(false);
  });
});

describe('stale run directories', () => {
  it('create sweeps siblings older than a session may live and nothing else', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
    const stale = path.join(root, 'stale-run');
    const fresh = path.join(root, 'fresh-run');
    const current = path.join(root, 'current-run');
    const outside = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-outside-'));
    for (const directory of [stale, fresh, current]) {
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(path.join(directory, 'web--acct.json'), '{}', { mode: 0o600 });
    }
    writeFileSync(path.join(outside, 'web--acct.json'), '{}');
    symlinkSync(outside, path.join(root, 'linked-run'));
    writeFileSync(path.join(root, 'stray.json'), '{}');
    ageDirectory(stale, 2 * DAY_MS);
    ageDirectory(current, 2 * DAY_MS);
    ageDirectory(outside, 2 * DAY_MS);
    ageDirectory(fresh, DAY_MS / 2);

    SessionStore.create('current-run', root);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(path.join(root, 'linked-run'))).toBe(true);
    expect(existsSync(path.join(outside, 'web--acct.json'))).toBe(true);
    expect(existsSync(path.join(root, 'stray.json'))).toBe(true);
  });

  it('create tolerates a sessions root that does not exist yet', () => {
    const root = path.join(tmpdir(), `e2e-sessions-missing-${uuidv7()}`);
    expect(() => SessionStore.create('run', root)).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });
});
