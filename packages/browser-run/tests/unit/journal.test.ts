import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LeaseJournal } from '../../src/journal.ts';

it.each(['../outside', '/tmp/outside', '..', 'invalid-session'])('refuses a receipt path outside its session ID grammar: %s', async (id) => {
  const journal = new LeaseJournal('account', randomUUID(), 'cloudflare');
  try {
    await expect(journal.remember(id)).rejects.toThrow('requires a valid session ID');
    await expect(journal.forget(id)).rejects.toThrow('requires a valid session ID');
    expect(await journal.outstanding()).toEqual([]);
  } finally {
    await journal.prune();
  }
});

it('prunes only empty receipt directories and tolerates a directory already removed', async () => {
  const run = randomUUID();
  const journal = new LeaseJournal('account', run, 'cloudflare');
  const key = createHash('sha256').update(JSON.stringify(['account', run, 'cloudflare'])).digest('hex');
  const dir = path.join(tmpdir(), 'e2e-browser-run', key);
  const id = '11111111-1111-4111-8111-111111111111';
  try {
    await journal.remember(id);
    await journal.prune();
    expect(await journal.outstanding()).toEqual([id]);
    await journal.forget(id);
    await journal.prune();
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(journal.prune()).resolves.toBeUndefined();
  } finally {
    await journal.forget(id);
    await journal.prune();
  }
});
