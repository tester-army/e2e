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
  double_tap: { target: 'n1' },
  long_press: { target: 'n1' },
  right_click: { target: 'n1' },
  hover: { target: 'n1' },
  type: { target: 'n1', value: 'ada' },
  type_secret: { target: 'n1', name: 'admin' },
  press: { target: 'n1', key: 'Shift+ArrowLeft', times: 8 },
  select: { target: 'n1', value: 'Pro' },
  check: { target: 'n1', checked: false },
  scroll: { direction: 'down', times: 2 },
  scroll_to: { target: 'n1' },
  drag: { target: 'n1', to: 'n2' },
  upload: { target: 'n1', files: ['fixtures/a.txt'] },
  navigate: { url: '/about' },
  back: {},
  screenshot: {},
  tap_at: { x: 10, y: 20 },
  hover_at: { x: 10, y: 20 },
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

  it('scroll_to takes a listed node, a text to reach, or a text with the list to page, never nothing; a device gets the text form alone', () => {
    const full = schemaOf(createGrammarTools(fakeExecutorContext().context), 'scroll_to');
    expect(full.safeParse({ text: 'Row 4322', direction: 'down', target: 'n6' }).success).toBe(true);
    expect(full.safeParse({ text: 'Row 4322' }).success).toBe(true);
    expect(full.safeParse({ text: 'x'.repeat(201) }).success).toBe(false);
    expect(full.safeParse({ text: 'Row 4322', list: 'n6' }).success).toBe(false);
    expectClosed(full, { text: 'Row 4322' }, 'scroll_to');

    const device = createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'scroll', 'scrollUntil'] }).context);
    const byText = schemaOf(device, 'scroll_to');
    expect(byText.safeParse({ text: 'Row 0512' }).success).toBe(true);
    expect(byText.safeParse({ text: 'Row 0512', target: 'n3' }).success).toBe(true);
    expect(byText.safeParse({ target: 'n1' }).success).toBe(false);
    expectClosed(byText, { text: 'Row 0512', direction: 'down' }, 'scroll_to');

    const byNode = schemaOf(createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'scrollTo'] }).context), 'scroll_to');
    expect(byNode.safeParse({ text: 'Row 0512' }).success).toBe(false);
    expectClosed(byNode, { target: 'n1' }, 'scroll_to');
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

  it('accepts a passed verdict beside an error code: the body records the pass without the code and says what it dropped', async () => {
    // One model attaches ACTION_FAILED to about half of its passes; a schema refusal had it resend the identical call until the turn budget ran out.
    const passed = createVerdictTool();
    const schema = schemaOf({ complete_step: passed.tool }, 'complete_step');
    const contradictory = { status: 'passed', summary: 'done', errorCode: 'ACTION_FAILED' };
    expect(schema.safeParse(contradictory).success).toBe(true);
    const options = { toolCallId: 'verdict', messages: [], context: undefined };
    expect(await passed.tool.execute!(contradictory, options)).toBe('Step concluded; dropped errorCode ACTION_FAILED on a passed verdict.');
    expect(passed.verdict()).toEqual({ status: 'passed', summary: 'done' });
    const failed = createVerdictTool();
    expect(await failed.tool.execute!({ status: 'failed', summary: 'done', errorCode: 'ACTION_FAILED' }, options)).toBe('Step concluded.');
    expect(failed.verdict()).toEqual({ status: 'failed', summary: 'done', errorCode: 'ACTION_FAILED' });
    expect(schema.safeParse({ status: 'blocked', summary: 'done', errorCode: 'ENVIRONMENT_UNAVAILABLE' }).success).toBe(true);
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

  it('sends complete_step as the plain object: the errorCode rule is its description, never a keyword or a refinement', () => {
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
