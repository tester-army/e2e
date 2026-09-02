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

/**
 * How a tool participates in the trace cache (RFC0003). The tiers a host
 * declares here mirror the grammar's own replay contract.
 *
 * - `deterministic` — same input, same effect; replays with no model call and
 *   no relocation.
 * - `located` — replays with no model call, but the named `locate` input paths
 *   are node references from the observation the agent acted on; each is
 *   relocated against a fresh observation before the tool re-fires, exactly as
 *   a grammar verb's target is.
 * - `fixed-model` — replays with one fresh model call bounded to this tool
 *   (not the agent loop); requires `mutates: false`, since a mutating call
 *   cannot be safely re-issued.
 * - `none` — never replayed; always re-executed by a live executor.
 *
 * Located and fixed-model replay wiring lands in later RFC0003 phases; until
 * then a tool declared with either tier runs live like `none`, but the
 * declaration is validated and recorded now so hosts can express it.
 */
export type ToolReplay =
  | { readonly mode: 'deterministic' }
  | { readonly mode: 'located'; readonly locate: readonly string[] }
  | { readonly mode: 'fixed-model' }
  | { readonly mode: 'none' };

export interface ToolAnnotations {
  /**
   * The replay tier. A bare `'deterministic'`/`'none'` string is accepted as
   * sugar for `{ mode }`; the located and fixed-model tiers use the object.
   */
  readonly replay: ToolReplay | 'deterministic' | 'none';
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

/** Annotations as stored on a defined tool: the replay tier normalized to its object form. */
export interface NormalizedToolAnnotations {
  readonly replay: ToolReplay;
  readonly mutates: boolean;
  readonly secrets: boolean;
  readonly platforms?: readonly Platform[];
}

export interface DefinedTool {
  readonly tool: Tool;
  readonly annotations: NormalizedToolAnnotations;
}

/** Attaches required semantics to an AI SDK tool. */
export function defineTool(tool: Tool, annotations: ToolAnnotations): DefinedTool {
  if (typeof tool !== 'object' || tool === null || typeof tool.execute !== 'function') {
    throw new TestError('INVALID_ARGUMENT', 'defineTool requires an AI SDK tool with an execute function');
  }
  if (annotations === undefined || typeof annotations !== 'object') {
    throw new TestError('INVALID_ARGUMENT', 'defineTool requires annotations: { replay, mutates, secrets }');
  }
  if (typeof annotations.mutates !== 'boolean' || typeof annotations.secrets !== 'boolean') {
    throw new TestError('INVALID_ARGUMENT', 'annotations.mutates and annotations.secrets must be booleans');
  }
  const replay = normalizeReplay(annotations.replay, annotations.mutates);
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
      replay,
      mutates: annotations.mutates,
      secrets: annotations.secrets,
      ...(annotations.platforms === undefined ? {} : { platforms: [...annotations.platforms] }),
    },
  };
  Object.defineProperty(defined, DEFINED_TOOL_MARKER, { value: true });
  return Object.freeze(defined);
}

/**
 * Normalizes and validates the replay annotation. Accepts the `'deterministic'`
 * / `'none'` string sugar and the tiered object form; rejects a `located` tier
 * without concrete input paths and a `fixed-model` tier on a mutating tool.
 * (RFC0003 phase 1: shape validation. Checking `locate` paths against the
 * input schema lands with recording in phase 2.)
 */
function normalizeReplay(replay: ToolAnnotations['replay'], mutates: boolean): ToolReplay {
  if (replay === 'deterministic') return { mode: 'deterministic' };
  if (replay === 'none') return { mode: 'none' };
  if (typeof replay !== 'object' || replay === null) {
    throw new TestError(
      'INVALID_ARGUMENT',
      "annotations.replay must be 'deterministic', 'none', or a { mode } tier object",
    );
  }
  switch (replay.mode) {
    case 'deterministic':
    case 'none':
      return { mode: replay.mode };
    case 'located': {
      const locate = (replay as { locate?: unknown }).locate;
      if (
        !Array.isArray(locate) ||
        locate.length === 0 ||
        locate.some((path) => typeof path !== 'string' || path.trim() === '')
      ) {
        throw new TestError(
          'INVALID_ARGUMENT',
          "the 'located' replay tier requires a non-empty locate: string[] of input paths",
        );
      }
      if (new Set(locate).size !== locate.length) {
        throw new TestError('INVALID_ARGUMENT', 'annotations.replay.locate paths must be unique');
      }
      return { mode: 'located', locate: [...(locate as string[])] };
    }
    case 'fixed-model':
      if (mutates) {
        throw new TestError(
          'INVALID_ARGUMENT',
          "the 'fixed-model' replay tier requires mutates: false; a mutating call cannot be re-issued on replay",
        );
      }
      return { mode: 'fixed-model' };
    default:
      throw new TestError(
        'INVALID_ARGUMENT',
        `unknown replay tier "${String((replay as { mode?: unknown }).mode)}"`,
      );
  }
}

/** True when a defined tool is offered on the given platform. */
export function toolAppliesTo(defined: DefinedTool, platform: Platform): boolean {
  return defined.annotations.platforms === undefined || defined.annotations.platforms.includes(platform);
}

/** True when a value came through `defineTool`, from this or another realm. */
export function isDefinedTool(value: unknown): value is DefinedTool {
  return typeof value === 'object' && value !== null && DEFINED_TOOL_MARKER in value;
}
