import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedConfig } from '../config/resolve.ts';
import type { Report1Document } from '../report/build.ts';
import { writeTracePages, type TracePages } from '../report/traces.ts';
import { outputLayout } from './output.ts';

const HISTORY_MARKER = '.e2e-history';
const HISTORY_VERSION = 'e2e-history-1\n';
const RUN_MARKER = '.e2e-run';
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PENDING = /^\.pending-([1-9][0-9]*)-[A-Za-z0-9]{6}$/;

/** Saves one finished run atomically before pruning only snapshots the runner owns. */
export async function saveRunHistory(options: {
  readonly config: ResolvedConfig;
  readonly report: Report1Document;
  readonly reportPath: string;
  readonly aiTracePath: string | undefined;
  readonly traces: TracePages;
}): Promise<string> {
  const { config, report, reportPath, aiTracePath, traces } = options;
  const layout = outputLayout(config.output);
  const id = report.run.id;
  if (!RUN_ID.test(id)) throw new Error('run history requires a valid run id');
  await claimHistory(layout.history);
  await recoverPending(layout.history);
  const destination = path.join(layout.history, id);
  if (await present(destination)) throw new Error(`run history already exists at ${destination}`);
  const staging = await mkdtemp(path.join(layout.history, `.pending-${process.pid}-`));
  try {
    await writeFile(path.join(staging, RUN_MARKER), id, { flag: 'wx' });
    await copyRegular(reportPath, path.join(staging, 'report.json'));
    if (aiTracePath !== undefined) await copyRegular(aiTracePath, path.join(staging, 'ai-trace.json'));
    if (await present(layout.results)) {
      await cp(layout.results, path.join(staging, 'results'), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (source) => {
          if (source === path.join(layout.results, 'mcp')) return false;
          const info = await lstat(source);
          if (!info.isDirectory() && !info.isFile()) throw new Error(`run history cannot copy a link or special file: ${source}`);
          return true;
        },
      });
    }
    // Render displayed paths against the published snapshot location.
    await writeTracePages(report, new Set(traces.keys()), {
      projectRoot: config.projectRoot,
      resultsRoot: path.join(staging, 'results'),
      displayResultsRoot: path.join(destination, 'results'),
      cacheDir: config.cache.store === undefined ? config.cache.dir : undefined,
    });
    await rename(staging, destination);
    await pruneHistory(layout.history, id, config.keepResults);
    return path.join(destination, 'report.json');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Claims an empty history directory, or verifies the marker of one already managed by e2e. */
async function claimHistory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error(`run history must be a directory, not a symlink: ${directory}`);
  const marker = path.join(directory, HISTORY_MARKER);
  if (!(await present(marker))) {
    if ((await readdir(directory)).length !== 0) throw new Error(`run history holds files e2e does not own: ${directory}`);
    await writeFile(marker, HISTORY_VERSION, { flag: 'wx' });
  } else if (!(await lstat(marker)).isFile() || (await readFile(marker, 'utf8')) !== HISTORY_VERSION) {
    throw new Error(`run history has an invalid ownership marker: ${directory}`);
  }
}

/** Removes owned partial snapshots only after their writing process has exited. */
async function recoverPending(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const match = PENDING.exec(entry.name);
    if (!entry.isDirectory() || match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) continue;
    const marker = path.join(directory, entry.name, RUN_MARKER);
    if (!(await present(marker)) || !(await lstat(marker)).isFile() || !RUN_ID.test(await readFile(marker, 'utf8'))) continue;
    try {
      process.kill(pid, 0);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') await rm(path.join(directory, entry.name), { recursive: true });
      else if (code !== 'EPERM') throw cause;
    }
  }
}

/** Prunes the oldest owned run ids, always keeping the snapshot just published. */
async function pruneHistory(directory: string, current: string, keep: number): Promise<void> {
  const owned: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name) || entry.name === current) continue;
    const marker = path.join(directory, entry.name, RUN_MARKER);
    if (await present(marker) && (await lstat(marker)).isFile() && (await readFile(marker, 'utf8')) === entry.name) owned.push(entry.name);
  }
  for (const id of owned.toSorted((left, right) => right.localeCompare(left)).slice(keep - 1)) {
    await rm(path.join(directory, id), { recursive: true });
  }
}

/** Copies only a regular file, never following a source symlink. */
async function copyRegular(source: string, destination: string): Promise<void> {
  if (!(await lstat(source)).isFile()) throw new Error(`run history requires a regular file: ${source}`);
  await cp(source, destination, { force: false, errorOnExist: true });
}

/** Distinguishes an absent entry from permission and other filesystem errors. */
async function present(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}
