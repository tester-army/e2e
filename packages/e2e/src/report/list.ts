/** Human-readable list reporter (spec 06-cli.md). */

import pc from 'picocolors';
import { sanitizeText, truncateUtf8 } from '../internal/errors.js';
import type { ResultRecord } from '../run/records.js';

const MAX_FIELD_BYTES = 8192;

export interface ListReporterOutput {
  write(line: string): void;
}

function bounded(text: string): string {
  return truncateUtf8(sanitizeText(text), MAX_FIELD_BYTES);
}

export class ListReporter {
  private passed = 0;
  private failed = 0;
  private flaky = 0;
  private skipped = 0;

  constructor(private readonly output: ListReporterOutput = { write: (line) => process.stdout.write(`${line}\n`) }) {}

  onRunStart(info: { runId: string; targets: readonly string[]; ci: boolean }): void {
    this.output.write(
      pc.dim(
        `e2e run ${info.runId} (targets: ${info.targets.join(', ')})${info.ci ? ' [CI]' : ''}`,
      ),
    );
    this.output.write(
      pc.dim(
        'Config, tests, model adapters, and in-process drivers run as trusted code with this runner\u2019s OS authority.',
      ),
    );
  }

  onResult(result: ResultRecord): void {
    if (!result.selected && result.status === 'skipped') return;
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
        }
      }
    }
  }

  onRunEnd(info: { status: string; exitCode: number; reportPath: string }): void {
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
