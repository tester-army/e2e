/** Session envelope wire format. */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '../../src/internal/ids.ts';
import type { SavedSecrecy } from '../../src/run/secrecy.ts';
import { SessionStore, type SavedSession, type SessionIdentity } from '../../src/run/sessions.ts';
import { assertValidSessionEnvelope } from '../helpers/session-schema.ts';

const identity: SessionIdentity = {
  targetId: 'web',
  engineName: 'playwright',
  engineVersion: '1.61.1',
  spiVersion: 1,
  platform: 'web',
  appIdentity: 'a'.repeat(64),
};

const SECRET_VALUE = 'provider-minted-token-7391';

/** Temp dirs the cases in this file create, removed after each so a run leaves nothing behind. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Saves one state and returns the parsed envelope, its raw text, its file, and its store. */
async function saveEnvelope(
  secrecy: SavedSecrecy = { secrets: [], tainted: false },
): Promise<{ store: SessionStore; raw: string; file: string; envelope: Record<string, unknown> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
  tempDirs.push(root);
  const runId = uuidv7();
  const store = SessionStore.create(runId, root);
  await store.save('member', identity, {
    state: { format: 'playwright-state', version: 1, data: { cookies: [{ name: 'sid', value: 'abc' }] } },
    secrecy,
  });
  const [file] = await readdir(path.join(root, runId));
  expect(file).toMatch(/^web--member-[0-9a-f]{16}\.json$/);
  const raw = await readFile(path.join(root, runId, file!), 'utf8');
  return { store, raw, file: path.join(root, runId, file!), envelope: JSON.parse(raw) as Record<string, unknown> };
}

describe('session envelope', () => {
  it('carries learned secret values and the taint, naming the secrets in the clear and the values only inside the ciphertext', async () => {
    const { store, raw, envelope } = await saveEnvelope({
      secrets: [['token', SECRET_VALUE], ['token', 'rotated-token-0042']],
      tainted: true,
    });
    try {
      assertValidSessionEnvelope(envelope);
      expect((envelope.state as { algorithm: string }).algorithm).toBe('A256GCM');
      expect(envelope.secrecy).toEqual({ tainted: true, names: ['token'] });
      expect(raw).not.toContain(SECRET_VALUE);
      expect(raw).not.toContain('rotated-token-0042');
      const loaded = await store.load('member', identity);
      expect(loaded.state.data).toEqual({ cookies: [{ name: 'sid', value: 'abc' }] });
      expect(loaded.secrecy).toEqual({
        secrets: [['token', SECRET_VALUE], ['token', 'rotated-token-0042']],
        tainted: true,
      });
    } finally {
      store.cleanup();
    }
  });

  it('names every secret the config accepts: a long name and many names validate and round-trip', async () => {
    const longName = 'x'.repeat(300);
    const secrets = [
      [longName, SECRET_VALUE] as const,
      ...Array.from({ length: 300 }, (_, index) => [`token-${String(index)}`, `value-${String(index)}-padded`] as const),
    ];
    const { store, envelope } = await saveEnvelope({ secrets, tainted: true });
    try {
      assertValidSessionEnvelope(envelope);
      expect((envelope.secrecy as { names: string[] }).names).toHaveLength(301);
      const loaded = await store.load('member', identity);
      expect(loaded.secrecy.secrets).toEqual(secrets);
    } finally {
      store.cleanup();
    }
  });
});

describe('session load', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type Editable = { state: { ciphertext: string }; secrecy: { tainted: boolean }; expiresAt: string };

  /** Rewrites a saved envelope file through `edit`, as a tamperer with write access to it would. */
  async function tamper(file: string, edit: (envelope: Editable) => void): Promise<void> {
    const envelope = JSON.parse(await readFile(file, 'utf8')) as Editable;
    edit(envelope);
    await writeFile(file, JSON.stringify(envelope));
  }

  it('refuses a session saved for another app, engine, or platform', async () => {
    const { store } = await saveEnvelope();
    try {
      for (const other of [
        { ...identity, appIdentity: 'b'.repeat(64) },
        { ...identity, engineName: 'other' },
        { ...identity, engineVersion: '1.62.0' },
        { ...identity, platform: 'android' },
      ]) {
        await expect(store.load('member', other)).rejects.toMatchObject({ code: 'SESSION_MISMATCH' });
      }
      const loaded = await store.load('member', identity);
      expect(loaded.state.data).toEqual({ cookies: [{ name: 'sid', value: 'abc' }] });
      expect(loaded.secrecy).toEqual({ secrets: [], tainted: false });
    } finally {
      store.cleanup();
    }
  });

  it('refuses a session past its expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store } = await saveEnvelope();
    try {
      vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
      await expect(store.load('member', identity)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    } finally {
      store.cleanup();
    }
  });

  it('reuses a valid cached state but refuses it at its expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { store } = await saveEnvelope();
    try {
      const saved = await store.load('member', identity);
      const expiry = Date.parse(saved.state.expiresAt!);
      vi.setSystemTime(expiry - 1);
      expect(await store.load('member', identity)).toBe(saved);
      vi.setSystemTime(expiry);
      await expect(store.load('member', identity)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    } finally {
      store.cleanup();
    }
  });

  it('refuses a session whose ciphertext, taint, or expiry was edited, or that is not JSON', async () => {
    const edits: ((envelope: Editable) => void)[] = [
      (envelope) => {
        const bytes = Buffer.from(envelope.state.ciphertext, 'base64');
        bytes[0] = bytes[0]! ^ 1;
        envelope.state.ciphertext = bytes.toString('base64');
      },
      (envelope) => {
        envelope.secrecy.tainted = false;
      },
      (envelope) => {
        envelope.expiresAt = new Date(Date.parse(envelope.expiresAt) + 365 * 24 * 60 * 60 * 1000).toISOString();
      },
    ];
    for (const edit of edits) {
      const { store, file } = await saveEnvelope({ secrets: [['token', SECRET_VALUE]], tainted: true });
      try {
        await tamper(file, edit);
        await expect(store.load('member', identity)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
      } finally {
        store.cleanup();
      }
    }
    const { store, file } = await saveEnvelope();
    try {
      await writeFile(file, '{ "schemaVersion": "session-1", ');
      await expect(store.load('member', identity)).rejects.toMatchObject({ code: 'SESSION_INVALID' });
    } finally {
      store.cleanup();
    }
  });
});

