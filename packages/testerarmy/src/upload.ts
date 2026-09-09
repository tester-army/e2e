/**
 * The upload protocol, three requests against the TesterArmy API:
 *
 * 1. `PUT /api/v1/e2e/runs/{runId}` with the report-1 document, the CI
 *    context, and the digests of the artifacts on disk. The run id is the
 *    report's own, so a retry is idempotent. The response names the run's
 *    URL and, per digest the server lacks, a presigned upload URL with the
 *    headers to send.
 * 2. One `PUT` of the bytes per missing digest, straight to storage, with
 *    exactly the headers the server named.
 * 3. `POST /api/v1/e2e/runs/{runId}/complete`, which verifies the uploads and
 *    returns the final URL.
 *
 * Every request carries the reporter's abort signal, so an abandoned upload
 * stops where it is. Anything the server does outside this protocol is an
 * error naming itself, never a silent skip: the runner prints one line.
 *
 * The key comes from the environment, or from the file `testerarmy auth`
 * writes, so a laptop that already talks to TesterArmy uploads with no setup.
 * The variables are the ones the `testerarmy` CLI reads, so one shell
 * configures both tools.
 */

import path from 'node:path';
import type { FinishedRun, Report, ReporterSummary } from '@e2edev/e2e';
import { detectContext, envValue } from './context.ts';

export const DEFAULT_API_KEY_ENV = 'TESTERARMY_API_KEY';
const BASE_URL_ENV = 'TESTERARMY_BASE_URL';
const DEFAULT_BASE_URL = 'https://tester.army';
/** Where `testerarmy auth` stores the key, relative to the home directory. */
const CLI_CONFIG_FILE = ['.config', 'testerarmy', 'config.json'];
const API_KEYS_PAGE = 'https://tester.army/dashboard/profile/api-keys';
const UPLOAD_CONCURRENCY = 4;
const SUMMARY_LABEL = 'TesterArmy';

export interface UploadOptions {
  readonly project?: string;
  readonly apiKeyEnv: string;
}

/** What the upload touches outside itself, so tests run it against a fake. */
export interface UploadDeps {
  readonly fetch: typeof fetch;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly fileExists: (file: string) => Promise<boolean>;
  readonly readFile: (file: string) => Promise<Uint8Array>;
}

/** An artifact the report names and the disk has: what the server may ask for. */
interface UploadableArtifact {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly file: string;
}

