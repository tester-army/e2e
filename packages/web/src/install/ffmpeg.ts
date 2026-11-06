/**
 * The ffmpeg that encodes Chromium's screencast: a system one with VP9, or
 * the pinned ffmpeg-static build downloaded into the browsers cache on first
 * recording.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, createReadStream, createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { EngineError, InfrastructureError } from 'e2e/engine';
import { installArchive } from './builds.ts';
import { mirrorOrigin } from './download.ts';
import { cancelledCheck, withCacheLock } from './lock.ts';
import { browsersPath } from './provision.ts';

/** The ffmpeg-static release that encodes Chromium's screencast when the system has none with VP9, as a path on `FFMPEG_HOST`. */
const FFMPEG_RELEASE = '/eugeneware/ffmpeg-static/releases/download/b6.1.1';

/** Where `FFMPEG_RELEASE` is downloaded from, unless `E2E_BROWSERS_DOWNLOAD_HOST` names a mirror. */
const FFMPEG_HOST = 'https://github.com';

/** The SHA-256 of each platform's gzipped ffmpeg in `FFMPEG_RELEASE`. */
const FFMPEG_SHA256: Readonly<Record<string, string>> = {
  'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
};

/** Whether `executable` runs and lists the VP9 encoder the screencast needs. */
function encodesVp9(executable: string): boolean {
  const result = spawnSync(executable, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.includes('libvpx-vp9');
}

/** The cached ffmpeg's directory. */
function cachedFfmpegDirectory(env: NodeJS.ProcessEnv): string {
  return path.join(browsersPath(env), 'ffmpeg-b6.1.1');
}

/** The cached ffmpeg's path for this platform. */
function cachedFfmpeg(env: NodeJS.ProcessEnv): string {
  return path.join(cachedFfmpegDirectory(env), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

/** The ffmpeg found on the system, memoized: `E2E_FFMPEG_PATH`, else `ffmpeg` on the PATH, when it encodes VP9. */
let systemFfmpeg: string | null | undefined;

/**
 * The ffmpeg that encodes Chromium's screencast: `E2E_FFMPEG_PATH`, else a
 * system `ffmpeg` with VP9, else the one `ensureFfmpeg` cached; undefined
 * when there is none yet.
 */
function ffmpegExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env['E2E_FFMPEG_PATH'];
  if (configured !== undefined && configured !== '') return configured;
  const cached = cachedFfmpeg(env);
  if (existsSync(cached)) return cached;
  systemFfmpeg ??= encodesVp9('ffmpeg') ? 'ffmpeg' : null;
  return systemFfmpeg ?? undefined;
}

/** What `ensureFfmpeg` reports to and stops on. */
export interface FfmpegContext {
  /** Receives what it downloads; silent when omitted. */
  readonly log?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * The ffmpeg that encodes Chromium's screencast, downloading the pinned
 * build into the browsers cache when the system has none: from the
 * `E2E_BROWSERS_DOWNLOAD_HOST` mirror when set, checked against its
 * SHA-256, under the cache's install lock. Throws `UNSUPPORTED_CAPABILITY`
 * on a platform with no pinned build, and `BROWSER_INSTALL_FAILED` when the
 * download fails.
 */
export async function ensureFfmpeg(env: NodeJS.ProcessEnv, context: FfmpegContext = {}): Promise<string> {
  const existing = ffmpegExecutable(env);
  if (existing !== undefined) return existing;
  const key = `${process.platform}-${process.arch}`;
  const sha256 = FFMPEG_SHA256[key];
  if (sha256 === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `recording video on chromium needs an ffmpeg with libvpx-vp9, and none is pinned for ${key}: set E2E_FFMPEG_PATH`, { retryable: false });
  }
  const executable = cachedFfmpeg(env);
  const log = context.log ?? (() => undefined);
  await withCacheLock(browsersPath(env), { log, signal: context.signal }, async (owner) => {
    if (existsSync(executable)) return;
    const url = `${mirrorOrigin(env) ?? FFMPEG_HOST}${FFMPEG_RELEASE}/ffmpeg-${key}.gz`;
    log(`Downloading ffmpeg from ${url}`);
    try {
      await installArchive({
        url,
        sha256,
        target: cachedFfmpegDirectory(env),
        isInstalled: () => existsSync(executable),
        unpack: async (archive, root) => {
          const file = path.join(root, path.basename(executable));
          await pipeline(createReadStream(archive), createGunzip(), createWriteStream(file), context.signal === undefined ? {} : { signal: context.signal });
          chmodSync(file, 0o755);
        },
        owner,
        env,
        signal: context.signal,
      });
    } catch (cause) {
      cancelledCheck(context.signal);
      throw new InfrastructureError(
        'BROWSER_INSTALL_FAILED',
        `could not install ffmpeg: ${cause instanceof Error ? cause.message : String(cause)}; run "npx @e2e-dev/web install ffmpeg", or set E2E_FFMPEG_PATH to an ffmpeg with libvpx-vp9`,
        { cause },
      );
    }
  });
  return executable;
}