describe('session file names', () => {
  /** Opens a store on a fresh temporary root. */
  async function openStore(): Promise<{ store: SessionStore; root: string; runId: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
    tempDirs.push(root);
    const runId = uuidv7();
    return { store: SessionStore.create(runId, root), root, runId };
  }

  /** A session whose payload names the pair that produced it. */
  function stateFor(targetId: string, name: string): SavedSession {
    return {
      state: { format: 'state', version: 1, data: { pair: `${targetId}/${name}` } },
      secrecy: { secrets: [], tainted: false },
    };
  }

  it('keeps two pairs whose joined names collide apart', async () => {
    const { store } = await openStore();
    const first: SessionIdentity = { ...identity, targetId: 'a--b' };
    const second: SessionIdentity = { ...identity, targetId: 'a' };
    try {
      await store.save('c', first, stateFor('a--b', 'c'));
      await store.save('b--c', second, stateFor('a', 'b--c'));
      const one = await store.load('c', first);
      const two = await store.load('b--c', second);
      expect(one.state.data).toEqual({ pair: 'a--b/c' });
      expect(two.state.data).toEqual({ pair: 'a/b--c' });
    } finally {
      store.cleanup();
    }
  });

  it('keeps a dot-joined and a dash-joined pair apart', async () => {
    const { store } = await openStore();
    const first: SessionIdentity = { ...identity, targetId: 'a.b' };
    const second: SessionIdentity = { ...identity, targetId: 'a-b' };
    try {
      await store.save('c', first, stateFor('a.b', 'c'));
      await store.save('c', second, stateFor('a-b', 'c'));
      expect((await store.load('c', first)).state.data).toEqual({ pair: 'a.b/c' });
      expect((await store.load('c', second)).state.data).toEqual({ pair: 'a-b/c' });
    } finally {
      store.cleanup();
    }
  });

  it('keeps the longest allowed names within the file name limit', async () => {
    const { store, root, runId } = await openStore();
    const longName = '-'.repeat(128);
    const longTarget = `${'a.b-'.repeat(60)}end`;
    const wide: SessionIdentity = { ...identity, targetId: longTarget };
    const twin: SessionIdentity = { ...identity, targetId: `${longTarget}x` };
    try {
      await store.save(longName, wide, stateFor(longTarget, longName));
      await store.save(longName, twin, stateFor(`${longTarget}x`, longName));
      const files = await readdir(path.join(root, runId));
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(Buffer.byteLength(file)).toBeLessThan(200);
      }
      expect((await store.load(longName, wide)).state.data).toEqual({
        pair: `${longTarget}/${longName}`,
      });
      expect((await store.load(longName, twin)).state.data).toEqual({
        pair: `${longTarget}x/${longName}`,
      });
    } finally {
      store.cleanup();
    }
  });

  it('keeps every session file inside the run directory', async () => {
    const { store, root, runId } = await openStore();
    const hostile: SessionIdentity = { ...identity, targetId: '../../escape' };
    try {
      await store.save('..', hostile, stateFor('../../escape', '..'));
      await store.save('x/y\\z', hostile, stateFor('../../escape', 'x/y\\z'));
      const files = await readdir(path.join(root, runId));
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(file).toMatch(/^[A-Za-z0-9_%-]+\.json$/);
      }
      expect(await readdir(root)).toEqual([runId]);
      expect((await store.load('..', hostile)).state.data).toEqual({ pair: '../../escape/..' });
    } finally {
      store.cleanup();
    }
  });
});
