import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http, { createServer, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadVerified, mirrorOrigin } from '../../src/install/download.ts';
import { sha256Of, startArchiveServer, type ArchiveServer } from '../helpers/archive-server.ts';

const BODY = Buffer.from('a browser archive');

let server: ArchiveServer;
let dir = '';

beforeEach(async () => {
  server = await startArchiveServer();
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-download-'));
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('downloadVerified', () => {
  it('keeps a body whose SHA-256 matches', async () => {
    server.route('/a.zip', BODY);
    const file = path.join(dir, 'a.zip');
    await downloadVerified(`${server.origin}/a.zip`, file, { sha256: sha256Of(BODY), env: {} });
    expect(readFileSync(file)).toEqual(BODY);
    expect(readdirSync(dir)).toEqual(['a.zip']);
  });

  it('refuses a body with another SHA-256, naming both, and keeps nothing', async () => {
    server.route('/a.zip', BODY);
    const expected = '0'.repeat(64);
    await expect(downloadVerified(`${server.origin}/a.zip`, path.join(dir, 'a.zip'), { sha256: expected, env: {} })).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_FAILED',
      message: `download of ${server.origin}/a.zip has SHA-256 ${sha256Of(BODY)}, expected ${expected}; refusing it`,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('fails an HTTP error with BROWSER_INSTALL_FAILED naming the URL', async () => {
    await expect(downloadVerified(`${server.origin}/missing.zip`, path.join(dir, 'a.zip'), { sha256: sha256Of(BODY), env: {} })).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_FAILED',
      message: `download of ${server.origin}/missing.zip failed: 404 Not Found`,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the partial body when the download is aborted midway', async () => {
    const controller = new AbortController();
    server.route('/slow.zip', (_request, response) => {
      response.writeHead(200, { 'content-length': '1000000' });
      response.write(Buffer.alloc(1000), () => controller.abort());
    });
    await expect(downloadVerified(`${server.origin}/slow.zip`, path.join(dir, 'a.zip'), { sha256: sha256Of(BODY), env: {}, signal: controller.signal })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  // Node 22 has no setGlobalProxyFromEnv; there NODE_USE_ENV_PROXY=1 proxies every fetch instead.
  describe.skipIf(typeof (http as Partial<typeof http>).setGlobalProxyFromEnv !== 'function')('through a proxy', () => {
    let proxy: ReturnType<typeof createServer>;
    let proxyOrigin = '';
    const proxied: string[] = [];

    beforeEach(async () => {
      proxied.length = 0;
      // Node's proxy agent tunnels every request with CONNECT; the tunnel ends at the archive server whatever host it names.
      proxy = createServer();
      proxy.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
        proxied.push(request.url ?? '');
        const upstream = connect(Number(new URL(server.origin).port), '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const address = proxy.address();
      if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
      proxyOrigin = `http://127.0.0.1:${String(address.port)}`;
    });

    afterEach(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });

    it('routes the download through HTTP_PROXY, and leaves the process dispatcher alone', async () => {
      const dispatcher = Symbol.for('undici.globalDispatcher.1');
      const before = (globalThis as Record<symbol, unknown>)[dispatcher];
      server.route('/a.zip', BODY);
      const file = path.join(dir, 'a.zip');
      await downloadVerified('http://archive.example.test/a.zip', file, { sha256: sha256Of(BODY), env: { HTTP_PROXY: proxyOrigin } });
      expect(proxied).toEqual(['archive.example.test:80']);
      expect(readFileSync(file)).toEqual(BODY);
      expect((globalThis as Record<symbol, unknown>)[dispatcher]).toBe(before);
    });

    it('goes direct to a host NO_PROXY names', async () => {
      server.route('/a.zip', BODY);
      const file = path.join(dir, 'a.zip');
      await downloadVerified(`${server.origin}/a.zip`, file, { sha256: sha256Of(BODY), env: { HTTP_PROXY: proxyOrigin, NO_PROXY: '127.0.0.1' } });
      expect(proxied).toEqual([]);
      expect(existsSync(file)).toBe(true);
    });
  });
});

describe('mirrorOrigin', () => {
  it('is undefined when unset or empty', () => {
    expect(mirrorOrigin({})).toBeUndefined();
    expect(mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: '' })).toBeUndefined();
  });

  it('takes https anywhere and http on loopback, without a trailing slash', () => {
    expect(mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: 'https://mirror.example.com/' })).toBe('https://mirror.example.com');
    expect(mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080');
    expect(mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: 'http://localhost:8080' })).toBe('http://localhost:8080');
    expect(mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: 'http://[::1]:8080' })).toBe('http://[::1]:8080');
  });

  it.each(['http://mirror.example.com', 'ftp://mirror.example.com', 'mirror.example.com'])('refuses %s', (value) => {
    expect(() => mirrorOrigin({ E2E_BROWSERS_DOWNLOAD_HOST: value })).toThrow(expect.objectContaining({ code: 'BROWSER_INSTALL_FAILED' }));
  });
});
