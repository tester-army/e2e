/** Project tools declare mutation and platform scope; the harness owns dispatch and accounting. */

import type { Tool, ToolExecutionOptions } from 'ai';
import type { StepExecutorContext } from './executor.ts';
import { TestError } from '../internal/errors.ts';
import type { Platform } from '../types.ts';

/** Cross-realm identity marker for defined tools. */
const DEFINED_TOOL_MARKER = Symbol.for('e2e.defined-tool.v1');

export interface ToolAnnotations {
  /** @deprecated Reserved metadata; project-tool mutations always end trace replay. */
  readonly replay?: 'deterministic' | 'none';
  /** Whether executing the tool can change application state. */
  readonly mutates: boolean;
  /** @deprecated Metadata only; never grants access to plaintext secrets or pixels. */
  readonly secrets?: boolean;
  /**
   * Platforms this tool is offered on; absent means every platform. A suite
   * that mixes targets of different platforms keeps a gesture tool off the
   * platforms that cannot honor it by declaring this, not by splitting
   * configs.
   */
  readonly platforms?: readonly Platform[];
}

export interface DefinedTool {
  readonly tool: Tool;
  readonly annotations: ToolAnnotations;
}

/** Attaches required semantics to an AI SDK tool. */
export function defineTool(tool: Tool, annotations: ToolAnnotations): DefinedTool {
  if (typeof tool !== 'object' || tool === null || typeof tool.execute !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'defineTool requires an AI SDK tool with an execute function');
  }
  if (annotations === undefined || typeof annotations !== 'object') {
    throw new TestError('INVALID_ARGUMENT', 'defineTool requires annotations: { mutates }');
  }
  if (annotations.replay !== undefined && annotations.replay !== 'deterministic' && annotations.replay !== 'none') {
    throw new TestError('INVALID_ARGUMENT', "annotations.replay must be 'deterministic' or 'none'");
  }
  if (typeof annotations.mutates !== 'boolean' || (annotations.secrets !== undefined && typeof annotations.secrets !== 'boolean')) {
    throw new TestError('INVALID_ARGUMENT', 'annotations.mutates and annotations.secrets must be booleans');
  }
  if (
    annotations.platforms !== undefined &&
    (!Array.isArray(annotations.platforms) ||
      annotations.platforms.length === 0 ||
      annotations.platforms.some((platform) => typeof platform !== 'string' || platform === ''))
  ) {
    throw new TestError(
      'INVALID_ARGUMENT',
      'annotations.platforms must be a non-empty array of platform names when present',
    );
  }
  const defined: DefinedTool = {
    tool,
    annotations: {
      ...(annotations.replay === undefined ? {} : { replay: annotations.replay }),
      mutates: annotations.mutates,
      ...(annotations.secrets === undefined ? {} : { secrets: annotations.secrets }),
      ...(annotations.platforms === undefined ? {} : { platforms: [...annotations.platforms] }),
    },
  };
  Object.defineProperty(defined, DEFINED_TOOL_MARKER, { value: true });
  return Object.freeze(defined);
}

/** True when a defined tool is offered on the given platform. */
export function toolAppliesTo(defined: DefinedTool, platform: Platform): boolean {
  return defined.annotations.platforms === undefined || defined.annotations.platforms.includes(platform);
}

/** True when a value came through `defineTool`, from this or another realm. */
export function isDefinedTool(value: unknown): value is DefinedTool {
  return typeof value === 'object' && value !== null && DEFINED_TOOL_MARKER in value;
}

/** Guarded observation capability supplied to read-only tools by createAgent. */
export function getToolContext(options: object): Pick<StepExecutorContext, 'observe'> {
  const context = (options as { [TOOL_CONTEXT]?: Pick<StepExecutorContext, 'observe'> })[TOOL_CONTEXT];
  if (context === undefined || typeof context.observe !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'this tool needs the observation context supplied by createAgent');
  }
  return { observe: context.observe };
}

const TOOL_CONTEXT = Symbol.for('e2e.tool-context.v1');

/** Carries harness capabilities alongside SDK options without replacing the project's SDK context. */
export function withToolContext(
  options: ToolExecutionOptions<unknown>,
  context: Pick<StepExecutorContext, 'observe'>,
): ToolExecutionOptions<unknown> {
  return Object.assign({}, options, { [TOOL_CONTEXT]: context });
}
