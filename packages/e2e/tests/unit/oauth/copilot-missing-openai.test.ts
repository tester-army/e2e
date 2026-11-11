import { generateText } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { json, useServers } from '../../helpers/recording-server.ts';
import { useVendor } from './helpers/vendor.ts';

vi.mock('@ai-sdk/openai', () => {
  throw new Error("Cannot find package '@ai-sdk/openai'");
});

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);

it('names the package to install when a Responses model is called without @ai-sdk/openai', async () => {
  const api = await serve((_request, response) => json(response, 200, { data: [{ id: 'gpt-6-luna', supported_endpoints: ['/responses'] }] }));
  vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
  const { copilot } = await import('../../../src/oauth/copilot.ts');
  await expect(generateText({ model: copilot('gpt-6-luna'), prompt: 'x', maxRetries: 0 })).rejects.toMatchObject({
    code: 'MISCONFIGURED',
    message: expect.stringContaining('install it beside @ai-sdk/openai-compatible'),
  });
  expect(api.requests.map((request) => request.url)).toEqual(['/models']);
});
