import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { LoadAPIKeyError, TypeValidationError } from 'ai';
import { fieldText } from '../src/text.ts';
import { context, scriptedText } from './helpers.ts';
function input() {
  return {
    goal: 'Fill Name',
    context: null,
    params: { nickname: 'Ada' },
    field: { label: 'Name', role: 'textbox' },
    page: 'Name',
    recentActions: [],
  };
}
describe('fieldText', () => {
  it('returns the model value and records usage', async () => {
    const text = scriptedText(['Ada']);
    const fixture = context({ model: text.model });
    const value = await fieldText(fixture.ctx, text.model, input());
    expect(value).toBe('Ada');
    expect(fixture.usage).toHaveLength(1);
    expect(fixture.usage[0]).toMatchObject({ provider: 'scripted-text' });
  });
  it('names the answer key for providers without JSON-schema output', async () => {
    const text = scriptedText(['Ada']);
    await fieldText(context({ model: text.model }).ctx, text.model, input());
    expect(JSON.stringify(text.prompts[0])).toContain('exactly one key, \\"text\\"');
  });
  it('maps null and empty to no value', async () => {
    for (const queued of [null, '']) {
      const text = scriptedText([queued]);
      const fixture = context({ model: text.model });
      expect(await fieldText(fixture.ctx, text.model, input())).toBeNull();
    }
  });
  it('maps a provider failure without its text', async () => {
    const text = scriptedText(['Ada']);
    const broken: Exclude<LanguageModel, string> = { ...text.model, doGenerate: async () => { throw new Error('upstream detail'); } };
    const fixture = context({ model: broken });
    await expect(fieldText(fixture.ctx, broken, input())).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    await expect(fieldText(fixture.ctx, broken, input())).rejects.not.toMatchObject({ message: expect.stringContaining('upstream') });
    expect(fixture.usage).toHaveLength(2);
  });
  it('maps a missing key to unavailable and bad output to invalid', async () => {
    const text = scriptedText(['Ada']);
    const missing: Exclude<LanguageModel, string> = { ...text.model, doGenerate: async () => { throw new LoadAPIKeyError({ message: "OpenRouter API key is missing. Pass it using the 'apiKey' parameter or the OPENROUTER_API_KEY environment variable." }); } };
    const malformed: Exclude<LanguageModel, string> = { ...text.model, doGenerate: async () => { throw new TypeValidationError({ value: 'nope', cause: new Error('bad') }); } };
    await expect(fieldText(context({ model: missing }).ctx, missing, input())).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: 'Set OPENROUTER_API_KEY to the field-text model API key.' });
    await expect(fieldText(context({ model: malformed }).ctx, malformed, input())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' });
  });
  it('honors abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const text = scriptedText(['Ada']);
    const fixture = context({ model: text.model, signal: controller.signal });
    await expect(fieldText(fixture.ctx, text.model, input())).rejects.toThrow();
  });
});
