/**
 * The testbed ships no agent either: the runner is the open standard and the
 * brain that runs `agent.act()` steps is supplied from outside, named by
 * `E2E_AGENT_MODULE` — a module path whose default export (or `createAgent`)
 * builds a StepExecutor from `{ model?, tools?, system?, providerOptions? }`.
 * Judgment-only suites need no module; an agentic suite without one fails at
 * config load with this message rather than at the first act step.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StepExecutor } from 'e2e';
import type { DefinedTool } from 'e2e/agent';
import type { LanguageModel } from 'ai';

export interface AgentModuleOptions {
  readonly model?: Exclude<LanguageModel, string>;
  readonly system?: string;
  readonly tools?: Readonly<Record<string, DefinedTool>>;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

type Factory = (options?: AgentModuleOptions) => StepExecutor;

/** Loads the executor factory named by `E2E_AGENT_MODULE` and builds one executor. */
export async function loadAgent(options: AgentModuleOptions = {}): Promise<StepExecutor> {
  const specifier = process.env['E2E_AGENT_MODULE'];
  if (specifier === undefined || specifier === '') {
    throw new Error(
      'this suite runs agent.act() steps and needs a step executor: set E2E_AGENT_MODULE to a module ' +
        'whose default export (or createAgent) builds one, e.g. the private TesterArmy agent package',
    );
  }
  // A path is taken relative to the working directory, not to this file.
  const resolved = specifier.startsWith('.') || specifier.startsWith('/')
    ? pathToFileURL(path.resolve(specifier)).href
    : specifier;
  const loaded = (await import(resolved)) as { default?: Factory; createAgent?: Factory };
  const factory = loaded.createAgent ?? loaded.default;
  if (typeof factory !== 'function') {
    throw new Error(`E2E_AGENT_MODULE ${specifier} exports neither createAgent nor a default factory`);
  }
  return factory(options);
}
