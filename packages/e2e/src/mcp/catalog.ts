/**
 * The catalog of a live session: every tool `call` can run, as AI SDK tools.
 * `observe` shows the whole screen, the grammar is what the target's engine
 * honors, `screenshot` and the point tools (`tap_at`, `type_at`, `press_at`,
 * `select_at`) among it, answering `PIXEL_TAINTED` once a secret has been
 * filled, `locate` tries a semantic locator the way a test would, and the
 * project's own tools follow. Built-in
 * names win: a project tool named like one is neither listed nor reachable,
 * the precedence the testing agent's toolset applies.
 */

import type { ToolSet } from 'ai';
import { z } from 'zod';
import { isDefaultAgent, projectTools } from '../agent/default-agent.ts';
import type { ExecutorNode, StepExecutor, StepExecutorContext } from '../agent/executor.ts';
import { projectTree } from '../agent/observation.ts';
import { createGrammarTools, GRAMMAR_TOOL_NAMES } from '../agent/primitives.ts';
import type { ScreenPresenter } from '../agent/screen-update.ts';
import type { LocatorExpression, SemanticNode, TargetSession } from '../engine/surface.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { describeExpression, roleQuery, testIdQuery, textQuery } from '../locator/expression.ts';
import type { LocatorEngine } from '../locator/engine.ts';
import type { Role } from '../types.ts';

/** How many matching nodes `locate` describes. */
const MAX_LOCATE_NODES = 10;
/** True for a grammar tool name, whether or not this session's engine declares the verb: a missing one is not a typo. */
export function isGrammarVerb(name: string): boolean {
  return GRAMMAR_TOOL_NAMES.has(name);
}

export interface SessionCatalog {
  /** Every tool `call` can run, in the order `tools` lists them. */
  readonly tools: ToolSet;
  /** The tools that change nothing on the app. */
  readonly readOnly: ReadonlySet<string>;
}

export interface CatalogOptions {
  readonly context: StepExecutorContext;
  readonly screen: ScreenPresenter;
  readonly locator: LocatorEngine;
  readonly session: TargetSession;
  /** The configured executor, whose project tools are served when it came from `createAgent`. */
  readonly executor: StepExecutor | undefined;
  /** The attempt's secret ledger: what `locate` shows of a node passes through it, as `observe` does. */
  readonly redact: (text: string) => string;
  readonly warn: (message: string) => void;
}

/** Builds the session's catalog from the step context and the target. */
export function createSessionCatalog(options: CatalogOptions): SessionCatalog {
  const { context, screen } = options;
  // The grammar's own observe reports a diff for the model loop; the
  // session's shows the whole screen, so it replaces the grammar's.
  const { observe: _diffObserve, ...verbs } = createGrammarTools(context, { screen });
  const builtIn: ToolSet = {
    observe: fullObserveTool(context, screen),
    ...verbs,
    locate: locateTool(options.locator, options.session, options.redact),
  };
  const defined = isDefaultAgent(options.executor) ? options.executor.tools : {};
  const readOnly = new Set(['observe', 'locate', 'screenshot']);
  const project: ToolSet = {};
  for (const [name, tool] of Object.entries(projectTools(context, defined))) {
    if (name in builtIn) {
      options.warn(`project tool "${name}" is not served over MCP: the name belongs to a built-in session tool`);
      continue;
    }
    project[name] = tool;
    if (defined[name]?.annotations.mutates === false) readOnly.add(name);
  }
  return { tools: { ...builtIn, ...project }, readOnly };
}

/**
 * The session's `observe`: the whole screen, every time. Action results
 * report what changed since the screen the agent last received, as they do
 * for the testing agent; a coding agent that asks to look wants everything,
 * and the presenter takes that screen as the new baseline for later changes.
 */
function fullObserveTool(context: StepExecutorContext, screen: ScreenPresenter): ToolSet[string] {
  return {
    description:
      'Look at the whole current screen: every node with its id, role, name, and state. Action results report only what changed since the screen you last received; call this to see everything again or after waiting for something in progress.',
    inputSchema: z.object({}),
    execute: async () => screen.initial(await context.observe()),
  };
}

