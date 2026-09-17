/** e2e CLI. */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import picocolors from 'picocolors';
import { detectPackageManager, execCommand, runScriptCommand } from '../internal/package-manager.ts';
import { packageVersion } from '../internal/package-version.ts';
import { classifyError, exitCodeForCategory } from '../internal/errors.ts';
import { list, run, type ListedPair, type RunOutcome } from '../run/runner.ts';
import { explore, STEP_BOUNDS, TIMEOUT_BOUNDS } from '../explore/index.ts';
import { BUILTIN_REPORTERS, isBuiltinReporter } from '../report/builtin.ts';
import type { BuiltinReporter } from '../types.ts';
import { cliSessionEvent, runCompletedEvent } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import { cache, type CacheCommand } from './cache.ts';
import { DOCS_URL } from './docs-url.ts';
import { guide } from './guide.ts';
import { init } from './init.ts';
import { mcp } from './mcp.ts';
import { LOGIN_PROVIDERS, login, logout, type LoginOptions } from './login.ts';
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

/** An integer inside a closed range, for the explore budgets. */
function parseBoundedInt(bounds: { readonly min: number; readonly max: number }): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
      throw new InvalidArgumentError(`must be an integer from ${bounds.min} through ${bounds.max}`);
    }
    return parsed;
  };
}

const FILES_DESCRIPTION =
  'test files, directories, or globs relative to the project root; a bare file name (signup.e2e.ts, signup) or a trailing part of the path (agent/signup.e2e.ts) also selects the file';

/**
 * A flag commander took for a file because a `--` came before it, which is
 * what a package manager forwards from `pnpm test:e2e -- --headed`. Left
 * alone, the flag is dropped and the run goes on without it, so the action
 * fails as a usage error naming the command that keeps the flag a flag: the
 * whole tail from the first such value, so option values stay with their
 * option. A dash-prefixed name that exists is a file, as it always was.
 */
function rejectForwardedFlags(command: Command, files: readonly string[]): void {
  const cwd = process.cwd();
  const first = files.findIndex((value) => value.startsWith('-') && !existsSync(resolvePath(cwd, value)));
  if (first === -1) return;
  const tail = files.slice(first).join(' ');
  const manager = detectPackageManager(cwd);
  const forwarded = `${runScriptCommand(manager, 'test:e2e')} -- ${tail}`;
  const direct = execCommand(manager, `e2e ${command.name()} ${tail}`);
  command.error(
    `error: "${files[first]}" is a flag, not a test file. It arrived as a file because a "--" came before it; "${forwarded}" reaches e2e as "${command.name()} -- ${tail}" when the package manager forwards the separator. Run the CLI directly instead: ${direct}`,
    { exitCode: 2 },
  );
}

type Reporter = BuiltinReporter;

