/**
 * The BiDi client: commands matched to their responses by id, error
 * responses as `BidiError`, events to their listeners, and every command
 * failing once the transport drops.
 */

import { describe, expect, it } from 'vitest';
import { BidiError } from '../../src/bidi/connection.ts';
import { FakeBidi, settle } from '../helpers/bidi-fake.ts';

describe('BidiConnection', () => {
  it('resolves each command with its own response, whatever order they answer in', async () => {
    const fake = new FakeBidi()
      .on('browser.createUserContext', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { result: { userContext: 'slow' } };
      })
      .on('browsingContext.getTree', { result: { contexts: [] } });
    const [created, tree] = await Promise.all([
      fake.connection.send('browser.createUserContext', {}),
      fake.connection.send('browsingContext.getTree', {}),
    ]);
    expect(created).toEqual({ userContext: 'slow' });
    expect(tree).toEqual({ contexts: [] });
    expect(fake.sent.map((command) => command.id)).toEqual([1, 2]);
  });

  it('rejects an error response as a BidiError carrying the protocol code', async () => {
    const fake = new FakeBidi().on('browsingContext.navigate', { error: 'unknown error', message: 'net::ERR_NAME_NOT_RESOLVED' });
    const failure = fake.connection.send('browsingContext.navigate', { context: 'c', url: 'http://nope.test' });
    await expect(failure).rejects.toBeInstanceOf(BidiError);
    await expect(failure).rejects.toMatchObject({ error: 'unknown error', message: 'browsingContext.navigate: unknown error: net::ERR_NAME_NOT_RESOLVED' });
  });

  it('delivers events to their listeners until each unsubscribes', () => {
    const fake = new FakeBidi();
    const seen: string[] = [];
    const off = fake.connection.on('browsingContext.load', (event) => seen.push(event.context));
    fake.emit('browsingContext.load', { context: 'a', navigation: null, timestamp: 0, url: 'about:blank' });
    off();
    fake.emit('browsingContext.load', { context: 'b', navigation: null, timestamp: 0, url: 'about:blank' });
    expect(seen).toEqual(['a']);
  });

  it('fails commands in flight and every later one once the transport drops, and tells close listeners once', async () => {
    const fake = new FakeBidi().on('script.callFunction', () => new Promise(() => undefined));
    let closes = 0;
    fake.connection.onClose(() => {
      closes += 1;
    });
    const pending = fake.connection.send('script.callFunction', { functionDeclaration: '() => 1', target: { context: 'c' }, awaitPromise: false });
    await settle();
    fake.drop();
    fake.drop();
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: 'script.callFunction: the BiDi connection closed' });
    await expect(fake.connection.send('session.status', {})).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(fake.connection.isClosed).toBe(true);
    expect(closes).toBe(1);
  });
});
