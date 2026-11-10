import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FinishedRun, Report, Reporter, ReporterSummary } from 'e2e';
import { embedPayload, type ReportMedia } from './payload.ts';

export interface HtmlReporterOptions {
  /**
   * Where the page goes, from the project root. Defaults to `report.html` in
   * the run's output directory (`.e2e/report.html`), beside the `results/`
   * directory its screenshots and videos link into.
   */
  outputFile?: string;
  /**
   * What the page does with screenshots, videos, and other files:
   * - `'link'` (default): links them from the results directory, so keep the
   *   output directory together when you move or upload it.
   * - `'embed'`: copies them into the page, so the one file is the whole
   *   report. Device videos make it large: tens of megabytes per minute.
   * - `'none'`: leaves them out; the page shows text only.
   */
  media?: 'link' | 'embed' | 'none';
}

/** The built page, filled per run; `vite build` writes it beside this module. */
const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app', 'index.html');

/**
 * The HTML reporter. Add it to `reporters` beside the built-in ids:
 *
 * ```ts
 * import { htmlReporter } from '@e2e-dev/html-reporter';
 * export default { targets, reporters: ['list', htmlReporter()] } satisfies E2EConfig;
 * ```
 *
 * Once the run is over it writes one page with the run's report-1 document
 * in it, which opens straight from disk. `media` decides whether
 * screenshots and videos are linked from the results directory (the
 * default), embedded in the page, or left out.
 */
export function htmlReporter(options: HtmlReporterOptions = {}): Reporter {
  return {
    name: 'html',
    onRunFinished: async (run, signal) => writeReport(run, options, await readFile(TEMPLATE_PATH, 'utf8'), signal),
  };
}

/**
 * Fills the page template with one finished run, writes it, and resolves with
 * the row naming where it went. Once `signal` aborts (the runner gave up on
 * its reporters), it stops reading files and writes nothing.
 */
export async function writeReport(run: FinishedRun, options: HtmlReporterOptions, template: string, signal?: AbortSignal): Promise<ReporterSummary> {
  const outputFile =
    options.outputFile === undefined
      ? path.join(path.dirname(run.artifactsRoot), 'report.html')
      : path.resolve(run.projectRoot, options.outputFile);
  const mode = options.media ?? 'link';
  const media = await pageMedia(mode, run, outputFile, signal);
  const resultsDir = toPosix(path.relative(run.projectRoot, run.artifactsRoot)) || '.';
  const traces = Object.fromEntries([...run.traces].map(([id, trace]) => [id, toPosix(trace)]));
  const sources = await sourceFrames(run.report, run.projectRoot, run.redact);
  const page = embedPayload(template, { report: run.report, media, resultsDir, traces, sources });
  signal?.throwIfAborted();
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, page, 'utf8');
  const shown = path.relative(process.cwd(), outputFile) || outputFile;
  let note = '';
  if (mode === 'embed') note = ` (one file, ${formatSize(Buffer.byteLength(page))})`;
  if (mode === 'none') note = ' (text only)';
  return [{ label: 'HTML report', text: `${shown}${note}` }];
}

/** What the page holds for screenshots and videos in each `media` mode. */
async function pageMedia(mode: NonNullable<HtmlReporterOptions['media']>, run: FinishedRun, outputFile: string, signal: AbortSignal | undefined): Promise<ReportMedia> {
  switch (mode) {
    case 'link':
      return { mode, base: toPosix(path.relative(path.dirname(outputFile), run.artifactsRoot)) };
    case 'embed':
      return { mode, files: await embedArtifacts(run.report, run.artifactsRoot, signal) };
    case 'none':
      return { mode };
  }
}

/**
 * Media types an embedded file keeps. An embedded file opens as a blob URL
 * in the page's own origin, so a type a browser would run (HTML, SVG, a
 * download from the app under test) is stored as `application/octet-stream`,
 * which the browser saves instead of rendering.
 */
const INERT_TYPE = /^(?:image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm|quicktime)|text\/plain|application\/json)$/u;

/**
 * Every artifact file the report names, read into a `data:` URL keyed by its
 * report path. A path that leaves the results directory is never read, and
 * a file that is gone (deleted by `video: 'retain-on-failure'`, say) is left
 * out, so the page shows it as missing. So is a download the runner could not
 * scan for secrets (`redaction: 'incomplete'`): the page is a file to send.
 */
async function embedArtifacts(report: Report, artifactsRoot: string, signal: AbortSignal | undefined): Promise<Record<string, string>> {
  const { run } = report;
  const attempts = [...run.results.flatMap((result) => result.attempts), ...run.serialGroups.flatMap((group) => group.attempts)];
  // One entry per file: a serial group's attempt and its members name the same artifacts.
  const types = new Map(
    attempts.flatMap((attempt) =>
      attempt.artifacts.flatMap((artifact) =>
        artifact.path === undefined || (artifact.kind === 'download' && artifact.redaction === 'incomplete') ? [] : [[artifact.path, artifact.mediaType] as const],
      ),
    ),
  );
  const files: Record<string, string> = {};
  for (const [artifactPath, mediaType] of types) {
    const file = path.resolve(artifactsRoot, artifactPath);
    const inside = path.relative(artifactsRoot, file);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) continue;
    signal?.throwIfAborted();
    const bytes = await readFile(file).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (bytes === undefined) continue;
    const type = INERT_TYPE.test(mediaType) ? mediaType : 'application/octet-stream';
    files[artifactPath] = `data:${type};base64,${bytes.toString('base64')}`;
  }
  return files;
}

/** Lines a code frame shows before and after the line it points at. */
const FRAME_BEFORE = 2;
const FRAME_AFTER = 2;
/** A longer line is cut: a frame shows code, not a minified bundle. */
const MAX_LINE_CHARS = 400;

/**
 * The lines around every source location in the report (each step's, each
 * error's, each test's), read from the project's files and redacted, since
 * a test file can hold a secret's value. A file outside the project root, or
 * one that is gone, is left out, and so is its frame.
 */
async function sourceFrames(report: Report, projectRoot: string, redact: (text: string) => string): Promise<Record<string, Record<string, string>>> {
  const wanted = new Map<string, Set<number>>();
  collectSources(report.run, (file, line) => {
    const lines = wanted.get(file) ?? new Set<number>();
    for (let at = Math.max(1, line - FRAME_BEFORE); at <= line + FRAME_AFTER; at++) lines.add(at);
    wanted.set(file, lines);
  });
  const frames: Record<string, Record<string, string>> = {};
  for (const [file, lines] of wanted) {
    const absolute = path.resolve(projectRoot, file);
    const inside = path.relative(projectRoot, absolute);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) continue;
    const text = await readFile(absolute, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const all = text.split(/\r?\n/u);
    frames[file] = Object.fromEntries(
      [...lines].flatMap((line) => {
        const content = all[line - 1];
        return content === undefined ? [] : [[String(line), redact(content).slice(0, MAX_LINE_CHARS)]];
      }),
    );
  }
  return frames;
}

/** Calls `found` for every `{ file, line, column }` source object anywhere under `value`. */
function collectSources(value: unknown, found: (file: string, line: number) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSources(item, found);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'source' && typeof child === 'object' && child !== null && 'file' in child && 'line' in child && typeof child.file === 'string' && typeof child.line === 'number') {
      found(child.file, child.line);
    } else {
      collectSources(child, found);
    }
  }
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
