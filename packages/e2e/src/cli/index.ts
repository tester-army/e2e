/** e2e CLI. */

import { resolve as resolvePath } from 'node:path';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import picocolors from 'picocolors';
import { packageVersion } from '../internal/package-version.ts';
import { classifyError, exitCodeForCategory } from '../internal/errors.ts';
import { list, run, type ListedPair } from '../run/runner.ts';
import { cliSessionEvent, runCompletedEvent } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import { cache, type CacheCommand } from './cache.ts';
import { DOCS_URL } from './docs-url.ts';
import { guide } from './guide.ts';
import { init } from './init.ts';
import { SignalLadder } from './signals.ts';
import { skillTopics } from './skill.ts';
import { telemetry as telemetryCommand, TELEMETRY_ACTIONS, type TelemetryAction } from './telemetry.ts';

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

const LIST_REPORTERS = ['list', 'json'] as const;
type ListReporter = (typeof LIST_REPORTERS)[number];

/** One `e2e list` line: `file › title [target]`, with the skip reason when there is one. */
function formatListedPair(pair: ListedPair): string {
  const line = `${pair.file} › ${pair.titlePath.join(' › ')} [${pair.target}]`;
  return pair.disposition === 'skip' ? `${line} (skipped: ${pair.skipReason ?? 'skipped'})` : line;
}

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

/** `run`, `cache ls`: the command path below the root, as the session event names it. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null && current.parent !== null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

/** The long names of the flags given on the command line: a closed set, never their values. */
function usedFlags(command: Command): string[] {
  return command.options
    .flatMap((option) =>
      option.long !== undefined && command.getOptionValueSource(option.attributeName()) === 'cli' ? [option.long] : [],
    )
    .toSorted();
}

