/** e2e CLI (spec 06-cli.md). */

import { Command, InvalidArgumentError } from 'commander';
import { run } from '../run/runner.ts';
import { init } from './init.ts';

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('must be a nonnegative integer');
  }
  return parsed;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const REPORTERS = ['list', 'json'] as const;
type Reporter = (typeof REPORTERS)[number];

function isReporter(value: string): value is Reporter {
  return (REPORTERS as readonly string[]).includes(value);
}

function isTagMode(value: string): value is 'any' | 'all' {
  return value === 'any' || value === 'all';
}

/** Builds the commander program. */
export function createProgram(): Command {
  const program = new Command('e2e');
  program.description('open, local-first standard for agentic end-to-end testing');

  program
    .command('init')
    .description('scaffold e2e.config.ts, an example test, and .gitignore entries')
    .option('-y, --yes', 'skip confirmation prompts')
    .action(async (options: { yes?: boolean }) => {
      process.exitCode = await init(process.cwd(), options);
    });

  program
    .command('run')
    .description('run e2e tests')
    .argument('[files...]', 'test files relative to the project root')
    .option('--config <path>', 'explicit config path')
    .option('--target <ids>', 'comma-separated target IDs', parseList)
    .option('--tag <tag>', 'repeatable tag filter', (value: string, previous: string[] = []) => [...previous, value])
    .option('--tag-mode <mode>', 'tag composition: any or all', 'any')
    .option('--headed', 'request visible UI when the driver supports it')
    .option('--retries <n>', 'replace resolved retry count', parsePositiveInt)
    .option('--workers <n>', 'replace worker count', parsePositiveInt)
    .option('--reporter <ids>', 'comma-separated reporters: list, json', parseList)
    .option('--artifacts <dir>', 'artifact root, default .e2e/artifacts')
    .option('--no-cache', 'run without the trace cache, overriding the config')
    .option('--pass-with-no-tests', 'allow zero runnable ordinary test-target pairs')
    .option('--debug', 'print aggregated phase timings to stderr after the run')
    .action(
      async (
        files: string[],
        options: {
          config?: string;
          target?: string[];
          tag?: string[];
          tagMode: string;
          headed?: boolean;
          retries?: number;
          workers?: number;
          reporter?: string[];
          artifacts?: string;
          /** Commander negation: `--no-cache` parses as `cache: false`. */
          cache?: boolean;
          passWithNoTests?: boolean;
          debug?: boolean;
        },
      ) => {
        const { tagMode, reporter } = options;
        if (!isTagMode(tagMode)) {
          process.stderr.write(`invalid --tag-mode "${tagMode}"; expected any or all\n`);
          process.exitCode = 2;
          return;
        }
        const invalidReporter = reporter?.find((value) => !isReporter(value));
        if (invalidReporter !== undefined) {
          process.stderr.write(`unknown reporter "${invalidReporter}"\n`);
          process.exitCode = 2;
          return;
        }
        const outcome = await run({
          files,
          configPath: options.config,
          targetIds: options.target,
          tags: options.tag,
          tagMode,
          headed: options.headed,
          retries: options.retries,
          workers: options.workers,
          reporters: reporter?.filter(isReporter),
          artifactsDir: options.artifacts,
          noCache: options.cache === false,
          passWithNoTests: options.passWithNoTests,
          debug: options.debug,
        });
        process.exitCode = outcome.exitCode;
      },
    );

  return program;
}

/** CLI entry invoked by the bin wrapper. */
export async function main(argv: readonly string[]): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync([...argv]);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  }
}
