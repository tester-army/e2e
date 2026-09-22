/**
 * The vocabulary the model calls is closed: a field a tool's schema does not
 * declare fails validation instead of being stripped, so a call the model
 * decorated with `force` or `selector` is refused rather than run without it.
 */

import type { ToolSet } from 'ai';
import { z } from 'zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { aiSdk, loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { createGrammarTools, createVerdictTool, GRAMMAR_TOOL_NAMES } from '../../src/agent/primitives.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';

/** An input each tool accepts; a tool added to the grammar without one fails the vocabulary check. */
const ACCEPTED: Readonly<Record<string, Record<string, unknown>>> = {
  observe: {},
  tap: { target: 'n1' },
  type: { target: 'n1', value: 'ada' },
  type_secret: { target: 'n1', name: 'admin' },
  press: { target: 'n1', key: 'Enter' },
  select: { target: 'n1', value: 'Pro' },
  scroll: { direction: 'down', times: 2 },
  navigate: { url: '/about' },
  screenshot: {},
  tap_at: { x: 10, y: 20 },
  type_at: { x: 10, y: 20, value: 'ada', replace: true },
  press_at: { x: 10, y: 20, key: 'Enter' },
  select_at: { x: 10, y: 20, value: 'Pro' },
  dismiss_keyboard: {},
};

function schemaOf(tools: ToolSet, name: string): z.ZodType {
  const tool = tools[name];
  if (tool?.inputSchema === undefined) throw new Error(`no schema on ${name}`);
  return tool.inputSchema as z.ZodType;
}

/** The accepted input passes; the same input with two undeclared fields fails on exactly those keys. */
function expectClosed(schema: z.ZodType, accepted: Record<string, unknown>, name: string): void {
  expect(schema.safeParse(accepted).success, `${name} accepts ${JSON.stringify(accepted)}`).toBe(true);
  const decorated = schema.safeParse({ ...accepted, force: true, selector: '#x' });
  expect(decorated.success, `${name} refuses undeclared fields`).toBe(false);
  if (decorated.success) return;
  expect(decorated.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  expect(decorated.error.issues[0]!.message).toBe('Unrecognized keys: "force", "selector"');
}

describe('the grammar tools have closed schemas', () => {
  it('offers the whole vocabulary over the full grammar, and every tool refuses a field it does not declare', () => {
    const tools = createGrammarTools(fakeExecutorContext().context);
    expect(Object.keys(tools).toSorted()).toEqual([...GRAMMAR_TOOL_NAMES].toSorted());
    for (const name of Object.keys(tools)) {
      expectClosed(schemaOf(tools, name), ACCEPTED[name]!, name);
    }
  });

  it('closes the keyboard-only shapes too: type and press without a target, scroll without one', () => {
    const tools = createGrammarTools(fakeExecutorContext({ verbs: ['typeText', 'pressKey', 'scroll'] }).context);
    expect(Object.keys(tools).toSorted()).toEqual(['observe', 'press', 'press_at', 'screenshot', 'scroll', 'type', 'type_at']);
    expectClosed(schemaOf(tools, 'type'), { value: 'ada', replace: true }, 'type');
    expectClosed(schemaOf(tools, 'press'), { key: 'Enter' }, 'press');
    expectClosed(schemaOf(tools, 'scroll'), { direction: 'down' }, 'scroll');
    // Without the id-addressed verb a target is not a field of type at all.
    expect(schemaOf(tools, 'type').safeParse({ target: 'n1', value: 'ada' }).success).toBe(false);
  });

  it('closes complete_step', () => {
    expectClosed(schemaOf({ complete_step: createVerdictTool().tool }, 'complete_step'), { status: 'passed', summary: 'done' }, 'complete_step');
  });

  it('refuses a passed verdict that carries an error code, and names the rule', () => {
    const schema = schemaOf({ complete_step: createVerdictTool().tool }, 'complete_step');
    const contradictory = schema.safeParse({ status: 'passed', summary: 'done', errorCode: 'ACTION_FAILED' });
    expect(contradictory.success).toBe(false);
    if (contradictory.success) return;
    expect(contradictory.error.issues.map((issue) => issue.message)).toEqual(['errorCode is only valid with status failed or blocked']);
    expect(contradictory.error.issues[0]!.path).toEqual(['errorCode']);
    expect(schema.safeParse({ status: 'failed', summary: 'done', errorCode: 'ACTION_FAILED' }).success).toBe(true);
    expect(schema.safeParse({ status: 'blocked', summary: 'done', errorCode: 'ENVIRONMENT_UNAVAILABLE' }).success).toBe(true);
    expect(schema.safeParse({ status: 'passed', summary: 'done' }).success).toBe(true);
  });
});

describe('the schema a provider receives', () => {
  beforeAll(() => loadAiSdk());

  /** The JSON Schema the SDK sends for a tool: the conversion generateText runs on `inputSchema`. */
  const sent = (schema: z.ZodType) => aiSdk().asSchema(schema).jsonSchema as { additionalProperties?: unknown };
  /** What zod alone emits in the mode the SDK converts with, before the SDK's own pass over the result. */
  const emitted = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as { additionalProperties?: unknown };

  it('carries additionalProperties: false for every grammar tool and complete_step, from the schema itself', () => {
    const tools = { ...createGrammarTools(fakeExecutorContext().context), complete_step: createVerdictTool().tool };
    for (const [name, tool] of Object.entries(tools)) {
      const schema = tool.inputSchema as z.ZodType;
      expect(sent(schema).additionalProperties, `${name} as sent`).toBe(false);
      // The closed schema emits it on its own, so the wire shape does not rest on the SDK's pass.
      expect(emitted(schema).additionalProperties, `${name} from zod`).toBe(false);
    }
  });

  it('sends complete_step as the object alone: the refinement on errorCode adds no keyword', () => {
    const schema = createVerdictTool().tool.inputSchema as z.ZodType;
    expect(Object.keys(sent(schema)).toSorted()).toEqual(['$schema', 'additionalProperties', 'properties', 'required', 'type']);
    expect(Object.keys(emitted(schema)).toSorted()).toEqual(['$schema', 'additionalProperties', 'properties', 'required', 'type']);
  });

  it('is the SDK that closes a plain object: zod in input mode declares nothing about extra keys', () => {
    const plain = z.object({ target: z.string() });
    expect(emitted(plain).additionalProperties).toBeUndefined();
    expect(sent(plain).additionalProperties).toBe(false);
  });
});
