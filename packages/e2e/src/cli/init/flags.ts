/** The `e2e init` flags: one per wizard question. */

import { InvalidArgumentError, Option, type Command } from 'commander';
import type { InitOptions } from '../init.ts';
import { parseNames } from '../parse-names.ts';
import { SKILL_LOCATIONS } from './agent-skill.ts';
import { getEnginePresets } from './engines.ts';
import { EXAMPLES, findExample } from './examples.ts';
import { GATEWAYS, validateEndpoint } from './gateways.ts';
import { MCP_LOCATIONS } from './mcp-config.ts';

/** The values commander parses the init flags to, before {@link checkInitFlags}. */
export type InitFlagValues = Omit<InitOptions, 'directory' | 'interactive' | 'skills' | 'mcp'> & {
  skills?: string[];
  mcp?: string[];
};

const SKILL_DIRS = SKILL_LOCATIONS.map((location) => location.dir);
const MCP_FILES = MCP_LOCATIONS.map((location) => location.file);

/** Adds a flag per wizard question to the `init` command. */
export function addInitOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--example <name>', `start from an example app downloaded from GitHub: ${EXAMPLES.map((example) => example.id).join(', ')}`)
        .argParser(parseExample),
    )
    .addOption(new Option('--engine <id>', 'engine for a new config').choices(getEnginePresets().map((preset) => preset.id)))
    .addOption(
      new Option('--gateway <id>', 'model gateway for agent steps in a new config; none for deterministic tests only').choices([
        ...GATEWAYS.map((gateway) => gateway.id),
        'none',
      ]),
    )
    .addOption(
      new Option('--endpoint <url>', 'base URL of the API for --gateway openai-compatible, which it implies')
        .argParser(parseEndpoint)
        .implies({ gateway: 'openai-compatible' }),
    )
    .option('--skills <dirs>', `where to install the agent skill, comma-separated: ${SKILL_DIRS.join(', ')}, or none`, parseNames('skill directory'))
    .option('--mcp <files>', `where to register the MCP server, comma-separated: ${MCP_FILES.join(', ')}, or none`, parseNames('MCP config file'))
    .option('--install', 'install dependencies after scaffolding')
    .option('--no-install', 'do not install dependencies');
}

/**
 * The init flags as `init` takes them. A location list that names an unknown
 * location or combines `none` with others, and an `--endpoint` next to
 * another gateway, fail as usage errors before anything is written.
 */
export function checkInitFlags(options: InitFlagValues, command: Command): Omit<InitOptions, 'directory' | 'interactive'> {
  if (options.endpoint !== undefined && options.gateway !== 'openai-compatible') {
    command.error(`error: --endpoint is the base URL for --gateway openai-compatible, not --gateway ${options.gateway}`, { exitCode: 2 });
  }
  if (options.example !== undefined) {
    const conflicts = (['engine', 'gateway', 'endpoint'] as const).filter((flag) => options[flag] !== undefined);
    if (conflicts.length > 0) {
      command.error(`error: --example ${options.example} brings its own e2e.config.ts; drop ${conflicts.map((flag) => `--${flag}`).join(', ')}`, { exitCode: 2 });
    }
  }
  const { skills, mcp, ...rest } = options;
  return {
    ...rest,
    ...(skills === undefined ? {} : { skills: checkLocations(command, '--skills', 'skill directory', skills, SKILL_DIRS) }),
    ...(mcp === undefined ? {} : { mcp: checkLocations(command, '--mcp', 'MCP config file', mcp, MCP_FILES) }),
  };
}

/**
 * The locations a `--skills` or `--mcp` list names: known ones, each once, or
 * none for `none` alone. Anything else exits 2 with the valid values.
 */
function checkLocations(command: Command, flag: string, noun: string, names: readonly string[], known: readonly string[]): string[] {
  if (names.includes('none')) {
    if (names.length > 1) command.error(`error: ${flag}: none cannot be combined with other values`, { exitCode: 2 });
    return [];
  }
  const locations = names.map(trimSlashes);
  const unknown = locations.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    command.error(`error: ${flag}: unknown ${noun} "${unknown}"; expected ${[...known, 'none'].join(', ')}`, { exitCode: 2 });
  }
  return [...new Set(locations)];
}

/** A location with its trailing slashes dropped, so `.agents/skills/` is `.agents/skills`. */
function trimSlashes(name: string): string {
  return name.replace(/\/+$/u, '');
}

/** The `--example` value as its folder name; `expo` and `with-expo` both name `with-expo`. */
function parseExample(value: string): string {
  const example = findExample(value.trim());
  if (example === undefined) {
    throw new InvalidArgumentError(`unknown example "${value}"; expected ${EXAMPLES.map(({ id }) => id).join(', ')}`);
  }
  return example.id;
}

/** The `--endpoint` URL, by the rule config resolution applies; `init` trims it. */
function parseEndpoint(value: string): string {
  const problem = validateEndpoint(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}
