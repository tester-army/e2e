/** e2e CLI (spec 06-cli.md). */

import { Command, InvalidArgumentError } from 'commander';
import { run } from '../run/runner.js';
import { init } from './init.js';

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
    .option('--reporter <ids>', 'comma-separated reporters: list, json, html', parseList)
    .option('--artifacts <dir>', 'artifact root, default .e2e/artifacts')
    .option('--no-agent-cache', 'force agent cache mode off')
    .option('--pass-with-no-tests', 'allow zero runnable ordinary test-target pairs')
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
          passWithNoTests?: boolean;
        },
      ) => {
        if (options.tagMode !== 'any' && options.tagMode !== 'all') {
          process.stderr.write(`invalid --tag-mode "${options.tagMode}"; expected any or all\n`);
          process.exitCode = 2;
          return;
        }
        for (const reporter of options.reporter ?? []) {
          if (!['list', 'json', 'html'].includes(reporter)) {
            process.stderr.write(`unknown reporter "${reporter}"\n`);
            process.exitCode = 2;
            return;
          }
        }
        const outcome = await run({
          files,
          ...(options.config !== undefined ? { configPath: options.config } : {}),
          ...(options.target !== undefined ? { targetIds: options.target } : {}),
          ...(options.tag !== undefined ? { tags: options.tag } : {}),
          tagMode: options.tagMode as 'any' | 'all',
          ...(options.headed !== undefined ? { headed: options.headed } : {}),
          ...(options.retries !== undefined ? { retries: options.retries } : {}),
          ...(options.workers !== undefined ? { workers: options.workers } : {}),
          ...(options.reporter !== undefined
            ? { reporters: options.reporter as ('list' | 'json' | 'html')[] }
            : {}),
          ...(options.artifacts !== undefined ? { artifactsDir: options.artifacts } : {}),
          ...(options.passWithNoTests !== undefined
            ? { passWithNoTests: options.passWithNoTests }
            : {}),
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
