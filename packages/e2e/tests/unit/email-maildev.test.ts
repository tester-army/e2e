/**
 * `maildev()` against a stand-in for MailDev's REST API: addresses made up
 * without a call past the first health check, listings kept to exactly one
 * address by envelope, To, or Cc (Bcc and letter case included), bodies read
 * by id, an address's mail deleted on release, and a MailDev that is not
 * running or rejects a request named in the error.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maildev } from '../../src/email/maildev.ts';

interface StoredEmail {
  id: string;
  time: string;
  subject: string;
  from: { address: string; name?: string }[];
  to: { address: string; name?: string }[];
  cc: { address: string }[];
  text?: string;
  html?: string;
  envelope: { to: { address: string }[] };
}

const store: StoredEmail[] = [];
const requests: string[] = [];
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(`${request.method} ${request.url}`);
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/api/healthz') return send(200, true);
    if (request.url === '/api/email' && request.method === 'GET') return send(200, store);
    if (request.url === '/api/email/delete' && request.method === 'POST') {
      const { ids } = JSON.parse(body) as { ids: string[] };
      for (const id of ids) {
        const index = store.findIndex((email) => email.id === id);
        if (index === -1) return send(404, { error: `no email ${id}` });
        store.splice(index, 1);
      }
      return send(200, true);
    }
    const one = /^\/api\/email\/([^/]+)$/u.exec(request.url ?? '');
    const email = store.find((candidate) => candidate.id === one?.[1]);
    return email === undefined ? send(404, { error: 'not found' }) : send(200, email);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  store.length = 0;
  requests.length = 0;
});

const context = { signal: new AbortController().signal, runId: 'run-1' };

/** Stores a message the way MailDev records one it caught. */
function catchMail(id: string, headers: { to: string[]; cc?: string[]; envelope?: string[]; subject: string; text?: string; html?: string }): void {
  store.push({
    id,
    time: '2026-09-30T08:00:00.000Z',
    subject: headers.subject,
    from: [{ address: 'noreply@acme.test', name: 'Acme' }],
    to: headers.to.map((address) => ({ address })),
    cc: (headers.cc ?? []).map((address) => ({ address })),
    ...(headers.text === undefined ? {} : { text: headers.text }),
    ...(headers.html === undefined ? {} : { html: headers.html }),
    envelope: { to: (headers.envelope ?? [...headers.to, ...(headers.cc ?? [])]).map((address) => ({ address })) },
  });
}

describe('maildev()', () => {
  it('makes up lowercase addresses on its domain, checking MailDev once', async () => {
    const provider = maildev({ url, domain: 'Mail.Test' });
    const first = await provider.acquire(context);
    const second = await provider.acquire(context);
    expect(first.address).toMatch(/^e2e-[0-9a-f]{12}@mail\.test$/u);
    expect(second.address).not.toBe(first.address);
    expect(requests).toEqual(['GET /api/healthz']);
    expect((await maildev({ url }).acquire(context)).address).toMatch(/@maildev\.test$/u);
  });

  it('lists exactly the mail delivered to the address: envelope, To, or Cc, any letter case', async () => {
    const provider = maildev({ url });
    const mine = await provider.acquire(context);
    const theirs = await provider.acquire(context);
    catchMail('a', { to: [mine.address], envelope: ['relay@acme.test'], subject: 'To' });
    catchMail('b', { to: ['someone@acme.test'], envelope: ['someone@acme.test', mine.address], subject: 'Bcc' });
    catchMail('c', { to: ['someone@acme.test'], cc: [mine.address.toUpperCase()], envelope: ['someone@acme.test'], subject: 'Cc, uppercased' });
    catchMail('d', { to: [theirs.address], subject: 'Theirs' });
    const listed = await provider.list(mine, context);
    expect(listed.map((summary) => summary.subject)).toEqual(['To', 'Bcc', 'Cc, uppercased']);
    expect(listed[0]).toEqual({ id: 'a', from: 'Acme <noreply@acme.test>', to: [mine.address], cc: [], subject: 'To', receivedAt: new Date('2026-09-30T08:00:00.000Z') });
    await expect(provider.read(mine, 'a', context)).resolves.toMatchObject({ subject: 'To' });
  });

  it('reads a body by id', async () => {
    const provider = maildev({ url });
    const lease = await provider.acquire(context);
    catchMail('m1', { to: [lease.address], subject: 'Verify', text: 'Code 482913', html: '<p>Code <b>482913</b></p>' });
    await expect(provider.read(lease, 'm1', context)).resolves.toMatchObject({ text: 'Code 482913', html: '<p>Code <b>482913</b></p>' });
  });

  it('deletes the address\'s mail on release, and nothing else', async () => {
    const provider = maildev({ url });
    const mine = await provider.acquire(context);
    catchMail('a', { to: [mine.address], subject: 'Mine' });
    catchMail('b', { to: ['other@acme.test'], subject: 'Other' });
    await provider.release(mine, context);
    expect(store.map((email) => email.id)).toEqual(['b']);
    requests.length = 0;
    await provider.release(mine, context);
    expect(requests).toEqual(['GET /api/email']);
  });

  it('keeps a message another live address also received until that address is released too', async () => {
    const provider = maildev({ url });
    const me = await provider.acquire(context);
    const teammate = await provider.acquire(context);
    catchMail('shared', { to: [teammate.address], envelope: [teammate.address, me.address], subject: 'Invite' });
    await provider.release(me, context);
    expect(store.map((email) => email.id)).toEqual(['shared']);
    await provider.release(teammate, context);
    expect(store).toEqual([]);
  });

  it('names the fix when MailDev is not running, and marks a rejected request as not worth retrying', async () => {
    await expect(maildev({ url: 'http://127.0.0.1:9' }).acquire(context)).rejects.toThrow(/^MailDev is not answering at http:\/\/127\.0\.0\.1:9 \(.+\); start it before the run, e\.g\. npx maildev, or pass maildev\(\{ url \}\)$/u);
    const provider = maildev({ url });
    const lease = await provider.acquire(context);
    await expect(provider.read(lease, 'missing', context)).rejects.toMatchObject({ retryable: false, message: 'MailDev answered 404 to GET /api/email/missing' });
  });
});
