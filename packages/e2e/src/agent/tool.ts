/**
 * `defineTool` (RFC0001, layer 2): an AI SDK tool plus the required semantic
 * annotation. The annotation is what lets the harness treat a project tool as
 * a first-class capability — replay eligibility, mutation tracking, and secret
 * gating are declared, never inferred. A tool without declared semantics is
 * excluded from caching and untrusted by default, which in v0 (no cache)
 * reduces to: the annotation is required and recorded.
 */

import type { Tool } from 'ai';
import { TestError } from '../internal/errors.ts';
import type { Platform } from '../types.ts';

/** Cross-realm identity marker for defined tools. */
const DEFINED_TOOL_MARKER = Symbol.for('e2e.defined-tool.v1');

export interface ToolAnnotations {
  /**
   * `'deterministic'` — same input, same effect; a future cache may replay it.
   * `'none'` — never replayed; always re-executed by a live executor.
   */
  readonly replay: 'deterministic' | 'none';
  /** Whether executing the tool can change application state. */
  readonly mutates: boolean;
  /** Whether the tool handles secret material. */
  readonly secrets: boolean;
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
    throw new TestError('INVALID_ARGUMENT', 'defineTool requires annotations: { replay, mutates, secrets }');
  }
  if (annotations.replay !== 'deterministic' && annotations.replay !== 'none') {
    throw new TestError('INVALID_ARGUMENT', "annotations.replay must be 'deterministic' or 'none'");
  }
  if (typeof annotations.mutates !== 'boolean' || typeof annotations.secrets !== 'boolean') {
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
      replay: annotations.replay,
      mutates: annotations.mutates,
      secrets: annotations.secrets,
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
