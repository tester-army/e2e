/**
 * The protocol against a fake TesterArmy: the report goes up with the digests
 * on disk, only the missing bytes follow, completion names the run, and every
 * failure is one error the runner can print.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FinishedRun, Report } from '@e2edev/e2e';
import { uploadRun, type UploadDeps } from '../../src/upload.ts';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A fetch that records calls and answers from a script keyed by `METHOD path`. */
function fakeFetch(script: Record<string, (call: Call) => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    // A streamed body is drained here, the way storage would.
    const body =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : raw instanceof ReadableStream
          ? new Uint8Array(await new Response(raw).arrayBuffer())
          : raw;
    const call: Call = { url, method, headers, body };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    const key = `${method} ${new URL(url).pathname}`;
    const answer = script[key] ?? script[`${method} *`];
    if (answer === undefined) throw new Error(`unexpected request ${key}`);
    return answer(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const RUN_ID = '0192c5f0-1234-7abc-8def-0123456789ab';

function report(artifacts: readonly Record<string, unknown>[]): Report {
  return {
    schemaVersion: 'report-1',
    run: {
      id: RUN_ID,
      status: 'passed',
      exitCode: 0,
      results: [{ attempts: [{ artifacts }] }],
      serialGroups: [],
    },
  } as unknown as Report;
}

describe('uploadRun', () => {
  let dir: string;
  let deps: Omit<UploadDeps, 'fetch'>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'testerarmy-'));
    mkdirSync(path.join(dir, 'artifacts', 'web', 't1', 'attempt-1'), { recursive: true });
    writeFileSync(path.join(dir, 'artifacts', 'web', 't1', 'attempt-1', 'shot.png'), 'png-bytes');
    writeFileSync(path.join(dir, 'artifacts', 'web', 't1', 'attempt-1', 'trace.zip'), 'zip-bytes');
    deps = {
      env: { TESTERARMY_API_KEY: 'ta_secret' },
      homeDir: path.join(dir, 'home'),
      fileExists: (file) => access(file).then(() => true, () => false),
      readFile: (file) => readFile(file),
      openFile: (file, signal) => Readable.toWeb(createReadStream(file, { signal })) as ReadableStream<Uint8Array>,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function finished(document: Report): FinishedRun {
    return {
      report: document,
      status: 'passed',
      exitCode: 0,
      projectRoot: dir,
      reportPath: path.join(dir, 'report.json'),
      artifactsRoot: path.join(dir, 'artifacts'),
      aiTracePath: undefined,
    };
  }

  const shot = { kind: 'screenshot', mediaType: 'image/png', path: 'web/t1/attempt-1/shot.png', size: 9, sha256: 'aaa' };
  const trace = { kind: 'trace', mediaType: 'application/zip', path: 'web/t1/attempt-1/trace.zip', size: 9, sha256: 'bbb' };
  const withheld = { kind: 'screenshot', mediaType: 'image/png', redaction: 'incomplete' };
  const gone = { kind: 'video', mediaType: 'video/webm', path: 'web/t1/attempt-1/video.webm', size: 9, sha256: 'ddd' };
  const escaping = { kind: 'log', mediaType: 'text/plain', path: '../../../etc/passwd', size: 9, sha256: 'eee' };

  it('creates the run, uploads only the missing digests with the named headers, completes, and names the run', async () => {
    const { fetch, calls } = fakeFetch({
      [`PUT /api/v1/e2e/runs/${RUN_ID}`]: () =>
        json(200, {
          url: 'https://tester.army/runs/x',
          uploads: [{ sha256: 'bbb', url: 'https://r2.test/bbb?sig=1', headers: { 'content-type': 'application/zip', 'x-amz-checksum-sha256': 'u7s=' } }],
        }),
      'PUT /bbb': () => new Response(null, { status: 200 }),
      [`POST /api/v1/e2e/runs/${RUN_ID}/complete`]: () => json(200, { url: 'https://tester.army/runs/x?done' }),
    });
    const rows = await uploadRun(
      finished(report([shot, trace, withheld, gone, escaping])),
      new AbortController().signal,
      { apiKeyEnv: 'TESTERARMY_API_KEY', project: 'prj_1' },
      { ...deps, fetch },
    );

    expect(rows).toEqual([{ label: 'TesterArmy', text: 'https://tester.army/runs/x?done' }]);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      `PUT /api/v1/e2e/runs/${RUN_ID}`,
      'PUT /bbb',
      `POST /api/v1/e2e/runs/${RUN_ID}/complete`,
    ]);
    const create = calls[0]!;
    expect(create.headers['authorization']).toBe('Bearer ta_secret');
    expect(create.body).toMatchObject({
      project: 'prj_1',
      report: { run: { id: RUN_ID } },
      // The withheld artifact has no path, the recording's file is gone, and
      // the escaping path leaves the artifacts root: none is offered.
      artifacts: [
        { sha256: 'aaa', size: 9, mediaType: 'image/png' },
        { sha256: 'bbb', size: 9, mediaType: 'application/zip' },
      ],
    });
    expect((create.body as { artifacts: unknown[] }).artifacts).toHaveLength(2);
    const bytes = calls[1]!;
    // The headers the server named plus the length storage needs up front, nothing else.
    expect(bytes.headers).toEqual({ 'content-type': 'application/zip', 'x-amz-checksum-sha256': 'u7s=', 'content-length': '9' });
    expect(Buffer.from(bytes.body as Uint8Array).toString()).toBe('zip-bytes');
  });

  it('offers each digest once, sends the CI context, and honors the API URL variable', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT *': () => json(200, { url: 'https://staging.tester.army/runs/x', uploads: [] }),
      'POST *': () => json(200, {}),
    });
    const duplicate = { ...shot, path: 'web/t1/attempt-1/trace.zip' };
    const rows = await uploadRun(
      finished(report([shot, duplicate])),
      new AbortController().signal,
      { apiKeyEnv: 'MY_KEY' },
      {
        ...deps,
        fetch,
        env: {
          MY_KEY: 'k',
          TESTERARMY_BASE_URL: 'https://staging.tester.army/',
          GITHUB_ACTIONS: 'true',
          GITHUB_SHA: 'abc123',
          GITHUB_REF: 'refs/pull/42/merge',
          GITHUB_HEAD_REF: 'feature/x',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'tester-army/e2e',
          GITHUB_RUN_ID: '777',
        },
      },
    );
    // Completion without a url falls back to the url the creation named.
    expect(rows).toEqual([{ label: 'TesterArmy', text: 'https://staging.tester.army/runs/x' }]);
    expect(calls[0]!.url).toBe(`https://staging.tester.army/api/v1/e2e/runs/${RUN_ID}`);
    expect(calls[0]!.body).toMatchObject({
      artifacts: [{ sha256: 'aaa' }],
      context: {
        git: { sha: 'abc123', branch: 'feature/x', pullRequest: 42 },
        ci: { provider: 'github-actions', url: 'https://github.com/tester-army/e2e/actions/runs/777' },
      },
    });
    expect((calls[0]!.body as { artifacts: unknown[] }).artifacts).toHaveLength(1);
  });

  it('uploads nothing without a key and says how to get one', async () => {
    const { fetch, calls } = fakeFetch({});
    const rows = await uploadRun(finished(report([shot])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, {
      ...deps,
      fetch,
      env: { TESTERARMY_API_KEY: '  ' },
    });
    expect(rows).toEqual([
      { label: 'TesterArmy', text: 'not uploaded: set TESTERARMY_API_KEY or run `testerarmy auth` to upload runs' },
    ]);
    expect(calls).toEqual([]);
  });

  it('falls back to the key testerarmy auth saved, for tester.army only', async () => {
    mkdirSync(path.join(dir, 'home', '.config', 'testerarmy'), { recursive: true });
    writeFileSync(path.join(dir, 'home', '.config', 'testerarmy', 'config.json'), JSON.stringify({ apiKey: 'ta_stored' }));
    const { fetch, calls } = fakeFetch({
      'PUT *': () => json(200, { url: 'https://tester.army/runs/y', uploads: [] }),
      'POST *': () => json(200, { url: 'https://tester.army/runs/y' }),
    });
    const rows = await uploadRun(finished(report([])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, {
      ...deps,
      fetch,
      env: {},
    });
    expect(rows).toEqual([{ label: 'TesterArmy', text: 'https://tester.army/runs/y' }]);
    expect(calls[0]!.headers['authorization']).toBe('Bearer ta_stored');

    // Pointed at another host, the saved key stays home.
    const elsewhere = fakeFetch({});
    const skipped = await uploadRun(finished(report([])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, {
      ...deps,
      fetch: elsewhere.fetch,
      env: { TESTERARMY_BASE_URL: 'https://evil.example' },
    });
    expect(skipped[0]?.text).toContain('not uploaded');
    expect(elsewhere.calls).toEqual([]);
  });

  it('uploads missing digests at most four at a time', async () => {
    const digests = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (const digest of digests) writeFileSync(path.join(dir, 'artifacts', 'web', 't1', 'attempt-1', `f${digest}.png`), digest);
    const records = digests.map((digest) => ({ kind: 'screenshot', mediaType: 'image/png', path: `web/t1/attempt-1/f${digest}.png`, size: 1, sha256: `d${digest}` }));
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/')) {
        return init?.method === 'PUT'
          ? json(200, { url: 'u', uploads: digests.map((digest) => ({ sha256: `d${digest}`, url: `https://r2.test/d${digest}` })) })
          : json(200, { url: 'u' });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await uploadRun(finished(report(records)), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch: fetchImpl });
    expect(peak).toBe(4);
  });

  it('treats a server that leaves the protocol as an error naming what happened', async () => {
    const run = finished(report([shot]));
    const options = { apiKeyEnv: 'TESTERARMY_API_KEY' };
    const html = fakeFetch({ 'PUT *': () => new Response('<html>maintenance</html>', { status: 200 }) });
    await expect(uploadRun(run, new AbortController().signal, options, { ...deps, fetch: html.fetch })).rejects.toThrow(
      `TesterArmy answered PUT /api/v1/e2e/runs/${RUN_ID} with a body that is not JSON`,
    );

    const unknown = fakeFetch({ 'PUT *': () => json(200, { url: 'u', uploads: [{ sha256: 'zzz', url: 'https://r2.test/zzz' }] }) });
    await expect(uploadRun(run, new AbortController().signal, options, { ...deps, fetch: unknown.fetch })).rejects.toThrow(
      'TesterArmy asked for digest zzz, which the reporter did not offer',
    );

    const malformed = fakeFetch({ 'PUT *': () => json(200, { url: 'u', uploads: [{ sha256: 'aaa' }] }) });
    await expect(uploadRun(run, new AbortController().signal, options, { ...deps, fetch: malformed.fetch })).rejects.toThrow(
      'TesterArmy answered the run with a malformed uploads entry',
    );

    const noUrl = fakeFetch({ 'PUT *': () => json(200, { uploads: [] }) });
    await expect(uploadRun(run, new AbortController().signal, options, { ...deps, fetch: noUrl.fetch })).rejects.toThrow(
      'TesterArmy answered the run without its url',
    );
  });

  it('refuses to send the key over plain http to anything but a loopback host', async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(
      uploadRun(finished(report([])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, {
        ...deps,
        fetch,
        env: { TESTERARMY_API_KEY: 'k', TESTERARMY_BASE_URL: 'http://staging.example' },
      }),
    ).rejects.toThrow('TESTERARMY_BASE_URL must be https');
    expect(calls).toEqual([]);

    const local = fakeFetch({ 'PUT *': () => json(200, { url: 'u', uploads: [] }), 'POST *': () => json(200, { url: 'u' }) });
    await uploadRun(finished(report([])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, {
      ...deps,
      fetch: local.fetch,
      env: { TESTERARMY_API_KEY: 'k', TESTERARMY_BASE_URL: 'http://localhost:3000' },
    });
    expect(local.calls[0]!.url.startsWith('http://localhost:3000/')).toBe(true);
  });

  it('stops at once when the signal is already aborted', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT *': () => json(200, { url: 'u', uploads: [] }) });
    const controller = new AbortController();
    controller.abort(new Error('forced stop'));
    await expect(
      uploadRun(finished(report([shot])), controller.signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch }),
    ).rejects.toThrow('forced stop');
    expect(calls).toHaveLength(1);
  });

  it('names a rejected key, a failing route, and a failing storage upload', async () => {
    const rejected = fakeFetch({ 'PUT *': () => new Response('nope', { status: 401 }) });
    await expect(
      uploadRun(finished(report([shot])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch: rejected.fetch }),
    ).rejects.toThrow('TesterArmy rejected the API key in TESTERARMY_API_KEY');

    const failing = fakeFetch({ 'PUT *': () => new Response('quota exceeded', { status: 429 }) });
    await expect(
      uploadRun(finished(report([shot])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch: failing.fetch }),
    ).rejects.toThrow(`TesterArmy responded 429 to PUT /api/v1/e2e/runs/${RUN_ID}: quota exceeded`);

    const storage = fakeFetch({
      [`PUT /api/v1/e2e/runs/${RUN_ID}`]: () => json(200, { url: 'u', uploads: [{ sha256: 'aaa', url: 'https://r2.test/aaa' }] }),
      'PUT /aaa': () => new Response(null, { status: 500 }),
    });
    await expect(
      uploadRun(finished(report([shot])), new AbortController().signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch: storage.fetch }),
    ).rejects.toThrow('TesterArmy storage responded 500 while uploading shot.png');
  });

  it('passes the abort signal to every request', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      return json(200, { url: 'u', uploads: [{ sha256: 'aaa', url: 'https://r2.test/aaa' }] });
    }) as typeof fetch;
    const controller = new AbortController();
    await uploadRun(finished(report([shot])), controller.signal, { apiKeyEnv: 'TESTERARMY_API_KEY' }, { ...deps, fetch: fetchImpl });
    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });
});
