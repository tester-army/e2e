/** e2e CLI. */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve as resolvePath, sep } from 'node:path';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import picocolors from 'picocolors';
import { detectPackageManager, execCommand, runScriptCommand } from '../internal/package-manager.ts';
import { packageVersion } from '../internal/package-version.ts';
import { classifyError, exitCodeForCategory } from '../internal/errors.ts';
import type { Shard, TagMode } from '../collect/select.ts';
import { list, run, type ListedPair, type RunOptions, type RunOutcome } from '../run/runner.ts';
import { explore, STEP_BOUNDS, TIMEOUT_BOUNDS } from '../explore/index.ts';
import { BUILTIN_REPORTERS, isBuiltinReporter } from '../report/builtin.ts';
import { bounded } from '../report/format.ts';
import type { BuiltinReporter, RecordingMode } from '../types.ts';
import { isRecordingMode, legacyTraceSpelling, RECORDING_MODES } from '../internal/recording-modes.ts';
import { runsFromCheckout } from '../telemetry/checkout.ts';
import { initCompletedEvent, runCompletedEvent, USAGE_ERROR_CODE } from '../telemetry/events.ts';
import { Telemetry } from '../telemetry/telemetry.ts';
import { cache, type CacheCommand } from './cache.ts';
import { DOCS_URL } from './docs-url.ts';
import { feedback, FEEDBACK_LIMITS, FEEDBACK_TYPES, type FeedbackReport } from './feedback.ts';
import { guide } from './guide.ts';
import { init } from './init.ts';
import { mcp } from './mcp.ts';
import { SESSION_BOUNDS } from '../mcp/session.ts';
import { PROVIDER_IDS } from '../oauth/providers.ts';
import { runLogin, runLogout, runModels, type LoginFlags } from '../oauth/cli.ts';
import { SignalLadder } from './signals.ts';
import { skillTopics } from './skill.ts';
import { telemetry as telemetryCommand, TELEMETRY_ACTIONS, type TelemetryAction } from './telemetry.ts';
import { wordmarkBanner } from './wordmark.ts';

/**
 * Help text always carries color; commander strips it when the stream it
 * writes to has none (not a TTY, `NO_COLOR`), so the decision is made once,
 * per stream, by the writer.
 */
const pc = picocolors.createColors(true);

/** A count of at least one, for `--max-failures`. */
function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new InvalidArgumentError('must be a positive integer');
  return parsed;
}

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

/**
 * Names, comma-separated or repeated, each once. An empty value is a usage
 * error rather than an empty list: `--tag "$TAGS"` with the variable unset
 * must not select every test, and `--target ''` must not select every target.
 */
function parseNames(noun: string): (value: string, previous?: string[]) => string[] {
  return (value, previous = []) => {
    const names = parseList(value);
    if (names.length === 0) throw new InvalidArgumentError(`must name at least one ${noun}`);
    return [...new Set([...previous, ...names])];
  };
}

/**
 * A regular expression for `--grep` and `--grep-invert`, accumulated: the
 * bare pattern (`checkout`), or `/pattern/flags` for flags (`/checkout/i`).
 * A pattern that does not compile is a usage error.
 */
