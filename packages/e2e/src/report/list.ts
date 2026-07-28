/** Human-readable list reporter (spec 06-cli.md). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { ResultRecord } from '../run/records.ts';

const MAX_FIELD_BYTES = 8192;

export interface ListReporterOutput {
  write(line: string): void;
  /** Raw control write for live status rendering; omit to disable it. */
  raw?(text: string): void;
}

function bounded(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_FIELD_BYTES);
}

const DEFAULT_OUTPUT: ListReporterOutput = {
  write: (line) => process.stdout.write(`${line}\n`),
  raw: (text) => process.stdout.write(text),
};

export class ListReporter {
  private passed = 0;
  private failed = 0;
  private flaky = 0;
  private skipped = 0;
  private projectRoot: string | undefined;
  /** Tests currently executing, keyed by test-target pair, in start order. */
  private readonly running = new Map<string, string>();
  /** Lines the live status block currently occupies below the log. */
  private statusLines = 0;
  private readonly live: boolean;
  /** Planned test-target pairs; 0 until the runner announces the plan. */
  private total = 0;
  /** Pairs with a reported result, including skipped and deselected ones. */
  private done = 0;

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: { live?: boolean } = {},
  ) {
    this.live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
  }

  onRunStart(info: {
    runId: string;
    targets: readonly string[];
    ci: boolean;
    projectRoot?: string;
  }): void {
    this.projectRoot = info.projectRoot;
    this.output.write(
      pc.dim(
        `e2e run ${info.runId} (targets: ${info.targets.join(', ')})${info.ci ? ' [CI]' : ''}`,
      ),
    );
  }

  /** Announces how many test-target pairs the run will execute. */
  onPlan(info: { total: number }): void {
    this.total = info.total;
    this.redraw();
  }

  /** A worker began one test-target pair: show it in the live status block. */
  onTestStart(info: { id: string; title: string; target: string }): void {
    this.running.set(`${info.id}@${info.target}`, `${bounded(info.title)} ${pc.dim(`[${info.target}]`)}`);
    this.redraw();
  }

  onResult(result: ResultRecord): void {
    this.done += 1;
    if (!result.selected && result.status === 'skipped') {
      this.redraw();
      return;
    }
    this.erase();
    this.running.delete(`${result.test.id}@${result.target.name}`);
    const title = bounded(result.test.titlePath.join(' \u203a '));
    const target = result.target.name;
    const duration = result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    switch (result.status) {
      case 'passed':
        this.passed += 1;
        this.output.write(`${pc.green('\u2713')} ${title} ${pc.dim(`[${target}] ${duration}ms`)}`);
        break;
      case 'flaky':
        this.flaky += 1;
        this.output.write(
          `${pc.yellow('\u2713')} ${title} ${pc.yellow('(flaky)')} ${pc.dim(`[${target}] ${duration}ms`)}`,
        );
        break;
      case 'skipped':
        this.skipped += 1;
        this.output.write(
          `${pc.cyan('-')} ${title} ${pc.dim(`[${target}] skipped: ${bounded(result.skip?.reason ?? '')}`)}`,
        );
        break;
      default: {
        this.failed += 1;
        this.output.write(
          `${pc.red('\u2717')} ${title} ${pc.dim(`[${target}] ${result.status} ${duration}ms`)}`,
        );
        const error = result.attempts[result.attempts.length - 1]?.error;
        if (error !== undefined) {
          for (const line of bounded(error.message).split('\n')) {
            this.output.write(`    ${pc.red(line)}`);
          }
          this.writeFailureLocation(error.stack);
        }
      }
    }
    this.redraw();
  }

  /** Clears the live status block so permanent log lines can be appended. */
  private erase(): void {
    if (!this.live || this.statusLines === 0) return;
    this.output.raw!(`\u001b[${this.statusLines}A\u001b[0J`);
    this.statusLines = 0;
  }

  /** Repaints the live status block below the permanent log. */
  private redraw(): void {
    if (!this.live) return;
    let payload = this.statusLines > 0 ? `\u001b[${this.statusLines}A\u001b[0J` : '';
    for (const text of this.running.values()) {
      payload += `${pc.dim('\u25B8')} ${text}\n`;
    }
    const progress = this.progressLine();
    if (progress !== undefined) payload += `${progress}\n`;
    this.statusLines = this.running.size + (progress === undefined ? 0 : 1);
    if (payload !== '') this.output.raw!(payload);
  }

  /** One bounded counter line: completed, executing, and waiting pairs. */
  private progressLine(): string | undefined {
    if (this.total === 0) return undefined;
    const waiting = Math.max(0, this.total - this.done - this.running.size);
    const parts = [
      `${this.done}/${this.total} done`,
      `${this.running.size} running`,
      `${waiting} waiting`,
    ];
    return pc.dim(`  ${parts.join(' \u00b7 ')}`);
  }

  /** Names the user's failing line and renders a small code frame around it. */
  private writeFailureLocation(stack: string | undefined): void {
    const frame = userFrame(stack, this.projectRoot);
    if (frame === undefined) return;
    const relative = path.relative(this.projectRoot!, frame.file);
    this.output.write('');
    this.output.write(
      `    ${pc.dim('at')} ${pc.cyan(`${bounded(relative)}:${frame.line}:${frame.column}`)}`,
    );
    for (const line of codeFrame(frame)) this.output.write(`    ${line}`);
  }

  onRunEnd(info: { status: string; exitCode: number; reportPath: string }): void {
    this.erase();
    const parts = [
      this.passed > 0 ? pc.green(`${this.passed} passed`) : undefined,
      this.failed > 0 ? pc.red(`${this.failed} failed`) : undefined,
      this.flaky > 0 ? pc.yellow(`${this.flaky} flaky`) : undefined,
      this.skipped > 0 ? pc.cyan(`${this.skipped} skipped`) : undefined,
    ].filter((part) => part !== undefined);
    this.output.write('');
    this.output.write(parts.length > 0 ? parts.join(pc.dim(' \u00b7 ')) : pc.dim('no tests executed'));
    this.output.write(pc.dim(`report: ${info.reportPath}`));
  }
}

