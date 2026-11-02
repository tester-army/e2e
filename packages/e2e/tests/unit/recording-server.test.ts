import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { json, useServers } from '../helpers/recording-server.ts';

const serve = useServers(afterEach);

/** Sends `GET /` to `url` with the `Host` header a local port watcher sends, and resolves its status. */
function probe(url: string, host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    sent.on('error', reject);
    sent.end();
  });
}

describe('the recording server', () => {
  it('answers a probe for another host 404 and keeps it out of the requests and the handler', async () => {
    const issuer = await serve((_request, response) => json(response, 200, { ok: true }));
    const { port } = new URL(issuer.url);
    expect(await probe(issuer.url, `localhost:${port}`)).toBe(404);
    expect(issuer.requests).toEqual([]);
    expect((await fetch(issuer.url)).status).toBe(200);
    expect(issuer.requests.map((received) => received.url)).toEqual(['/']);
  });
});