/** Reporter ids, comma-separated; the CLI only rejects ids it does not know. */
function parseReporters(value: string): Reporter[] {
  return parseList(value).map((id) => {
    if (!isBuiltinReporter(id)) {
      throw new InvalidArgumentError(`unknown reporter "${id}"; expected ${BUILTIN_REPORTERS.join(', ')}`);
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

/** `explore` exits as `run` does; only what a pass and a failure mean differs. */
const EXPLORE_EXIT_MEANINGS: Readonly<Record<string, string>> = {
  '0': 'the exploration ran and reported no issue (warnings do not count)',
  '1': 'at least one issue was reported, or nothing could be explored',
};
const EXPLORE_EXIT_CODES = EXIT_CODES.map(([code, meaning]) => [code, EXPLORE_EXIT_MEANINGS[code] ?? meaning] as const);

/** A titled block indented like commander's own help sections. */
function helpSection(title: string, lines: readonly string[]): string {
  return [pc.bold(title), ...lines.map((line) => `  ${line}`)].join('\n');
}

function exitCodesSection(codes: readonly (readonly [code: string, meaning: string])[]): string {
  return helpSection(
    'Exit codes:',
    codes.map(([code, meaning]) => `${pc.cyan(code.padEnd(3))}  ${meaning}`),
  );
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

/**
 * Runs a command that ends in a run outcome: under the Ctrl-C ladder, with the
 * exit code the outcome carries, and the run recorded for telemetry. What
 * throws before a run starts (a config that would not load, an unknown agent
 * or target) prints as `CODE: message` with the code's exit status; the run's
 * own failures are already in its report and its exit code.
 */
async function runToOutcome(
  telemetry: Telemetry,
  command: Command,
  start: (signals: SignalLadder) => Promise<RunOutcome>,
): Promise<void> {
  const signals = new SignalLadder();
  const release = signals.arm();
  try {
    const outcome = await start(signals);
    process.exitCode = outcome.exitCode;
    // The run event is the report's own numbers; every run has a report, even one that failed before its first test.
    telemetry.record(runCompletedEvent(outcome.report, usedFlags(command)));
  } catch (cause) {
    const error = classifyError(cause);
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = exitCodeForCategory(error.category);
  } finally {
    release();
  }
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
          "e2e explore 'Explore checkout like a first-time buyer and find bugs'",
          'e2e list --tag smoke',
          'e2e cache ls',
          'e2e guide',
          'e2e mcp',
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
    .command('login')
    .summary('sign in to a ChatGPT, GitHub Copilot, or SuperGrok subscription for agent steps')
    .description(
      'Sign in once to a personal subscription and store the login for @e2edev/oauth models: openai (ChatGPT Plus/Pro, the Codex sign-in), github-copilot (GitHub Copilot; reuses the GitHub CLI login or runs a device flow for your OAuth App), xai (SuperGrok or X Premium+, device code). The config then constructs the model with chatgpt(), copilot(), or grok() from @e2edev/oauth. Requires @e2edev/oauth in the project.',
    )
    .addArgument(new Argument('[provider]', 'openai, github-copilot, or xai; omitted, a picker').choices(LOGIN_PROVIDERS))
    .option('--device', 'ChatGPT: show a code to enter on another device instead of opening a browser')
    .option('--client-id <id>', 'GitHub Copilot: the client id of your GitHub OAuth App with the device flow enabled')
    .option('--from-gh', 'GitHub Copilot: reuse the token of the signed-in GitHub CLI')
    .option('--enterprise-url <host>', 'GitHub Copilot: the GitHub Enterprise host')
    .addHelpText(
      'after',
      ['', examples(['e2e login openai', 'e2e login github-copilot --from-gh', 'e2e login xai', 'e2e login']), '', docsLine('/subscriptions')].join('\n'),
    )
    .action(async (provider: string | undefined, options: LoginOptions) => {
      process.exitCode = await login(process.cwd(), provider, options);
    });

  program
    .command('logout')
    .summary('forget a stored subscription login')
    .description('Remove the stored login of one provider (openai, github-copilot, xai). Without a provider, a picker over the stored logins.')
    .addArgument(new Argument('[provider]', 'openai, github-copilot, or xai; omitted, a picker').choices(LOGIN_PROVIDERS))
    .addHelpText('after', ['', examples(['e2e logout', 'e2e logout openai']), '', docsLine('/subscriptions')].join('\n'))
    .action(async (provider: string | undefined) => {
      process.exitCode = await logout(process.cwd(), provider);
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
    .command('mcp')
    .summary('serve the project to a coding agent over MCP')
    .description(
      'Serve an MCP server over stdio for a coding agent such as Claude Code or Cursor: open_session opens a live session on one target of any config the agent names, call runs the session\'s tools (observe, tap, type, press, select, scroll, navigate, type_secret, locate, screenshot, and the project\'s own), tools describes them, close_session ends it. The agent explores the real app before writing a test. Register it with the client, e.g. claude mcp add e2e -- npx e2e mcp.',
    )
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <name>', 'target every session opens on (default: the only target, or the one open_session names)')
    .option('--headless', 'hide the UI during live sessions (default: headed outside CI)')
    .addHelpText(
      'after',
      [
        '',
        examples(['e2e mcp', 'e2e mcp --target web --headless', 'claude mcp add e2e -- npx e2e mcp']),
        '',
        docsLine('/reference/mcp'),
      ].join('\n'),
    )
    .action(async (options: { config?: string; target?: string; headless?: boolean }) => {
      process.exitCode = await mcp(version, options);
    });

  program
    .command('run')
    .summary('run the tests')
    .description(
      'Run the tests the config discovers and write .e2e/report.json. Files, directories, and quoted globs narrow that selection, as do --tag and --target.',
    )
    .argument('[files...]', FILES_DESCRIPTION)
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
    .option(
      '--agent <names>',
      'the configured agent unpinned tests run with (default: agents.default); comma-separated or repeated names run each such test once per agent',
      (value: string, previous: string[] = []) => [...previous, ...parseList(value)],
    )
    .option('--workers <n>', 'parallel workers (default: from the config)', parseNonNegativeInt)
    .option('--retries <n>', 'retries per failing test (default: from the config)', parseNonNegativeInt)
    .option('--no-cache', 'run with the trace cache off, whatever the config says')
    .optionsGroup('Output:')
    .option('--reporter <ids>', `comma-separated reporters: ${BUILTIN_REPORTERS.join(', ')}`, parseReporters)
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
          'e2e run --agent buyer,admin tests/checkout.e2e.ts',
          'AI_GATEWAY_API_KEY=... e2e run --no-cache',
        ]),
        '',
        exitCodesSection(EXIT_CODES),
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
          agent?: string[];
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
        rejectForwardedFlags(command, files);
        return runToOutcome(telemetry, command, (signals) =>
          run({
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
          }),
        );
      },
    );

  program
    .command('explore')
    .summary('explore the app toward a goal and report findings, without a test file')
    .description(
      'Run the agent against the app with a goal instead of a test: it plans one exploration step at a time, drives the app, reports every defect it has evidence of, and ends with an assessment. The run writes .e2e/report.json like e2e run, with the exploration record under run.explore. The model is the one the selected agent holds, as for e2e run.',
    )
    .argument('[goal]', 'what to explore, in a sentence (default: "Explore the app and find bugs")')
    .optionsGroup('Selection:')
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <id>', 'the target to explore (default: the first configured target)')
    .option('--agent <name>', 'the configured agent to explore with (default: agents.default)')
    .optionsGroup('Budgets:')
    .option(
      '--max-steps <n>',
      `exploration steps at most, ${STEP_BOUNDS.min} through ${STEP_BOUNDS.max} (default: ${STEP_BOUNDS.default})`,
      parseBoundedInt(STEP_BOUNDS),
    )
    .option(
      '--timeout <ms>',
      `wall clock in milliseconds, ${TIMEOUT_BOUNDS.min} through ${TIMEOUT_BOUNDS.max} (default: ${TIMEOUT_BOUNDS.default})`,
      parseBoundedInt(TIMEOUT_BOUNDS),
    )
    .optionsGroup('Execution:')
    .option('--headed', 'show the UI while the agent explores, when the engine supports it')
    .optionsGroup('Output:')
    .option('--reporter <ids>', `comma-separated reporters: ${BUILTIN_REPORTERS.join(', ')}`, parseReporters)
    .option('--artifacts <dir>', 'artifact root (default: .e2e/artifacts)')
    .option('--debug', 'print phase timings and the agent step table to stderr')
    .option('--ai-trace', 'record every model call to .e2e/ai-trace.json (unbox-ai)')
    .option('--video', 'record a video of the exploration, when the engine supports it')
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e explore',
          "e2e explore 'Explore the checkout flow like a first-time buyer and report anything off'",
          'e2e explore --target web --max-steps 4 --headed',
          "e2e explore --agent ux 'Review onboarding as a first-time user'",
          "e2e explore 'Hunt for broken forms and dead links' --video",
        ]),
        '',
        exitCodesSection(EXPLORE_EXIT_CODES),
        '',
        docsLine('/explore'),
      ].join('\n'),
    )
    .action(
      async (
        goal: string | undefined,
        options: {
          config?: string;
          target?: string;
          agent?: string;
          maxSteps?: number;
          timeout?: number;
          headed?: boolean;
          reporter?: Reporter[];
          artifacts?: string;
          debug?: boolean;
          aiTrace?: boolean;
          video?: boolean;
        },
        command: Command,
      ) =>
        runToOutcome(telemetry, command, (signals) =>
          explore({
            goal,
            configPath: options.config,
            target: options.target,
            agent: options.agent,
            maxSteps: options.maxSteps,
            timeoutMs: options.timeout,
            headed: options.headed,
            reporters: options.reporter,
            artifactsDir: options.artifacts,
            debug: options.debug,
            aiTrace: options.aiTrace,
            video: options.video,
            interruptSignal: signals.interruptSignal,
            forceSignal: signals.forceSignal,
            notice: (message) => process.stderr.write(`e2e explore: ${message}\n`),
          }),
        ),
    );

  program
    .command('list')
    .summary('print the tests a run would select, without running them')
    .description(
      'Collect and select tests exactly as run does, print one line per test and target (file › title [target]), and exit. Nothing starts: no app process, no engine, no worker. The same files, --tag, and --target flags narrow the selection.',
    )
    .argument('[files...]', FILES_DESCRIPTION)
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
        command: Command,
      ) => {
        rejectForwardedFlags(command, files);
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
