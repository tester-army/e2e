/**
 * Builds the Swift engine server, a UI test bundle and its host app, for the
 * iOS simulator with `xcodebuild build-for-testing`, once per version of its
 * sources and of Xcode. The package ships the sources: the build lands in
 * the user's cache, so a read-only `node_modules` and several projects
 * share one.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { InfrastructureError } from 'e2e/engine';
import { run } from './run.ts';

const SOURCES = path.join(import.meta.dirname, '..', 'server');

/** Every file under `dir`, sorted, as paths relative to it. */
async function files(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'xcuserdata' || entry.name.startsWith('.')) continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(dir, relative)));
    else out.push(relative);
  }
  return out.toSorted();
}

/** The simulator architecture: the Mac's own, which the simulator runs. */
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x86_64';

/** A digest of the server sources, the selected Xcode, and the architecture: a change to any builds again. */
async function buildKey(signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  hash.update(ARCH);
  hash.update(await run('xcodebuild', ['-version'], signal));
  for (const file of await files(SOURCES)) {
    hash.update(file);
    hash.update(await readFile(path.join(SOURCES, file)));
  }
  return hash.digest('hex').slice(0, 16);
}

/** The directory builds are kept in: `E2E_IOS_BUILD_DIR`, else the user's cache. */
function buildRoot(env: Readonly<Record<string, string | undefined>>): string {
  return env['E2E_IOS_BUILD_DIR'] ?? path.join(homedir(), 'Library', 'Caches', 'e2e', 'ios-server');
}

/** The `.xctestrun` of a finished build in `dir`, or undefined. */
async function xctestrunIn(dir: string): Promise<string | undefined> {
  const products = path.join(dir, 'Build', 'Products');
  try {
    const file = (await readdir(products)).find((entry) => entry.endsWith('.xctestrun'));
    return file === undefined ? undefined : path.join(products, file);
  } catch {
    return undefined;
  }
}

/**
 * The `.xctestrun` of the server built from the shipped sources, built
 * first when this version has no build yet. Builds into a scratch directory
 * renamed into place, so a run that stops mid-build or races another leaves
 * no half build behind.
 */
export async function buildServer(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
}): Promise<string> {
  const root = buildRoot(options.env ?? process.env);
  const dir = path.join(root, await buildKey(options.signal));
  const built = await xctestrunIn(dir);
  if (built !== undefined) return built;
  options.log?.(`building the ios engine server with xcodebuild into ${dir}`);
  const scratch = `${dir}.${String(process.pid)}.${String(Date.now())}`;
  try {
    await run(
      'xcodebuild',
      [
        'build-for-testing',
        '-project', path.join(SOURCES, 'E2EServer.xcodeproj'),
        '-scheme', 'E2EServer',
        '-configuration', 'Release',
        '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', scratch,
        `ARCHS=${ARCH}`,
      ],
      options.signal,
    );
    await rename(scratch, dir).catch(async (cause: unknown) => {
      if (!(await stat(dir).then(() => true, () => false))) throw cause;
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  const xctestrun = await xctestrunIn(dir);
  if (xctestrun === undefined) throw new InfrastructureError('ENGINE_FAILURE', `xcodebuild built no .xctestrun into ${dir}`);
  return xctestrun;
}