interface ArtifactUpload {
  readonly sha256: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface CreateRunResponse {
  readonly url: string;
  readonly uploads: readonly ArtifactUpload[];
}

/** Uploads one finished run and resolves with the summary row naming it. */
export async function uploadRun(
  run: FinishedRun,
  signal: AbortSignal,
  options: UploadOptions,
  deps: UploadDeps,
): Promise<ReporterSummary> {
  const baseUrl = (envValue(deps.env, BASE_URL_ENV) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  // The saved key was issued by tester.army and goes nowhere else: a config
  // that points the reporter at another host must also name a key for it.
  const apiKey =
    envValue(deps.env, options.apiKeyEnv) ??
    (baseUrl === DEFAULT_BASE_URL ? await storedApiKey(deps) : undefined);
  if (apiKey === undefined) {
    return [
      {
        label: SUMMARY_LABEL,
        text: `not uploaded: set ${options.apiKeyEnv} or run \`testerarmy auth\` to upload runs`,
      },
    ];
  }
  const runPath = `/api/v1/e2e/runs/${encodeURIComponent(run.report.run.id)}`;
  const request = async (method: 'PUT' | 'POST', route: string, body: unknown): Promise<unknown> => {
    const response = await deps.fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new Error(`TesterArmy rejected the API key in ${options.apiKeyEnv}; keys are at ${API_KEYS_PAGE}`);
    }
    if (!response.ok) {
      const detail = text.slice(0, 200);
      throw new Error(
        `TesterArmy responded ${response.status} to ${method} ${route}${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`TesterArmy answered ${method} ${route} with a body that is not JSON`);
    }
  };

  const artifacts = await collectArtifacts(run.report, run.artifactsRoot, deps);
  const created = parseCreateRunResponse(
    await request('PUT', runPath, {
      report: run.report,
      context: detectContext(deps.env),
      ...(options.project === undefined ? {} : { project: options.project }),
      artifacts: artifacts.map(({ sha256, size, mediaType }) => ({ sha256, size, mediaType })),
    }),
  );

  const bySha = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]));
  const pending = created.uploads.map((upload) => {
    const artifact = bySha.get(upload.sha256);
    if (artifact === undefined) {
      throw new Error(`TesterArmy asked for digest ${upload.sha256}, which the reporter did not offer`);
    }
    return { artifact, upload };
  });
  await inBatches(pending, UPLOAD_CONCURRENCY, async ({ artifact, upload }) => {
    const bytes = await deps.readFile(artifact.file);
    const response = await deps.fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: bytes,
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `TesterArmy storage responded ${response.status} while uploading ${path.basename(artifact.file)}`,
      );
    }
  });

  const completed = await request('POST', `${runPath}/complete`, {});
  const url = isRecord(completed) && typeof completed['url'] === 'string' ? completed['url'] : created.url;
  return [{ label: SUMMARY_LABEL, text: url }];
}

/**
 * Every artifact record with a digest whose file is on disk under the
 * artifacts root, once per digest. A record whose file is gone (a recording
 * that never finalized, a cleaned directory) is simply not offered.
 */
async function collectArtifacts(
  report: Report,
  artifactsRoot: string,
  deps: Pick<UploadDeps, 'fileExists'>,
): Promise<UploadableArtifact[]> {
  const root = path.resolve(artifactsRoot);
  const seen = new Map<string, UploadableArtifact>();
  const attempts = [
    ...report.run.results.flatMap((result) => result.attempts),
    ...report.run.serialGroups.flatMap((group) => group.attempts),
  ];
  for (const attempt of attempts) {
    for (const artifact of attempt.artifacts) {
      if (artifact.path === undefined || artifact.sha256 === undefined || artifact.size === undefined) continue;
      if (seen.has(artifact.sha256)) continue;
      const file = path.resolve(root, ...artifact.path.split('/'));
      if (!file.startsWith(`${root}${path.sep}`)) continue;
      if (!(await deps.fileExists(file))) continue;
      seen.set(artifact.sha256, {
        sha256: artifact.sha256,
        size: artifact.size,
        mediaType: artifact.mediaType,
        file,
      });
    }
  }
  return [...seen.values()];
}

function parseCreateRunResponse(value: unknown): CreateRunResponse {
  if (!isRecord(value) || typeof value['url'] !== 'string') {
    throw new Error('TesterArmy answered the run without its url');
  }
  const uploads = value['uploads'] ?? [];
  if (!Array.isArray(uploads)) throw new Error('TesterArmy answered the run with malformed uploads');
  return {
    url: value['url'],
    uploads: uploads.map((entry: unknown): ArtifactUpload => {
      if (!isRecord(entry) || typeof entry['sha256'] !== 'string' || typeof entry['url'] !== 'string') {
        throw new Error('TesterArmy answered the run with a malformed uploads entry');
      }
      const headers = entry['headers'] ?? {};
      if (!isRecord(headers) || Object.values(headers).some((header) => typeof header !== 'string')) {
        throw new Error(`TesterArmy named malformed upload headers for digest ${entry['sha256']}`);
      }
      return { sha256: entry['sha256'], url: entry['url'], headers: headers as Record<string, string> };
    }),
  };
}

async function inBatches<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(work));
  }
}

/** The key `testerarmy auth` saved, when there is one; any unreadable file means none. */
async function storedApiKey(deps: UploadDeps): Promise<string | undefined> {
  try {
    const raw = await deps.readFile(path.join(deps.homeDir, ...CLI_CONFIG_FILE));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    const key = isRecord(parsed) ? parsed['apiKey'] : undefined;
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
