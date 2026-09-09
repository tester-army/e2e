/**
 * The upload protocol, three requests against the TesterArmy API:
 *
 * 1. `PUT /api/v1/e2e/runs/{runId}` with the report-1 document, the CI
 *    context, and the digests of the artifacts on disk. The run id is the
 *    report's own, so a retry is idempotent. The response names the run's
 *    URL and a presigned upload URL for every digest the server lacks.
 * 2. One `PUT` of the bytes per missing digest, straight to storage.
 * 3. `POST /api/v1/e2e/runs/{runId}/complete`, which verifies the uploads and
 *    returns the final URL.
 *
 * Every request carries the reporter's abort signal, so an abandoned upload
 * stops where it is.
 *
 * The key comes from the environment, or from the file `testerarmy auth`
 * writes, so a laptop that already talks to TesterArmy uploads with no setup.
 * The variables are the ones the `testerarmy` CLI reads, so one shell
 * configures both tools.
 */

import path from 'node:path';
import type { FinishedRun, Report, ReporterSummary } from '@e2edev/e2e';
import { detectContext } from './context.ts';

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
  readonly readFile: (file: string) => Promise<Uint8Array>;
}

/** An artifact the report names and the disk has: what the server may ask for. */
interface UploadableArtifact {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly file: string;
}

interface CreateRunResponse {
  readonly url: string;
  readonly uploads: readonly { readonly sha256: string; readonly url: string }[];
}

/** A failure the reporter reports in one line; the runner prints it. */
class TesterArmyError extends Error {}

/** Uploads one finished run and resolves with the summary row naming it. */
export async function uploadRun(
  run: FinishedRun,
  signal: AbortSignal,
  options: UploadOptions,
  deps: UploadDeps,
): Promise<ReporterSummary> {
  const apiKey = envValue(deps.env, options.apiKeyEnv) ?? (await storedApiKey(deps));
  if (apiKey === undefined) {
    return [
      {
        label: SUMMARY_LABEL,
        text: `not uploaded: set ${options.apiKeyEnv} or run \`testerarmy auth\` to upload runs`,
      },
    ];
  }
  const baseUrl = (envValue(deps.env, BASE_URL_ENV) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
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
    if (response.status === 401 || response.status === 403) {
      throw new TesterArmyError(
        `TesterArmy rejected the API key in ${options.apiKeyEnv}; keys are at ${API_KEYS_PAGE}`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new TesterArmyError(
        `TesterArmy responded ${response.status} to ${method} ${route}${detail === '' ? '' : `: ${detail}`}`,
      );
    }
    return response.json();
  };

  const artifacts = collectArtifacts(run.report, run.artifactsRoot);
  const created = parseCreateRunResponse(
    await request('PUT', runPath, {
      report: run.report,
      context: detectContext(deps.env),
      ...(options.project === undefined ? {} : { project: options.project }),
      artifacts: artifacts.map(({ sha256, size, mediaType }) => ({ sha256, size, mediaType })),
    }),
  );

  const bySha = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]));
  const pending = created.uploads.flatMap((upload) => {
    const artifact = bySha.get(upload.sha256);
    return artifact === undefined ? [] : [{ artifact, url: upload.url }];
  });
  await inBatches(pending, UPLOAD_CONCURRENCY, async ({ artifact, url }) => {
    const bytes = await deps.readFile(artifact.file);
    const response = await deps.fetch(url, {
      method: 'PUT',
      headers: { 'content-type': artifact.mediaType, 'content-length': String(bytes.byteLength) },
      body: bytes,
      signal,
    });
    if (!response.ok) {
      throw new TesterArmyError(
        `TesterArmy storage responded ${response.status} while uploading ${path.basename(artifact.file)}`,
      );
    }
  });

  const completed = await request('POST', `${runPath}/complete`, {});
  const url = isRecord(completed) && typeof completed['url'] === 'string' ? completed['url'] : created.url;
  return [{ label: SUMMARY_LABEL, text: url }];
}

/** Every artifact record with a file, a size, and a digest, once per digest. */
function collectArtifacts(report: Report, artifactsRoot: string): UploadableArtifact[] {
  const seen = new Map<string, UploadableArtifact>();
  const attempts = [
    ...report.run.results.flatMap((result) => result.attempts),
    ...report.run.serialGroups.flatMap((group) => group.attempts),
  ];
  for (const attempt of attempts) {
    for (const artifact of attempt.artifacts) {
      if (artifact.path === undefined || artifact.sha256 === undefined || artifact.size === undefined) continue;
      if (seen.has(artifact.sha256)) continue;
      seen.set(artifact.sha256, {
        sha256: artifact.sha256,
        size: artifact.size,
        mediaType: artifact.mediaType,
        file: path.join(artifactsRoot, ...artifact.path.split('/')),
      });
    }
  }
  return [...seen.values()];
}

function parseCreateRunResponse(value: unknown): CreateRunResponse {
  if (!isRecord(value) || typeof value['url'] !== 'string') {
    throw new TesterArmyError('TesterArmy answered the run without its url');
  }
  const uploads = Array.isArray(value['uploads']) ? value['uploads'] : [];
  return {
    url: value['url'],
    uploads: uploads.flatMap((entry: unknown) =>
      isRecord(entry) && typeof entry['sha256'] === 'string' && typeof entry['url'] === 'string'
        ? [{ sha256: entry['sha256'], url: entry['url'] }]
        : [],
    ),
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

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