/** Builds the commander program. */
function createProgram(version: string, telemetry: Telemetry): Command {
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
    .addHelpText('before', `${pc.bold(`e2e v${version}`)} ${pc.dim('·')} an open framework for agentic end-to-end testing\n`)
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e init',
          'e2e run',
          'e2e run tests/signup.e2e.ts --headed',
          'e2e run --tag smoke --reporter list,junit',
          'e2e list --tag smoke',
          'e2e cache ls',
          'e2e guide',
          'e2e telemetry disable',
        ]),
        '',
        `Run ${pc.cyan('e2e <command> --help')} for the flags of one command.`,
        docsLine(),
      ].join('\n'),
    );
  // Commander would exit(1) on a usage error itself; the exit-code table reserves 1
  // for product failures and 2 for CLI errors, so exits are decided in main.
  program.exitOverride();
  // Every command that runs is one session event. The notice precedes the
  // first of them on a machine, except `telemetry` itself: that is where
  // someone who read the notice goes to act on it.
  program.hook('preAction', (_program, actionCommand) => {
    const command = commandPath(actionCommand);
    if (command !== 'telemetry') telemetry.notice();
    telemetry.record(cliSessionEvent(command, usedFlags(actionCommand)));
  });

  program
    .command('init')
    .summary('scaffold an ESM package, e2e.config.ts, an example test, .gitignore entries, and the agent skill')
    .description(
      'Scaffold a project without touching existing files: an ESM package.json, e2e.config.ts, tests/example.e2e.ts, .gitignore entries, and the e2e skill for coding agents. Prompts for the engine, for AI support, and for the skill directories, then offers to install the dependencies; --yes takes the defaults, with the skill in .agents/skills and .claude/skills.',
    )
    .argument('[directory]', 'project directory, created when missing (default: the current directory)')
    .option('-y, --yes', 'skip the prompts: Playwright, AI on, no installation')
    .addHelpText(
      'after',
      ['', examples(['e2e init', 'e2e init my-app', 'e2e init --yes']), '', docsLine('/reference/cli')].join('\n'),
    )
    .action(async (directory: string | undefined, options: { yes?: boolean }) => {
      process.exitCode = await init(resolvePath(process.cwd(), directory ?? '.'), {
        ...options,
        ...(directory === undefined ? {} : { directory }),
        // Prompts need a terminal on both ends; a pipe or a CI log has neither.
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      });
    });

  program
    .command('guide')
    .summary('print the e2e skill for coding agents')
    .description(
      'Print the skill that init installs: how to set up e2e, write tests, use agent steps, run the CLI, and read a failing run. Without a topic, prints the overview and the topic list.',
    )
    .argument('[topic]', `one of ${skillTopics().join(', ')}`)
    .addHelpText('after', ['', examples(['e2e guide', 'e2e guide writing-tests']), '', docsLine('/reference/cli#e2e-guide')].join('\n'))
    .action((topic: string | undefined) => {
      process.exitCode = guide(topic);
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
    .option('--agent <name>', 'the configured agent to run with (default: agents.default)')
    .option('--workers <n>', 'parallel workers (default: from the config)', parseNonNegativeInt)
    .option('--retries <n>', 'retries per failing test (default: from the config)', parseNonNegativeInt)
    .option('--no-cache', 'run with the trace cache off, whatever the config says')
    .optionsGroup('Output:')
    .option('--reporter <ids>', 'comma-separated reporters: list, json, junit', parseReporters)
    .option('--artifacts <dir>', 'artifact root (default: .e2e/artifacts)')
    .option('--debug', 'print phase timings and the agent step table to stderr')
    .option('--ai-trace', 'record every model call to .e2e/ai-trace.json (unbox-ai)')
    .option('--video', 'record a video of every attempt, when the engine supports it')
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e run',
          'e2e run tests/signup.e2e.ts --headed',
          "e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke",
          'e2e run --reporter list,junit --workers 4 --retries 2',
          'e2e run --agent ux tests/onboarding.e2e.ts',
          'AI_GATEWAY_API_KEY=... e2e run --no-cache',
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
          agent?: string;
          retries?: number;
          workers?: number;
          reporter?: Reporter[];
          artifacts?: string;
          /** Commander negation: `--no-cache` parses as `cache: false`. */
          cache?: boolean;
          passWithNoTests?: boolean;
          debug?: boolean;
          aiTrace?: boolean;
          video?: boolean;
        },
        command: Command,
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
            agent: options.agent,
            retries: options.retries,
            workers: options.workers,
            reporters: options.reporter,
            artifactsDir: options.artifacts,
            noCache: options.cache === false,
            passWithNoTests: options.passWithNoTests,
            debug: options.debug,
            aiTrace: options.aiTrace,
            video: options.video,
            interruptSignal: signals.interruptSignal,
            forceSignal: signals.forceSignal,
          });
          process.exitCode = outcome.exitCode;
          // The run event is the report's own numbers; every run has a report, even one that failed before its first test.
          telemetry.record(runCompletedEvent(outcome.report, usedFlags(command)));
        } finally {
          release();
        }
      },
    );

  program
    .command('list')
    .summary('print the tests a run would select, without running them')
    .description(
      'Collect and select tests exactly as run does, print one line per test and target (file › title [target]), and exit. Nothing starts: no app process, no engine, no worker. The same files, --tag, and --target flags narrow the selection.',
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
    .optionsGroup('Output:')
    .addOption(
      new Option('--reporter <id>', 'list prints one line per pair; json prints { pairs: [...] }')
        .choices(LIST_REPORTERS)
        .default('list'),
    )
    .addHelpText(
      'after',
      [
        '',
        examples(['e2e list', 'e2e list tests/signup.e2e.ts', 'e2e list --tag smoke --target web', 'e2e list --reporter json']),
        '',
        docsLine('/reference/cli#e2e-list'),
      ].join('\n'),
    )
    .action(
      async (
        files: string[],
        options: {
          config?: string;
          target?: string[];
          tag?: string[];
          tagMode: TagMode;
          passWithNoTests?: boolean;
          reporter: ListReporter;
        },
      ) => {
        let pairs: ListedPair[];
        try {
          ({ pairs } = await list({
            files,
            configPath: options.config,
            targetIds: options.target,
            tags: options.tag,
            tagMode: options.tagMode,
            passWithNoTests: options.passWithNoTests,
          }));
        } catch (cause) {
          const error = classifyError(cause);
          process.stderr.write(`${error.code}: ${error.message}\n`);
          process.exitCode = exitCodeForCategory(error.category);
          return;
        }
        process.stdout.write(
          options.reporter === 'json'
            ? `${JSON.stringify({ pairs }, null, 2)}\n`
            : pairs.map((pair) => `${formatListedPair(pair)}\n`).join(''),
        );
        process.exitCode = 0;
      },
    );

  const cacheCommand = program
    .command('cache')
    .summary('inspect, measure, and clear the trace cache')
    .description(
      'Read the trace cache the runs write under .e2e/cache: what a committed cache holds, how much room it takes, and how to empty it. Reads the same config as e2e run, so cache.dir and --config decide which store is meant.',
    )
    .addHelpText(
      'after',
      ['', examples(['e2e cache ls', 'e2e cache stats', 'e2e cache clear']), '', docsLine('/reference/cli#e2e-cache')].join('\n'),
    );

  const cacheSubcommand = (name: CacheCommand, summary: string, description: string): void => {
    cacheCommand
      .command(name)
      .summary(summary)
      .description(description)
      .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
      .action(async (options: { config?: string }) => {
        process.exitCode = await cache(name, options);
      });
  };

  cacheSubcommand(
    'ls',
    'list the cached traces',
    'Print one row per cached trace: the test and target it was recorded for, the digest of its instruction, its age, and how many actions a replay would run.',
  );
  cacheSubcommand('clear', 'delete every cached trace', 'Delete the cache files and the directory itself; files the runner never wrote are left alone.');
  cacheSubcommand('stats', 'print the entry count and size', 'Print the store directory, how many readable entries it holds, and how many bytes they take.');

  program
    .command('telemetry')
    .summary('show, enable, or disable anonymous usage telemetry')
    .description(
      'Print whether anonymous usage telemetry is on, and why not when it is off, or switch it. enable and disable save the choice to the preferences file; E2E_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 in the environment overrides it, and E2E_TELEMETRY_DEBUG=1 prints every event to stderr instead of sending it.',
    )
    .addArgument(new Argument('[action]', 'status, enable, or disable').choices(TELEMETRY_ACTIONS).default('status'))
    .addHelpText(
      'after',
      [
        '',
        examples(['e2e telemetry', 'e2e telemetry disable', 'E2E_TELEMETRY_DEBUG=1 e2e run']),
        '',
        docsLine('/telemetry'),
      ].join('\n'),
    )
    .action((action: TelemetryAction) => {
      process.exitCode = telemetryCommand(action, telemetry);
    });

  return program;
}

/** CLI entry invoked by the bin wrapper. */
export async function main(argv: readonly string[]): Promise<void> {
  const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
  const telemetry = new Telemetry({ version });
  const program = createProgram(version, telemetry);
  try {
    await program.parseAsync([...argv]);
  } catch (cause) {
    if (cause instanceof CommanderError) {
      // Commander has already written its diagnostic. `--help` and
      // `--version` exit 0; every usage error is a CLI error: exit 2.
      process.exitCode = cause.exitCode === 0 ? 0 : 2;
    } else {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 2;
    }
  } finally {
    // One bounded request; the deadline, not the network, decides when the CLI is done.
    await telemetry.flush();
  }
}
