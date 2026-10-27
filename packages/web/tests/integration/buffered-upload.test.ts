/** Native multipart bytes survive interception without rewriting an HTTP body. */

import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PlaywrightSurface } from '../../src/surface.ts';
import { prepareUploadFiles, type FileUploadMode } from '../../src/upload-files.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Owns a loopback-only protocol fixture and disposes all of its resources. */
async function upload(mode: FileUploadMode, nativeChooser = false, redirect = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-buffered-native-'));
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\nFICTIONAL\n'), Buffer.from([0, 255, 128]), Buffer.alloc(2_000, 42)]);
  const selected = path.join(directory, 'fictional-rider.pdf');
  const sha = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
  await writeFile(selected, bytes);
  const received: { name: string; bytes: number; sha: string }[] = [];
  let redirected = 0, attempted = 0, admitted = false, routedBytes = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(async (req, res) => {
    if (req.url === '/redirected') { redirected++; res.end('unexpected'); return; }
    if (req.url !== '/upload' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of req) { count += chunk.length; if (count > 20_000) { req.destroy(); return; } chunks.push(chunk); }
    const form = await new Request('http://127.0.0.1/upload', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
    const actual = form.get('file') as File;
    received.push({ name: actual.name, bytes: actual.size, sha: sha(new Uint8Array(await actual.arrayBuffer())) });
    res.setHeader('access-control-allow-origin', '*');
    if (redirect) res.writeHead(307, { location: '/redirected' }).end();
    else res.setHeader('content-type', 'application/json').end('{"received":true}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const controller = new AbortController();
  const surface = new PlaywrightSurface({ fileUploads: mode });
  const operation = () => ({ signal: controller.signal, timeoutMs: 5_000, runId: 'upload', attemptId: 'upload', origin: 'test' as const });
  try {
    await surface.init({ runId: 'upload', targetName: 'web', projectRoot: directory, app: {}, env: {}, headed: false, workerSlot: 0, signal: controller.signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'upload', artifactsDir: directory, signal: controller.signal, resolveSecret: noSecrets, ...ignoreTrace });
    const page = await surface.ensurePage();
    await surface.requireContext().route('**/*', async route => {
      const request = route.request();
      if (request.url() !== `${origin}/upload` || request.method() !== 'POST') { await route.abort(); return; }
      attempted++;
      const body = request.postDataBuffer(); routedBytes = body?.length ?? 0;
      const form = await new Request(`${origin}/upload`, { method: 'POST', headers: { 'content-type': request.headers()['content-type']! }, body: new Uint8Array(body!) }).formData();
      const file = form.get('file') as File;
      admitted = [...form.keys()].join('|') === 'file|event_id' && form.get('event_id') === '55270' && file.name === 'fictional-rider.pdf' && file.type === 'application/pdf' && file.size === bytes.length && sha(new Uint8Array(await file.arrayBuffer())) === sha(bytes);
      if (!admitted) { await route.abort(); return; }
      // Same zero-follow transport used by guarded consumers. No postData override.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 5_000 });
      try {
        if (response.status() >= 300 && response.status() < 400) await route.abort();
        else await route.fulfill({ response });
      } finally { await response.dispose(); }
    });
    await page.setContent(`<input aria-label="Rider" type="file" ${nativeChooser ? 'hidden' : ''}><button onclick="document.querySelector('input').click()">Choose</button><script>document.querySelector('input').onchange=async e=>{const form=new FormData();form.append('file',e.target.files[0]);form.append('event_id','55270');try{const response=await fetch('${origin}/upload',{method:'POST',body:form});window.finished=response.status}catch{window.finished='refused'}}</script>`);
    if (nativeChooser) {
      const pending = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Choose' }).click();
      const chooser = await pending;
      const files = await prepareUploadFiles([selected], mode, operation());
      await chooser.setFiles(files, { timeout: 5_000 });
    } else {
      const snapshot = await surface.observe(operation());
      const find = (node: import('e2e/engine').SemanticNode): import('e2e/engine').SemanticNode | undefined => node.name === 'Rider' ? node : node.children?.map(find).find(Boolean);
      const input = find(snapshot.root); expect(input).toBeDefined();
      await surface.perform(input!.ref, { kind: 'setInputFiles', paths: [selected] }, operation());
    }
    await page.waitForFunction(() => (window as unknown as { finished?: unknown }).finished !== undefined, undefined, { timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { finished: unknown }).finished)).toBe(mode === 'buffered' && !redirect ? 200 : 'refused');
    expect(attempted).toBe(1);
    expect(redirected).toBe(0);
    if (mode === 'buffered') {
      expect(admitted).toBe(true); expect(routedBytes).toBeGreaterThan(bytes.length);
      expect(received).toEqual([{ name: 'fictional-rider.pdf', bytes: bytes.length, sha: sha(bytes) }]);
    } else {
      expect(admitted).toBe(false); expect(routedBytes).toBeLessThan(bytes.length); expect(received).toEqual([]);
    }
  } finally {
    controller.abort();
    try { await surface.endAttempt({ signal: new AbortController().signal, timeoutMs: 5_000 }); }
    finally {
      try { await surface.dispose({ signal: new AbortController().signal, timeoutMs: 5_000 }); }
      finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
    }
  }
}

it('preserves complete binary multipart through an observed file input and zero-follow fetch', () => upload('buffered'));
it('preserves complete binary multipart through the genuine native FileChooser API', () => upload('buffered', true));
it('keeps the disk-backed default control, whose omitted multipart file is refused before forwarding', () => upload('path', true));
it('does not follow a redirect after forwarding the complete authorized multipart once', () => upload('buffered', true, true));
