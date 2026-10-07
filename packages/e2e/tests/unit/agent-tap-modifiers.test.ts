/**
 * The tap family holds modifier keys: `tap`, `double_tap`, and `right_click`
 * take an optional `modifiers` argument when the target's engine declares
 * `tapModifiers`, and thread it to the engine like the test API's
 * `tap({ modifiers })` does (#953). Engines without the declaration never
 * see the field, and refuse it below when one arrives anyway.
 */

import type { ToolSet } from 'ai';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeAction } from '../../src/agent/actions.ts';
import type { StepExecutorContext } from '../../src/agent/executor.ts';
import { createGrammarTools } from '../../src/agent/primitives.ts';
import { replayTrace, type ReplayHost, type SemanticScreen } from '../../src/agent/replay.ts';
import { TraceRecorder } from '../../src/cache/recorder.ts';
import { buildTraceEntry, readTraceEntry, type ActionTrace, type RecordedAction } from '../../src/cache/trace.ts';
import type { SemanticNode } from '../../src/engine/surface.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { redacted, redactedNodes } from '../helpers/redacted.ts';

function schemaOf(tools: ToolSet, name: string): z.ZodType {
  const tool = tools[name];
  if (tool?.inputSchema === undefined) throw new Error(`no schema on ${name}`);
  return tool.inputSchema as z.ZodType;
}

