/**
 * Live check of a stored login: one forced tool call over a small red image,
 * the shape the e2e act loop sends. Run by hand after `e2e login <provider>`:
 *   npx tsx tests/live/check.ts copilot claude-sonnet-5
 *   npx tsx tests/live/check.ts chatgpt gpt-5.5
 *   npx tsx tests/live/check.ts grok grok-4
 */
import { generateText, tool } from 'ai';
import { z } from 'zod';
import type { LanguageModelV4 } from '@ai-sdk/provider';

const [kind = 'copilot', modelId] = process.argv.slice(2);
const constructors: Record<string, (id: string) => Promise<LanguageModelV4>> = {
  copilot: async (id) => (await import('../../src/copilot.ts')).copilot(id),
  chatgpt: async (id) => (await import('../../src/chatgpt.ts')).chatgpt(id),
  grok: async (id) => (await import('../../src/grok.ts')).grok(id),
};
const defaults: Record<string, string> = { copilot: 'claude-sonnet-5', chatgpt: 'gpt-5.5', grok: 'grok-4' };
const construct = constructors[kind];
if (construct === undefined) throw new Error(`unknown kind ${kind}; one of ${Object.keys(constructors).join(', ')}`);
const model = await construct(modelId ?? defaults[kind]!);

// An 8x8 red PNG.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4ISeHFTEMLQkAkL9BAbKfPiIAAAAASUVORK5CYII=',
  'base64',
);
const started = Date.now();
const result = await generateText({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this square? Report it with the tool.' }, { type: 'file', data: png, mediaType: 'image/png' }] }],
  tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
  toolChoice: { type: 'tool', toolName: 'report' },
});
console.log(JSON.stringify({ provider: model.provider, model: model.modelId, ms: Date.now() - started, toolCalls: result.toolCalls.map((c) => ({ name: c.toolName, input: c.input })), usage: result.usage }, null, 2));