interface StackFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

const FRAME_PATTERN = /((?:file:\/\/)?\/[^):]+):(\d+):(\d+)\)?\s*$/;

/**
 * First stack frame inside the project and outside node_modules: the line in
 * the user's test file that the failure unwound through. Runner frames never
 * match because the runner lives in node_modules (or outside the project root
 * in a workspace).
 */
export function userFrame(
  stack: string | undefined,
  projectRoot: string | undefined,
): StackFrame | undefined {
  if (stack === undefined || projectRoot === undefined) return undefined;
  for (const raw of stack.split('\n')) {
    const match = FRAME_PATTERN.exec(raw);
    if (match === null) continue;
    const [, location, line, column] = match as unknown as [string, string, string, string];
    const withoutQuery = location.split('?')[0]!;
    let file: string;
    try {
      file = withoutQuery.startsWith('file://') ? fileURLToPath(withoutQuery) : withoutQuery;
    } catch {
      continue;
    }
    if (!file.startsWith(`${projectRoot}${path.sep}`)) continue;
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    return { file, line: Number(line), column: Number(column) };
  }
  return undefined;
}

/** Renders the failing line with one line of context and a column caret. */
function codeFrame(frame: StackFrame): string[] {
  let source: string;
  try {
    source = readFileSync(frame.file, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split('\n');
  const index = frame.line - 1;
  if (index < 0 || index >= lines.length) return [];
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length - 1, index + 1);
  const width = String(end + 1).length;
  const rows: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const text = bounded(lines[i] ?? '');
    const number = String(i + 1).padStart(width);
    if (i === index) {
      rows.push(`${pc.red('>')} ${number} | ${text}`);
      rows.push(`  ${' '.repeat(width)} | ${' '.repeat(Math.max(0, frame.column - 1))}${pc.red('^')}`);
    } else {
      rows.push(pc.dim(`  ${number} | ${text}`));
    }
  }
  return rows;
}