/** A context whose tap-family actions record their arguments instead of refusing, so the tools' threading is observable. */
function recordingContext() {
  const fake = fakeExecutorContext();
  const seen: { readonly name: string; readonly args: readonly unknown[] }[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<never> => {
      seen.push({ name, args });
      throw new Error(`${name} sentinel`);
    };
  const context: StepExecutorContext = {
    ...fake.context,
    observe: async () => {
      throw new Error('observe sentinel');
    },
    actions: {
      ...fake.context.actions,
      tap: record('tap'),
      doubleTap: record('doubleTap'),
      secondaryTap: record('secondaryTap'),
    },
  };
  return { context, seen };
}

function execute(tools: ToolSet, name: string, input: unknown): Promise<unknown> {
  const tool = tools[name] as unknown as { execute: (input: unknown) => Promise<unknown> } | undefined;
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute(input);
}

const TAP_FAMILY = ['tap', 'double_tap', 'right_click'] as const;

describe('tap modifiers in the MCP grammar tools', () => {
  it('offers modifiers on the tap family only when the engine declares tapModifiers', () => {
    const holding = createGrammarTools(fakeExecutorContext().context, { tapModifiers: true });
    for (const name of TAP_FAMILY) {
      const schema = schemaOf(holding, name);
      expect(schema.safeParse({ target: 'n1', modifiers: ['Shift'] }).success, `${name} accepts modifiers`).toBe(true);
      expect(schema.safeParse({ target: 'n1', modifiers: ['Shift', 'ControlOrMeta'] }).success, `${name} accepts several`).toBe(true);
      expect(schema.safeParse({ target: 'n1', modifiers: ['shift'] }).success, `${name} refuses a lowercase modifier`).toBe(false);
      expect(schema.safeParse({ target: 'n1', modifiers: ['Bogus'] }).success, `${name} refuses an unknown modifier`).toBe(false);
      expect(schema.safeParse({ target: 'n1', modifiers: 'Shift' }).success, `${name} refuses a non-array`).toBe(false);
    }
    // The rest of the grammar never takes modifiers, even on a holding engine.
    for (const name of ['hover', 'long_press']) {
      expect(schemaOf(holding, name).safeParse({ target: 'n1', modifiers: ['Shift'] }).success, `${name} refuses modifiers`).toBe(false);
    }
  });

  it('keeps modifiers out of the vocabulary when the engine does not declare tapModifiers', () => {
    const plain = createGrammarTools(fakeExecutorContext().context);
    for (const name of TAP_FAMILY) {
      const schema = schemaOf(plain, name);
      expect(schema.safeParse({ target: 'n1' }).success, `${name} still takes a bare tap`).toBe(true);
      const decorated = schema.safeParse({ target: 'n1', modifiers: ['Shift'] });
      expect(decorated.success, `${name} refuses the undeclared field`).toBe(false);
      if (!decorated.success) {
        expect(decorated.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
      }
    }
  });

  it('threads modifiers through to the tap-family actions', async () => {
    const { context, seen } = recordingContext();
    const tools = createGrammarTools(context, { tapModifiers: true });
    await expect(execute(tools, 'tap', { target: 'n1', modifiers: ['Shift'] })).rejects.toThrow('observe sentinel');
    await expect(execute(tools, 'double_tap', { target: 'n2', modifiers: ['Control'] })).rejects.toThrow('observe sentinel');
    await expect(execute(tools, 'right_click', { target: 'n3' })).rejects.toThrow('observe sentinel');
    expect(seen).toEqual([
      { name: 'tap', args: [{ id: 'n1' }, { modifiers: ['Shift'] }] },
      { name: 'doubleTap', args: [{ id: 'n2' }, { modifiers: ['Control'] }] },
      { name: 'secondaryTap', args: [{ id: 'n3' }, undefined] },
    ]);
  });

  it('says what keys a tap held in its prose', () => {
    const node = redacted({ ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Save' });
    const said = describeAction({ name: 'tap', node, modifiers: ['Shift', 'Control'] }, { redact: (text) => text, redactCut: (text) => text });
    expect(said.summary).toContain('with Shift+Control held');
    const plain = describeAction({ name: 'tap', node }, { redact: (text) => text, redactCut: (text) => text });
    expect(plain.summary).not.toContain('held');
  });

  it('keeps modifiers through the trace round-trip', () => {
    const recorder = new TraceRecorder({ redact: (text) => text, redactCut: (text) => text });
    const node = redacted({ ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Save' });
    recorder.record({ name: 'tap', node, modifiers: ['Shift'] });
    recorder.record({ name: 'tap', node });
    const trace = recorder.finalize({
      executor: { name: 'test' },
      recordedFor: { testId: 't', targetId: 'web', instructionDigest: 'c'.repeat(64) },
      summary: 'done',
    });
    const entry = readTraceEntry(JSON.parse(JSON.stringify(buildTraceEntry(trace!))));
    expect(entry?.payload.actions).toHaveLength(2);
    expect(entry?.payload.actions[0]).toMatchObject({ name: 'tap', modifiers: ['Shift'] });
    expect(entry?.payload.actions[1]).not.toHaveProperty('modifiers');
  });

  it('replays a recorded tap with the keys it held', async () => {
    const save: SemanticNode = { ref: { id: 'n1', revision: 'r1' }, role: 'button', name: 'Save' };
    const shot = (): SemanticScreen => ({ kind: 'semantic', nodes: redactedNodes([save]), viewport: { width: 1280, height: 720 } });
    const tapCalls: { readonly target: unknown; readonly options: unknown }[] = [];
    const host: ReplayHost = {
      traceEligible: true,
      observe: async () => shot(),
      actions: {
        ...fakeExecutorContext().context.actions,
        tap: async (target, options) => {
          tapCalls.push({ target, options });
        },
      },
      signal: new AbortController().signal,
      remainingMs: () => 60_000,
    };
    const action: RecordedAction = {
      name: 'tap',
      summary: 'tap button "Save" with Shift held',
      target: { role: 'button', name: 'Save' },
      modifiers: ['Shift'],
    };
    const trace: ActionTrace = { actions: [action], executor: { name: 'test' }, summary: 'done' };
    const outcome = await replayTrace(host, trace, { initial: shot() });
    expect(outcome).toMatchObject({ completed: true, executed: 1 });
    expect(tapCalls).toHaveLength(1);
    expect(tapCalls[0]).toMatchObject({ options: { modifiers: ['Shift'] } });
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setTimerTickMode('nextTimerAsync');
});
afterEach(() => {
  vi.useRealTimers();
});
