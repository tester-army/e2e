import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, type Insights } from './analyze.ts';
import { renderHtml } from './render/html.ts';
import { renderMarkdown } from './render/markdown.ts';
import { renderText } from './render/text.ts';
import { DEFAULT_HISTORY_DIR } from './reporter.ts';
import { HISTORY_FILE, loadHistory } from './store.ts';

const HELP = `Usage: e2e-insights [history.jsonl ...] [options]

Reads the run history the insights() reporter writes and reports flaky and
broken tests, replay cache misses, model cost, and the slowest tests.
Several files are merged by run id, so histories from CI jobs combine.

Arguments:
  history.jsonl         History files; default ${DEFAULT_HISTORY_DIR}/${HISTORY_FILE}

Options:
  --format <format>     text (default), markdown, html, or json
  --out <file>          Write to a file instead of stdout
  --window <n>          Newest runs to analyze; default 30
  --min-runs <n>        Results a test needs for a verdict; default 5
  --broken-after <n>    Failures in a row that make a test broken; default 3
  --fail-on <verdict>   Exit 1 on a broken test (broken), or on any broken, failing, or flaky one (flaky)
  -h, --help            Show this help
`;

type Format = 'text' | 'markdown' | 'html' | 'json';
const FORMATS: readonly Format[] = ['text', 'markdown', 'html', 'json'];

/** What the CLI reads and writes, so tests run it without a process. */
export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Runs the CLI and resolves with its exit code: 0, 1 for `--fail-on`, 2 for a usage error. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        format: { type: 'string', default: 'text' },
        out: { type: 'string' },
        window: { type: 'string' },
        'min-runs': { type: 'string' },
        'broken-after': { type: 'string' },
        'fail-on': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }

  const format = values.format as Format;
  if (!FORMATS.includes(format)) return usage(io, `--format must be one of ${FORMATS.join(', ')}`);
  const failOn = values['fail-on'];
  if (failOn !== undefined && failOn !== 'flaky' && failOn !== 'broken') return usage(io, '--fail-on must be flaky or broken');

  let insights: Insights;
  try {
    const files = (positionals.length > 0 ? positionals : [path.join(DEFAULT_HISTORY_DIR, HISTORY_FILE)]).map((file) =>
      path.resolve(io.cwd, file),
    );
    const { runs, skippedLines } = await loadHistory(files);
    if (skippedLines > 0) io.stderr(`e2e-insights: skipped ${skippedLines} unreadable history ${skippedLines === 1 ? 'line' : 'lines'}\n`);
    insights = analyze(runs, {
      ...integer(values.window, 'window'),
      ...integer(values['min-runs'], 'minRuns'),
      ...integer(values['broken-after'], 'brokenAfter'),
    });
  } catch (error) {
    return usage(io, (error as Error).message);
  }

  const output =
    format === 'json'
      ? JSON.stringify(insights, null, 2) + '\n'
      : format === 'html'
        ? renderHtml(insights)
        : format === 'markdown'
          ? renderMarkdown(insights)
          : renderText(insights);

  if (values.out === undefined) {
    io.stdout(output);
  } else {
    const out = path.resolve(io.cwd, values.out);
    try {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, output, 'utf8');
    } catch (error) {
      // Exit 2, not 1: 1 is what --fail-on returns for unhealthy tests.
      return usage(io, `cannot write ${values.out}: ${(error as Error).message}`);
    }
    const relative = path.relative(io.cwd, out);
    io.stdout(`Wrote ${relative.startsWith('..') || path.isAbsolute(relative) ? out : relative}\n`);
  }

  const failing =
    failOn === 'flaky'
      ? insights.counts.flaky + insights.counts.failing + insights.counts.broken
      : failOn === 'broken'
        ? insights.counts.broken
        : 0;
  return failing > 0 ? 1 : 0;
}

function usage(io: CliIo, message: string): number {
  io.stderr(`e2e-insights: ${message}\n`);
  return 2;
}

/** A positive integer flag as an option entry; throws with the flag's name on anything else. */
function integer<K extends string>(value: string | undefined, key: K): Partial<Record<K, number>> {
  if (value === undefined) return {};
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a positive integer, got ${value}`);
  return { [key]: number } as Partial<Record<K, number>>;
}
