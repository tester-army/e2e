/** e2e CLI. */

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import picocolors from 'picocolors';
import { packageVersion } from '../internal/package-version.ts';
import { run } from '../run/runner.ts';
import { init, type InitOptions } from './init.ts';
import { SignalLadder } from './signals.ts';

const DOCS_URL = 'https://e2e.docs.buildwithfern.com';

/**
 * Help text always carries color; commander strips it when the stream it
 * writes to has none (not a TTY, `NO_COLOR`), so the decision is made once,
 * per stream, by the writer.
 */
const pc = picocolors.createColors(true);

/** Shape check only; the config resolver applies each flag's bounds. */
function parseNonNegativeInt(value: string): number {
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

const REPORTERS = ['list', 'json', 'junit'] as const;
type Reporter = (typeof REPORTERS)[number];

function isReporter(value: string): value is Reporter {
  return (REPORTERS as readonly string[]).includes(value);
}

/** Reporter ids, comma-separated; the CLI only rejects ids it does not know. */
function parseReporters(value: string): Reporter[] {
  return parseList(value).map((id) => {
    if (!isReporter(id)) {
      throw new InvalidArgumentError(`unknown reporter "${id}"; expected ${REPORTERS.join(', ')}`);
    }
    return id;
  });
}

const TAG_MODES = ['any', 'all'] as const;
type TagMode = (typeof TAG_MODES)[number];

/** The exit-code table of the CLI reference; the runner decides which one applies. */
const EXIT_CODES: readonly (readonly [code: string, meaning: string])[] = [
  ['0', 'every selected test passed, was flaky, or was skipped'],
  ['1', 'a test failed or timed out'],
  ['2', 'CLI, config, or agent policy error'],
  ['3', 'engine, app process, model provider, or artifact failure'],
  ['4', 'internal runner error'],
  ['130', 'interrupted by Ctrl-C or a CI signal'],
];

/** A titled block indented like commander's own help sections. */
function helpSection(title: string, lines: readonly string[]): string {
  return [pc.bold(title), ...lines.map((line) => `  ${line}`)].join('\n');
}

function examples(commands: readonly string[]): string {
  return helpSection(
    'Examples:',
    commands.map((command) => `${pc.dim('$')} ${command}`),
  );
}

function docsLine(path = ''): string {
  return `Docs: ${pc.underline(`${DOCS_URL}${path}`)}`;
}

/** Builds the commander program. */
function createProgram(): Command {
  const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
  const program = new Command('e2e');
  // The help option, the error hint, and the help styles are copied into each
  // subcommand as it is created, so they are set before any `.command()`.
  program
    .usage('<command> [options]')
    .version(version, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help')
    .helpCommand('help [command]', 'show help for a command')
    .showHelpAfterError('(add --help for usage)')
    .configureHelp({
      styleTitle: pc.bold,
      styleCommandText: pc.cyan,
      styleOptionTerm: pc.cyan,
      styleSubcommandTerm: pc.cyan,
      styleArgumentTerm: pc.cyan,
    })
    .addHelpText('before', `${pc.bold(`e2e v${version}`)} ${pc.dim('·')} local-first agentic end-to-end testing\n`)
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e init',
          'e2e run',
          'e2e run tests/signup.e2e.ts --headed',
          'e2e run --tag smoke --reporter list,junit',
        ]),
        '',
        `Run ${pc.cyan('e2e <command> --help')} for the flags of one command.`,
        docsLine(),
      ].join('\n'),
    );
  // Commander would exit(1) on a usage error itself; the exit-code table reserves 1
  // for product failures and 2 for CLI errors, so exits are decided in main.
  program.exitOverride();

  program
    .command('init')
    .summary('scaffold an ESM package, e2e.config.ts, an example test, and .gitignore entries')
    .description(
      'Scaffold a project without touching existing files: an ESM package.json, e2e.config.ts, tests/example.e2e.ts, and .gitignore entries. Prompts for the engine and for AI support, then offers to install the dependencies.',
    )
    .option('-y, --yes', 'skip the prompts: AI on, no engine, no installation')
    .addHelpText('after', ['', examples(['e2e init', 'e2e init --yes']), '', docsLine('/reference/cli')].join('\n'))
    .action(async (options: InitOptions) => {
      process.exitCode = await init(process.cwd(), options);
    });

  program
    .command('run')
    .summary('run the tests')
    .description(
      'Run the tests the config discovers and write .e2e/report.json. Files, directories, and quoted globs narrow that selection, as do --tag and --target.',
    )
    .argument('[files...]', 'test files, directories, or globs relative to the project root')
    .optionsGroup('Selection:')
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <ids>', 'comma-separated target names (default: all targets)', parseList)
    .option('--tag <tag>', 'only tests with this tag; repeat to combine', (value: string, previous: string[] = []) => [
      ...previous,
      value,
    ])
    .addOption(new Option('--tag-mode <mode>', 'how repeated tags combine').choices(TAG_MODES).default('any'))
    .option('--pass-with-no-tests', 'exit 0 on an empty selection instead of NO_TESTS')
    .optionsGroup('Execution:')
    .option('--headed', 'show the UI while tests run, when the engine supports it')
    .option('--workers <n>', 'parallel workers (default: from the config)', parseNonNegativeInt)
    .option('--retries <n>', 'retries per failing test (default: from the config)', parseNonNegativeInt)
    .option('--no-cache', 'run with the trace cache off, whatever the config says')
    .optionsGroup('Output:')
    .option('--reporter <ids>', 'comma-separated reporters: list, json, junit', parseReporters)
    .option('--artifacts <dir>', 'artifact root (default: .e2e/artifacts)')
    .option('--debug', 'print phase timings and the agent step table to stderr')
    .option('--ai-trace', 'record every model call to .e2e/ai-trace.json (unbox-ai)')
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e run',
          'e2e run tests/signup.e2e.ts --headed',
          "e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke",
          'e2e run --reporter list,junit --workers 4 --retries 2',
          'E2E_MODEL=provider/model-id E2E_MODEL_API_KEY=... e2e run --no-cache',
        ]),
        '',
        helpSection(
          'Exit codes:',
          EXIT_CODES.map(([code, meaning]) => `${pc.cyan(code.padEnd(3))}  ${meaning}`),
        ),
        '',
        docsLine('/reference/cli#exit-codes'),
      ].join('\n'),
    )
    .action(
      async (
        files: string[],
        // Each value is what its parser returned, so a bad one never reaches here.
        options: {
          config?: string;
          target?: string[];
          tag?: string[];
          tagMode: TagMode;
          headed?: boolean;
          retries?: number;
          workers?: number;
          reporter?: Reporter[];
          artifacts?: string;
          /** Commander negation: `--no-cache` parses as `cache: false`. */
          cache?: boolean;
          passWithNoTests?: boolean;
          debug?: boolean;
          aiTrace?: boolean;
        },
      ) => {
        const signals = new SignalLadder();
        const release = signals.arm();
        try {
          const outcome = await run({
            files,
            configPath: options.config,
            targetIds: options.target,
            tags: options.tag,
            tagMode: options.tagMode,
            headed: options.headed,
            retries: options.retries,
            workers: options.workers,
            reporters: options.reporter,
            artifactsDir: options.artifacts,
            noCache: options.cache === false,
            passWithNoTests: options.passWithNoTests,
            debug: options.debug,
            aiTrace: options.aiTrace,
            interruptSignal: signals.interruptSignal,
            forceSignal: signals.forceSignal,
          });
          process.exitCode = outcome.exitCode;
        } finally {
          release();
        }
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
    if (cause instanceof CommanderError) {
      // Commander has already written its diagnostic. `--help` and
      // `--version` exit 0; every usage error is a CLI error: exit 2.
      process.exitCode = cause.exitCode === 0 ? 0 : 2;
      return;
    }
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  }
}