function parsePattern(value: string, previous: RegExp[] = []): RegExp[] {
  const slashed = /^\/(.*)\/([a-z]*)$/su.exec(value);
  const [source, flags] = slashed === null ? [value, ''] : [slashed[1]!, slashed[2]!];
  if (source === '') throw new InvalidArgumentError('must be a regular expression');
  try {
    return [...previous, new RegExp(source, flags)];
  } catch (cause) {
    throw new InvalidArgumentError(`must be a regular expression: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** `index/total` for `--shard`, both counted from 1, the index within the total. */
function parseShard(value: string): Shard {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  const index = match === null ? Number.NaN : Number(match[1]);
  const total = match === null ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new InvalidArgumentError('must be index/total, such as 2/3, with the index from 1 through the total');
  }
  return { index, total };
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

/** Free text for `e2e feedback`: trimmed, never blank, at most `limit` characters. */
function parseText(limit: number): (value: string) => string {
  return (value) => {
    const text = value.trim();
    if (text === '') throw new InvalidArgumentError('must not be empty');
    const length = [...text].length;
    if (length > limit) throw new InvalidArgumentError(`must be at most ${limit} characters, got ${length}`);
    return text;
  };
}

const FILES_DESCRIPTION =
  'test files, directories, or globs relative to the project root; a bare file name (signup.e2e.ts, signup) or a trailing part of the path (agent/signup.e2e.ts) also selects the file, and file:line (tests/signup.e2e.ts:12) selects the test declared at that line';

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

/**
 * The parser of `--trace [mode]` or `--video [mode]`: a bare flag is `on`.
 * An optional value is greedy, so a test file after the flag would be read
 * as the mode; one that is not a mode is refused with the way to write it.
 */
function parseRecordingMode(flag: '--trace' | '--video'): (value: string) => RecordingMode {
  return (value) => {
    if (!isRecordingMode(value)) {
      const legacy = flag === '--trace' ? legacyTraceSpelling(value) : undefined;
      throw new InvalidArgumentError(
        legacy === undefined
          ? `expected a mode (${RECORDING_MODES.join(', ')}), got "${value}"; write ${flag}=<mode>, or put test files before ${flag}`
          : `"${value}" is the old spelling of ${flag} ${legacy.mode}; the modes are ${RECORDING_MODES.join(', ')}`,
      );
    }
    return value;
  };
}

/**
 * The removed `--artifacts <dir>`, kept hidden so a script that still passes
 * it fails with the new spelling: the directory's parent held the report
 * beside it, and is what `--output` names now. A parent the output could not
 * be (the working directory, above it, or an absolute path this parser
 * cannot place in the project) is not suggested; `.e2e` is.
 */
function removedArtifactsFlag(value: string): never {
  const parent = normalize(dirname(value));
  const suggestable = parent !== '.' && parent !== '..' && !parent.startsWith(`..${sep}`) && !isAbsolute(parent);
  throw new InvalidArgumentError(
    `--artifacts was removed: write --output ${suggestable ? parent : '.e2e'} instead. The report and the artifacts/ directory go under the output directory, which must be a directory inside the project, not its root (--artifacts out/artifacts is --output out)`,
  );
}

/** The mode `--trace [mode]` or `--video [mode]` parsed to: `on` for the bare flag, undefined when it was not given. */
function recordingOption(value: RecordingMode | true | undefined): RecordingMode | undefined {
  return value === true ? 'on' : value;
}

const TAG_MODES = ['any', 'all'] as const satisfies readonly TagMode[];

/** The selection flags `run` and `list` share, after `--config` and `--target`. */
function selectionOptions(command: Command): Command {
  return command
    .option(
      '--tag <tags>',
      'only tests carrying these tags, comma-separated or repeated: any of them, or every one with --tag-mode all',
      parseNames('tag'),
    )
    .addOption(new Option('--tag-mode <mode>', 'how several tags combine').choices(TAG_MODES).default('any'))
    .option('--exclude-tag <tags>', 'leave out tests carrying any of these tags, comma-separated or repeated', parseNames('tag'))
    .option('--grep <pattern>', 'only tests whose title matches the regular expression (describe titles and test title, space-joined); repeat for alternatives', parsePattern)
    .option('--grep-invert <pattern>', 'leave out tests whose title matches the regular expression; repeat for alternatives', parsePattern)
    .option('--last-failed', 'only the tests the previous run did not pass, read from <output>/report.json')
    .option('--shard <index/total>', 'one contiguous slice of the selected tests, such as 2/3; serial groups stay together', parseShard)
    .option('--pass-with-no-tests', 'exit 0 on an empty selection instead of NO_TESTS');
}

/** The values the shared selection flags parse to. */
interface SelectionFlagValues {
  tag?: string[];
  tagMode: TagMode;
  excludeTag?: string[];
  grep?: RegExp[];
  grepInvert?: RegExp[];
  lastFailed?: boolean;
  shard?: Shard;
  passWithNoTests?: boolean;
}

/** The shared selection flags as the runner's options. */
function selectionRunOptions(
  options: SelectionFlagValues,
): Pick<RunOptions, 'tags' | 'tagMode' | 'excludeTags' | 'grep' | 'grepInvert' | 'lastFailed' | 'shard' | 'passWithNoTests'> {
  return {
    tags: options.tag,
    tagMode: options.tagMode,
    excludeTags: options.excludeTag,
    grep: options.grep,
    grepInvert: options.grepInvert,
    lastFailed: options.lastFailed,
    shard: options.shard,
    passWithNoTests: options.passWithNoTests,
  };
}

const LIST_REPORTERS = ['list', 'json'] as const;
type ListReporter = (typeof LIST_REPORTERS)[number];

/** One `e2e list` line: `file › title [target] #tag`, with the skip reason when there is one. Titles and tags are bounded like every untrusted field. */
function formatListedPair(pair: ListedPair): string {
  const tags = pair.tags.map((tag) => ` #${bounded(tag)}`).join('');
  const line = `${pair.file} › ${pair.titlePath.map(bounded).join(' › ')} [${pair.target}]${tags}`;
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
    telemetry.record(runCompletedEvent(outcome.report, { command: commandPath(command), flags: usedFlags(command), config: outcome.config }));
  } catch (cause) {
    reportFailure(telemetry, cause);
  } finally {
    release();
  }
}

/** Prints a failure that stopped a command before it could run, sets the exit code, and names it in the session. */
function reportFailure(telemetry: Telemetry, cause: unknown): void {
  const error = classifyError(cause);
  process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exitCode = exitCodeForCategory(error.category);
  telemetry.failSession(error.code);
}

/** `command` and every command below it. */
function withSubcommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap(withSubcommands)];
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
    .addHelpText(
      'before',
      ({ error }) =>
        `${wordmarkBanner(error ? process.stderr : process.stdout)}${pc.bold(`e2e v${version}`)} ${pc.dim('·')} an open framework for agentic end-to-end testing\n`,
    )
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
          'e2e feedback --type bug -m "e2e list ignores --grep"',
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
  // Every command that runs is one session. The notice precedes the first
  // of them on a machine, with two exceptions: `init`, whose prompts and
  // summary are a newcomer's first sight of the CLI and should not open with a
  // disclaimer, and `telemetry` itself, where someone who read the notice goes
  // to act on it.
  program.hook('preAction', (_program, actionCommand) => {
    const command = commandPath(actionCommand);
    if (command !== 'init' && command !== 'telemetry') telemetry.notice();
    telemetry.session(command, usedFlags(actionCommand));
  });

  program
    .command('init')
    .summary('scaffold an ESM package, e2e.config.ts, an example test, .gitignore entries, and the agent skill')
    .description(
      'Scaffold a project without touching existing files: an ESM package.json, e2e.config.ts, tests/example.e2e.ts, .gitignore entries, and the e2e skill for coding agents. Prompts for the engine, for AI support, and for the skill directories, then offers to install the dependencies; --yes takes the defaults, with the skill in .agents/skills and .claude/skills linked to it.',
    )
    .argument('[directory]', 'project directory, created when missing (default: the current directory)')
    .option('-y, --yes', 'skip the prompts: Playwright, AI on, no installation')
    .addHelpText(
      'after',
      ['', examples(['e2e init', 'e2e init my-app', 'e2e init --yes']), '', docsLine('/reference/cli')].join('\n'),
    )
    .action(async (directory: string | undefined, options: { yes?: boolean }) => {
      const { exitCode, ...outcome } = await init(resolvePath(process.cwd(), directory ?? '.'), {
        ...options,
        ...(directory === undefined ? {} : { directory }),
        // Prompts need a terminal on both ends; a pipe or a CI log has neither.
        interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      });
      telemetry.record(initCompletedEvent(outcome));
      process.exitCode = exitCode;
    });

  program
    .command('login')
    .summary('sign in to a ChatGPT, GitHub Copilot, OpenCode Console, or SuperGrok subscription for agent steps')
    .description(
      'Sign in once to a personal subscription and store the login for the e2e/oauth models: openai (ChatGPT Plus/Pro, the Codex sign-in), github-copilot (GitHub Copilot; reuses the GitHub CLI login or runs a device flow for your OAuth App), opencode-console (OpenCode Console, device code), spacexai (SuperGrok or X Premium+, device code). The config then constructs the model with chatgpt(), copilot(), opencodeConsole(), or grok() from e2e/oauth/<provider>.',
    )
    .addArgument(new Argument('[provider]', 'openai, github-copilot, opencode-console, or spacexai; omitted, a picker').choices(PROVIDER_IDS))
    .option('--device', 'ChatGPT: show a code to enter on another device instead of opening a browser')
    .option('--client-id <id>', 'GitHub Copilot: the client id of your GitHub OAuth App with the device flow enabled')
    .option('--from-gh', 'GitHub Copilot: reuse the token of the signed-in GitHub CLI')
    .option('--enterprise-url <host>', 'GitHub Copilot: the GitHub Enterprise host')
    .addHelpText(
      'after',
      ['', examples(['e2e login openai', 'e2e login github-copilot --from-gh', 'e2e login opencode-console', 'e2e login spacexai', 'e2e login']), '', docsLine('/subscriptions')].join('\n'),
    )
    .action(async (provider: string | undefined, options: LoginFlags) => {
      process.exitCode = await runLogin(provider, options);
    });

  program
    .command('logout')
    .summary('forget a stored subscription login')
    .description('Remove the stored login of one provider (openai, github-copilot, opencode-console, spacexai). Without a provider, a picker over the stored logins.')
    .addArgument(new Argument('[provider]', 'openai, github-copilot, opencode-console, or spacexai; omitted, a picker').choices(PROVIDER_IDS))
    .addHelpText('after', ['', examples(['e2e logout', 'e2e logout openai']), '', docsLine('/subscriptions')].join('\n'))
    .action(async (provider: string | undefined) => {
      process.exitCode = await runLogout(provider);
    });

  program
    .command('models')
    .summary('list the models a stored subscription login serves')
    .description(
      'Ask the vendor which models the stored login serves and print their ids, the ones chatgpt(), copilot(), opencodeConsole(), and grok() take. Without a provider, every stored login in turn.',
    )
    .addArgument(new Argument('[provider]', 'openai, github-copilot, opencode-console, or spacexai; omitted, every stored login').choices(PROVIDER_IDS))
    .addHelpText('after', ['', examples(['e2e models', 'e2e models openai']), '', docsLine('/subscriptions#pick-a-model')].join('\n'))
    .action(async (provider: string | undefined) => {
      process.exitCode = await runModels(provider);
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
    .option('--headed', 'show the UI in sessions whose open_session does not set headed, when the engine supports it')
    // Sessions were headed by default before 0.18 and took --headless; a client config that still passes it
    // asks for the default now, and a refused flag would surface as nothing but a failed connection.
    .addOption(new Option('--headless').hideHelp())
    .option(
      '--max-sessions <n>',
      `sessions open at once, each with its own browser or device, ${SESSION_BOUNDS.min} through ${SESSION_BOUNDS.max} (default: ${SESSION_BOUNDS.default})`,
      parseBoundedInt(SESSION_BOUNDS),
    )
    .addHelpText(
      'after',
      [
        '',
        examples(['e2e mcp', 'e2e mcp --target web --headed', 'e2e mcp --max-sessions 8', 'claude mcp add e2e -- npx e2e mcp']),
        '',
        docsLine('/reference/mcp'),
      ].join('\n'),
    )
    .action(async (options: { config?: string; target?: string; headed?: boolean; maxSessions?: number }) => {
      process.exitCode = await mcp(version, options, telemetry);
    });

  const runCommand = program
    .command('run')
    .summary('run the tests')
    .description(
      'Run the tests the config discovers and write <output>/report.json (.e2e by default). Files, directories, and quoted globs narrow that selection, as do --tag, --exclude-tag, --grep, and --target.',
    )
    .argument('[files...]', FILES_DESCRIPTION)
    .optionsGroup('Selection:')
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <ids>', 'target names, comma-separated or repeated (default: all targets)', parseNames('target'));
  selectionOptions(runCommand)
    .optionsGroup('Execution:')
    .option('--headed', 'show the UI while tests run, when the engine supports it')
    .option(
      '--agent <names>',
      'the configured agent unpinned tests run with (default: agents.default); comma-separated or repeated names run each such test once per agent',
      parseNames('agent'),
    )
    .option('--workers <n>', 'parallel workers (default: from the config)', parseNonNegativeInt)
    .option('--retries <n>', 'retries per failing test (default: from the config)', parseNonNegativeInt)
    .option('--max-failures <n>', 'stop the run once this many tests have failed; the rest are skipped', parsePositiveInt)
    .option('--repeat-each <n>', 'run every selected test this many times, each run its own result (pair with --no-cache to exercise the model each time)', parsePositiveInt)
    .option('--no-cache', 'run with the replay cache off, whatever the config says')
    .option('--strict-cache', 'fail a step whose recording no longer replays (REPLAY_STALE) instead of handing it to the agent')
    .optionsGroup('Output:')
    .option('--reporter <ids>', `comma-separated reporters: ${BUILTIN_REPORTERS.join(', ')}`, parseReporters)
    .option('--output <dir>', 'results directory: report, artifacts, sessions (default: output in the config, else .e2e)')
    .addOption(new Option('--artifacts <dir>').hideHelp().argParser(removedArtifactsFlag))
    .option('--debug', 'print phase timings and the agent step table to stderr')
    .option('--ai-trace', 'record every model call to <output>/ai-trace.json (unbox-ai)')
    .option('--trace [mode]', `which attempts record a trace: ${RECORDING_MODES.join(', ')} (bare: on), over the config and every target`, parseRecordingMode('--trace'))
    .option('--video [mode]', `which attempts record a video: ${RECORDING_MODES.join(', ')} (bare: on), over the config and every target`, parseRecordingMode('--video'))
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e run',
          'e2e run tests/signup.e2e.ts --headed',
          "e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke",
          'e2e run --tag smoke,billing --tag-mode all',
          'e2e run --tag smoke --exclude-tag slow',
          "e2e run --grep checkout --grep-invert '/refund/i'",
          'e2e run --last-failed',
          'e2e run --shard 2/3',
          'e2e run --reporter list,junit --workers 4 --retries 2',
          'e2e run --max-failures 3',
          'e2e run --repeat-each 5 --no-cache tests/checkout.e2e.ts',
          'CI=1 e2e run --strict-cache',
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
        options: SelectionFlagValues & {
          config?: string;
          target?: string[];
          headed?: boolean;
          agent?: string[];
          retries?: number;
          workers?: number;
          maxFailures?: number;
          repeatEach?: number;
          reporter?: Reporter[];
          output?: string;
          /** Commander negation: `--no-cache` parses as `cache: false`. */
          cache?: boolean;
          strictCache?: boolean;
          debug?: boolean;
          aiTrace?: boolean;
          trace?: RecordingMode | true;
          video?: RecordingMode | true;
        },
        command: Command,
      ) => {
        rejectForwardedFlags(command, files);
        return runToOutcome(telemetry, command, (signals) =>
          run({
            files,
            configPath: options.config,
            targetIds: options.target,
            ...selectionRunOptions(options),
            headed: options.headed,
            agent: options.agent,
            retries: options.retries,
            workers: options.workers,
            maxFailures: options.maxFailures,
            repeatEach: options.repeatEach,
            reporters: options.reporter,
            output: options.output,
            noCache: options.cache === false,
            strictCache: options.strictCache,
            debug: options.debug,
            aiTrace: options.aiTrace,
            trace: recordingOption(options.trace),
            video: recordingOption(options.video),
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
      'Run the agent against the app with a goal instead of a test: it plans one exploration step at a time, drives the app, reports every defect it has evidence of, and ends with an assessment. The run writes <output>/report.json like e2e run, with the exploration record under run.explore. The model is the one the selected agent holds, as for e2e run.',
    )
    .argument('[goal]', 'what to explore, in a sentence (default: "Explore the app and find bugs")')
    .optionsGroup('Selection:')
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <id>', 'the target to explore (default: the first configured target)')
    .option('--agent <name>', 'the configured agent to explore with (default: agents.default)')
    .option('--session <name>', 'start signed in: run the setup test that saves this session, then explore with it restored')
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
    .option('--output <dir>', 'results directory: report, artifacts, sessions (default: output in the config, else .e2e)')
    .addOption(new Option('--artifacts <dir>').hideHelp().argParser(removedArtifactsFlag))
    .option('--debug', 'print phase timings and the agent step table to stderr')
    .option('--ai-trace', 'record every model call to <output>/ai-trace.json (unbox-ai)')
    .option('--trace [mode]', 'record a trace of the exploration (bare: on), when the engine supports it; one attempt, so retry modes record none', parseRecordingMode('--trace'))
    .option('--video [mode]', 'record a video of the exploration (bare: on), when the engine supports it; one attempt, so retry modes record none', parseRecordingMode('--video'))
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e explore',
          "e2e explore 'Explore the checkout flow like a first-time buyer and report anything off'",
          'e2e explore --target web --max-steps 4 --headed',
          "e2e explore --agent ux 'Review onboarding as a first-time user'",
          "e2e explore --session admin 'Explore the admin settings and find bugs'",
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
          session?: string;
          maxSteps?: number;
          timeout?: number;
          headed?: boolean;
          reporter?: Reporter[];
          output?: string;
          debug?: boolean;
          aiTrace?: boolean;
          trace?: RecordingMode | true;
          video?: RecordingMode | true;
        },
        command: Command,
      ) =>
        runToOutcome(telemetry, command, (signals) =>
          explore({
            goal,
            configPath: options.config,
            target: options.target,
            agent: options.agent,
            session: options.session,
            maxSteps: options.maxSteps,
            timeoutMs: options.timeout,
            headed: options.headed,
            reporters: options.reporter,
            output: options.output,
            debug: options.debug,
            aiTrace: options.aiTrace,
            trace: recordingOption(options.trace),
            video: recordingOption(options.video),
            interruptSignal: signals.interruptSignal,
            forceSignal: signals.forceSignal,
            notice: (message) => process.stderr.write(`e2e explore: ${message}\n`),
          }),
        ),
    );

  const listCommand = program
    .command('list')
    .summary('print the tests a run would select, without running them')
    .description(
      'Collect and select tests exactly as run does, print one line per test and target (file › title [target] #tag), and exit. Nothing starts: no app process, no engine, no worker. The same files and selection flags (--tag, --exclude-tag, --grep, --target) narrow the selection.',
    )
    .argument('[files...]', FILES_DESCRIPTION)
    .optionsGroup('Selection:')
    .option('--config <path>', 'config file (default: the nearest e2e.config.ts)')
    .option('--target <ids>', 'target names, comma-separated or repeated (default: all targets)', parseNames('target'));
  selectionOptions(listCommand)
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
        examples([
          'e2e list',
          'e2e list tests/signup.e2e.ts',
          'e2e list --tag smoke --target web',
          'e2e list --grep checkout',
          'e2e list --shard 2/3',
          'e2e list --reporter json',
        ]),
        '',
        docsLine('/reference/cli#e2e-list'),
      ].join('\n'),
    )
    .action(
      async (
        files: string[],
        options: SelectionFlagValues & {
          config?: string;
          target?: string[];
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
            ...selectionRunOptions(options),
          }));
        } catch (cause) {
          reportFailure(telemetry, cause);
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
    .summary('inspect, measure, and clear the replay cache')
    .description(
      'Read the replay cache the runs write under .e2e/cache: what a committed cache holds, how much room it takes, and how to empty it. Reads the same config as e2e run, so cache.dir and --config decide which store is meant.',
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
    .command('feedback')
    .summary('send a bug report, docs problem, or feature request to the e2e team')
    .description(
      'Send one report about e2e itself to the e2e team. Coding agents are welcome to send one when e2e breaks, the docs mislead, or a capability is missing. The report and the anonymous machine facts telemetry carries go to PostHog as one event; secret-named environment variable values and well-known token shapes are redacted first. Sent only when asked for, so e2e telemetry disable does not stop it; E2E_TELEMETRY_DISABLED and DO_NOT_TRACK do. --dry-run prints the event and sends nothing.',
    )
    .optionsGroup('Report:')
    .addOption(new Option('--type <type>', 'what kind of report').choices(FEEDBACK_TYPES).default('other'))
    .requiredOption('-m, --message <text>', 'one or two sentences on the problem', parseText(FEEDBACK_LIMITS.message))
    .option('--task <text>', 'what you were trying to do', parseText(FEEDBACK_LIMITS.task))
    .option('--expected <text>', 'what you expected to happen', parseText(FEEDBACK_LIMITS.expected))
    .option('--actual <text>', 'what happened instead, with the error code and message', parseText(FEEDBACK_LIMITS.actual))
    .option('--approach <text>', 'what you tried, workarounds included', parseText(FEEDBACK_LIMITS.approach))
    .option('--command <text>', 'the e2e command or API involved, such as "e2e run --shard 2/3"', parseText(FEEDBACK_LIMITS.command))
    .option('--agent <text>', 'the coding agent and model sending it, such as "Claude Code / claude-opus-5-5"', parseText(FEEDBACK_LIMITS.agent))
    .optionsGroup('Output:')
    .option('--dry-run', 'print the event that would be sent and send nothing')
    .addHelpText(
      'after',
      [
        '',
        examples([
          'e2e feedback --type bug -m "list ignores --grep" --command "e2e list --grep checkout"',
          'e2e feedback --type docs -m "The mcp topic never says how to close a session"',
          'e2e feedback --type feature -m "Need a way to set the viewport per test" --dry-run',
        ]),
        '',
        docsLine('/reference/cli#e2e-feedback'),
      ].join('\n'),
    )
    .action(async (options: FeedbackReport & { dryRun?: boolean }) => {
      const { dryRun, ...report } = options;
      process.exitCode = await feedback(report, { version, telemetry, ...(dryRun === undefined ? {} : { dryRun }) });
    });

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

  // A session is named as soon as commander turns to a subcommand, before it
  // parses the flags, so a rejected flag still counts as a session of that
  // command; `preAction` names it again with the flags. Commander fires the
  // hook on the parent alone, hence one per command that has children.
  for (const parent of withSubcommands(program).filter((command) => command.commands.length > 0)) {
    parent.hook('preSubcommand', (_parent, subcommand) => telemetry.session(commandPath(subcommand)));
  }
  return program;
}

/** CLI entry invoked by the bin wrapper. */
export async function main(argv: readonly string[]): Promise<void> {
  const version = packageVersion(import.meta.url, '../../package.json', '0.0.0');
  // Working on e2e itself is not usage: the CLI run from the repository sends nothing.
  const telemetry = new Telemetry({ version, checkout: runsFromCheckout(import.meta.url) });
  const program = createProgram(version, telemetry);
  try {
    await program.parseAsync([...argv]);
  } catch (cause) {
    if (cause instanceof CommanderError) {
      // Commander has already written its diagnostic. `--help` and
      // `--version` exit 0 and are no session of the command they were asked
      // on; every usage error is a CLI error: exit 2.
      process.exitCode = cause.exitCode === 0 ? 0 : 2;
      if (cause.exitCode === 0) telemetry.discardSession();
      else telemetry.failSession(USAGE_ERROR_CODE);
    } else {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 2;
      telemetry.failSession(classifyError(cause).code);
    }
  } finally {
    telemetry.endSession(typeof process.exitCode === 'number' ? process.exitCode : 0);
    // One bounded request; the deadline, not the network, decides when the CLI is done.
    await telemetry.flush();
  }
}
