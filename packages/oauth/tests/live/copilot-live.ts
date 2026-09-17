/**
 * Live check of the Copilot path with the GitHub CLI's token: a forced tool
 * call over a screenshot, the shape the e2e act loop sends. Run by hand:
 *   node tests/live/copilot-live.ts
 */
import { execFileSync } from 'node:child_process';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { MemoryCredentialStore } from '../../src/index.ts';
import { copilot } from '../../src/copilot.ts';

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const store = new MemoryCredentialStore({ 'github-copilot': { access: token, refresh: '', expires: 0 } });
const png = Buffer.from(process.argv[2] ?? '', 'base64');
const model = copilot(process.env['MODEL'] ?? 'gpt-4.1', { store });
const started = Date.now();
const result = await generateText({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'What color is this square? Report it with the tool.' }, { type: 'file', data: png, mediaType: 'image/png' }] }],
  tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
  toolChoice: { type: 'tool', toolName: 'report' },
});
console.log(JSON.stringify({ model: model.modelId, ms: Date.now() - started, toolCalls: result.toolCalls.map((c) => ({ name: c.toolName, input: c.input })), usage: result.usage, finish: result.finishReason }));
