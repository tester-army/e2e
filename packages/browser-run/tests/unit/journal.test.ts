import { randomUUID } from 'node:crypto';
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