/** The session's `locate`: a semantic locator tried against the live screen, with the verdict a test would get. */
function locateTool(locator: LocatorEngine, session: TargetSession, redact: (text: string) => string): ToolSet[string] {
  return {
    description:
      'Try a semantic locator against the live screen before writing it into a test: screen.getByRole(role, { name }), getByText, getByLabel, getByPlaceholder, or getByTestId. Returns how many nodes match and which, plus the test code to use. Exactly one of role, text, label, placeholder, or testId; name narrows a role query. Matching is exact unless exact is false.',
    inputSchema: z.object({
      role: z.string().min(1).optional().describe('ARIA role, e.g. "button", "textbox", "link"'),
      name: z.string().min(1).optional().describe('Accessible name, with role'),
      text: z.string().min(1).optional(),
      label: z.string().min(1).optional(),
      placeholder: z.string().min(1).optional(),
      testId: z.string().min(1).optional(),
      exact: z.boolean().optional().describe('false for substring, case-insensitive matching'),
    }),
    execute: async (args: LocateArgs) => {
      const query = locateQuery(args);
      const refs = await locator.resolveNow(query.expression);
      const read: SemanticNode[] = [];
      for (const ref of refs.slice(0, MAX_LOCATE_NODES)) {
        read.push(await session.read(ref, locator.operation()));
      }
      return describeLocate(query, refs.length, read, redact);
    },
  };
}

export interface LocateArgs {
  readonly role?: string | undefined;
  readonly name?: string | undefined;
  readonly text?: string | undefined;
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly testId?: string | undefined;
  readonly exact?: boolean | undefined;
}

export interface LocateQuery {
  readonly expression: LocatorExpression;
  readonly code: string;
}

/** Builds the expression and the matching `screen.*` call from the tool arguments. */
export function locateQuery(args: LocateArgs): LocateQuery {
  const exact = args.exact !== false;
  const exactOption = exact ? '' : ', exact: false';
  const { role, name, text, label, placeholder, testId } = args;
  const given = [role, text, label, placeholder, testId].filter((value) => value !== undefined).length;
  if (given !== 1) {
    throw new ConfigurationError('INVALID_ARGUMENT', 'locate needs exactly one of role, text, label, placeholder, or testId');
  }
  if (role !== undefined) {
    const options = name === undefined ? '' : `, { name: ${JSON.stringify(name)}${exactOption} }`;
    return {
      expression: roleQuery(role as Role, name === undefined ? undefined : { name, exact }, undefined),
      code: `screen.getByRole(${JSON.stringify(role)}${options})`,
    };
  }
  if (name !== undefined) throw new ConfigurationError('INVALID_ARGUMENT', 'name only narrows a role query');
  if (testId !== undefined) return { expression: testIdQuery(testId, undefined, undefined), code: `screen.getByTestId(${JSON.stringify(testId)})` };
  const options = exact ? '' : `, { exact: false }`;
  if (text !== undefined) return { expression: textQuery('text', text, { exact }, undefined), code: `screen.getByText(${JSON.stringify(text)}${options})` };
  if (label !== undefined) return { expression: textQuery('label', label, { exact }, undefined), code: `screen.getByLabel(${JSON.stringify(label)}${options})` };
  return { expression: textQuery('placeholder', placeholder!, { exact }, undefined), code: `screen.getByPlaceholder(${JSON.stringify(placeholder)}${options})` };
}

/** Renders a locate result: the count, the verdict a test would get, and the nodes, each through the attempt's redactor. */
export function describeLocate(query: LocateQuery, count: number, nodes: readonly SemanticNode[], redact: (text: string) => string): string {
  const lines = [`${count === 1 ? '1 node matches' : `${count} nodes match`} ${describeExpression(query.expression)}.`];
  if (count === 1) lines.push(`Use: ${query.code}`);
  else if (count === 0) lines.push('A test using this locator would fail with LOCATOR_NOT_FOUND. Check the accessible name in the observation (observe), or loosen the match with exact: false.');
  else lines.push(`A test action on ${query.code} would fail with LOCATOR_AMBIGUOUS. Narrow it with { name }, .filter({ hasText }), .first(), or .nth(i), or scope it under a container.`);
  for (const node of nodes) lines.push(`- ${describeNode(projectTree(node, redact))}`);
  if (count > nodes.length) lines.push(`- and ${count - nodes.length} more`);
  return lines.join('\n');
}

/**
 * A located node by what names it, from the projection `observe` hands an
 * executor: name, text, and value have passed the secret ledger and a secure
 * node carries no value. Located refs are not observation ids, so none is shown.
 */
function describeNode(node: ExecutorNode): string {
  const parts = [node.role ?? 'node'];
  if (node.name !== undefined && node.name !== '') parts.push(JSON.stringify(node.name));
  if (node.text !== undefined && node.text !== '' && node.text !== node.name) parts.push(`text ${JSON.stringify(node.text)}`);
  if (node.value !== undefined) parts.push(`value ${JSON.stringify(node.value)}`);
  const states = Object.entries(node.states ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);
  if (states.length > 0) parts.push(`[${states.join(', ')}]`);
  return parts.join(' ');
}
