/**
 * The protocol against a fake TesterArmy: the report goes up with the digests
 * on disk, only the missing bytes follow, completion names the run, and every
 * failure is one error the runner can print.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const call: Call = { url, method, headers, body };
    calls.push(call);
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
    deps = { env: { TESTERARMY_API_KEY: 'ta_secret' }, homeDir: path.join(dir, 'home'), readFile: (file) => readFile(file) };
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

  it('creates the run, uploads only the missing digests, completes, and names the run', async () => {
    const { fetch, calls } = fakeFetch({
      [`PUT /api/v1/e2e/runs/${RUN_ID}`]: () =>
        json(200, { url: 'https://tester.army/runs/x', uploads: [{ sha256: 'bbb', url: 'https://r2.test/bbb?sig=1' }] }),
      'PUT /bbb': () => new Response(null, { status: 200 }),
      [`POST /api/v1/e2e/runs/${RUN_ID}/complete`]: () => json(200, { url: 'https://tester.army/runs/x?done' }),
    });
    const rows = await uploadRun(
      finished(report([shot, trace, withheld])),
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
      // The withheld artifact has no file, so it is never offered.
      artifacts: [
        { sha256: 'aaa', size: 9, mediaType: 'image/png' },
        { sha256: 'bbb', size: 9, mediaType: 'application/zip' },
      ],
    });
    const bytes = calls[1]!;
    expect(bytes.headers['content-type']).toBe('application/zip');
    expect(Buffer.from(bytes.body as Uint8Array).toString()).toBe('zip-bytes');
    expect(bytes.headers['authorization']).toBeUndefined();
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

  it('falls back to the key testerarmy auth saved', async () => {
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
