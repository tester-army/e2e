/** Session envelope wire format. */

import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineState } from '../../src/engine/surface.ts';
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

/** Saves one state and returns both the parsed envelope and its store. */
async function saveEnvelope(): Promise<{ store: SessionStore; envelope: Record<string, unknown> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
  const runId = uuidv7();
  const store = SessionStore.create(runId, root);
  await store.save('member', identity, {
    format: 'playwright-state',
    version: 1,
    data: { cookies: [{ name: 'sid', value: 'abc' }] },
  });
  const raw = await readFile(path.join(root, runId, 'web--member.json'), 'utf8');
  return { store, envelope: JSON.parse(raw) as Record<string, unknown> };
}

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
      expect(loaded.data).toEqual({ cookies: [{ name: 'sid', value: 'abc' }] });
    } finally {
      store.cleanup();
    }
  });

  it('accepts the canonical valid fixture', () => {
    assertValidSessionEnvelope(specFixture('session-v1.valid.json'));
  });

  it('rejects the canonical invalid fixture', () => {
    expect(isValidSessionEnvelope(specFixture('session-v1.invalid.json'))).toBe(false);
  });
});

describe('session file names', () => {
  /** Opens a store on a fresh temporary root. */
  async function openStore(): Promise<{ store: SessionStore; root: string; runId: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'e2e-sessions-'));
    const runId = uuidv7();
    return { store: SessionStore.create(runId, root), root, runId };
  }

  /** A state whose payload names the pair that produced it. */
  function stateFor(targetId: string, name: string): EngineState {
    return { format: 'state', version: 1, data: { pair: `${targetId}/${name}` } };
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
      expect(one.data).toEqual({ pair: 'a--b/c' });
      expect(two.data).toEqual({ pair: 'a/b--c' });
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
      expect((await store.load('c', first)).data).toEqual({ pair: 'a.b/c' });
      expect((await store.load('c', second)).data).toEqual({ pair: 'a-b/c' });
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
      expect((await store.load('..', hostile)).data).toEqual({ pair: '../../escape/..' });
    } finally {
      store.cleanup();
    }
  });
});
