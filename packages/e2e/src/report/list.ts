/** Human-readable list reporter (spec 06-cli.md). */

import path from 'node:path';
import picocolors from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.ts';
import type { ResultRecord, RunError } from '../run/records.ts';
import { codeFrame, userFrame } from './code-frame.ts';
import { LiveStatus } from './live-status.ts';

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
  private readonly status: LiveStatus;
  /** Colors follow live rendering: non-interactive sinks get plain text. */
  private readonly pc: ReturnType<typeof picocolors.createColors>;

  constructor(
    private readonly output: ListReporterOutput = DEFAULT_OUTPUT,
    options: { live?: boolean } = {},
  ) {
    const live = (options.live ?? process.stdout.isTTY === true) && output.raw !== undefined;
    this.status = new LiveStatus(live ? output.raw?.bind(output) : undefined);
    this.pc = picocolors.createColors(live);
  }

  onRunStart(info: {
    runId: string;
    targets: readonly string[];
    ci: boolean;
    projectRoot?: string;
  }): void {
    this.projectRoot = info.projectRoot;
    this.output.write(
      this.pc.dim(
        `e2e run ${info.runId} (targets: ${info.targets.join(', ')})${info.ci ? ' [CI]' : ''}`,
      ),
    );
  }

  /** Announces how many test-target pairs the run will execute. */
  onPlan(info: { total: number }): void {
    this.status.plan(info.total);
  }

  /** A worker began one test-target pair: show it in the live status block. */
  onTestStart(info: { id: string; title: string; target: string }): void {
    this.status.start(
      `${info.id}@${info.target}`,
      `${bounded(info.title)} ${this.pc.dim(`[${info.target}]`)}`,
    );
  }

  onResult(result: ResultRecord): void {
    if (!result.selected && result.status === 'skipped') {
      this.status.skip();
      return;
    }
    this.status.erase();
    this.status.finish(`${result.test.id}@${result.target.name}`);
    const title = bounded(result.test.titlePath.join(' \u203a '));
    const target = result.target.name;
    const duration = result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    switch (result.status) {
      case 'passed':
        this.passed += 1;
        this.output.write(`${this.pc.green('\u2713')} ${title} ${this.pc.dim(`[${target}] ${duration}ms`)}`);
        break;
      case 'flaky':
        this.flaky += 1;
        this.output.write(
          `${this.pc.yellow('\u2713')} ${title} ${this.pc.yellow('(flaky)')} ${this.pc.dim(`[${target}] ${duration}ms`)}`,
        );
        break;
      case 'skipped':
        this.skipped += 1;
        this.output.write(
          `${this.pc.cyan('-')} ${title} ${this.pc.dim(`[${target}] skipped: ${bounded(result.skip?.reason ?? '')}`)}`,
        );
        break;
      default: {
        this.failed += 1;
        this.output.write(
          `${this.pc.red('\u2717')} ${title} ${this.pc.dim(`[${target}] ${result.status} ${duration}ms`)}`,
        );
        const error = result.attempts[result.attempts.length - 1]?.error;
        if (error !== undefined) {
          for (const line of bounded(error.message).split('\n')) {
            this.output.write(`    ${this.pc.red(line)}`);
          }
          this.writeFailureLocation(error.stack);
        }
      }
    }
    this.status.redraw();
  }

  /** Names the user's failing line and renders a small code frame around it. */
  private writeFailureLocation(stack: string | undefined): void {
    if (this.projectRoot === undefined) return;
    const frame = userFrame(stack, this.projectRoot);
    if (frame === undefined) return;
    const relative = path.relative(this.projectRoot, frame.file);
    this.output.write('');
    this.output.write(
      `    ${this.pc.dim('at')} ${this.pc.cyan(`${bounded(relative)}:${frame.line}:${frame.column}`)}`,
    );
    for (const line of codeFrame(frame)) this.output.write(`    ${line}`);
  }

  onRunEnd(info: {
    status: string;
    exitCode: number;
    reportPath: string;
    errors?: readonly RunError[];
  }): void {
    this.status.erase();
    // Run-level errors never reach onResult: they abort before, between, or
    // after test execution. Without this the console shows only a bare exit
    // code and the reason lives solely in report.json.
    for (const { error } of info.errors ?? []) {
      this.output.write('');
      const phase = error.phase === undefined ? '' : ` ${this.pc.dim(`(${error.phase})`)}`;
      this.output.write(`${this.pc.red(`\u2717 ${error.category} error`)} ${this.pc.dim(error.code)}${phase}`);
      for (const line of bounded(error.message).split('\n')) {
        this.output.write(`    ${this.pc.red(line)}`);
      }
    }
    const parts = [
      this.passed > 0 ? this.pc.green(`${this.passed} passed`) : undefined,
      this.failed > 0 ? this.pc.red(`${this.failed} failed`) : undefined,
      this.flaky > 0 ? this.pc.yellow(`${this.flaky} flaky`) : undefined,
      this.skipped > 0 ? this.pc.cyan(`${this.skipped} skipped`) : undefined,
    ].filter((part) => part !== undefined);
    this.output.write('');
    this.output.write(parts.length > 0 ? parts.join(this.pc.dim(' \u00b7 ')) : this.pc.dim('no tests executed'));
    this.output.write(this.pc.dim(`report: ${info.reportPath}`));
  }
}
