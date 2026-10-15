import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstAvailable } from '../../src/index.ts';
import { resolveAgentConfig } from '../../src/config/agent.ts';

const PRIMARY = 'E2E_SELECTION_PRIMARY_KEY';
const SECONDARY = 'E2E_SELECTION_SECONDARY_KEY';

function model(modelId = 'primary', provider = 'fixture') {
  return Object.freeze({
    specificationVersion: 'v4',
    provider,
    modelId,
    doGenerate: vi.fn(() => Promise.reject(new Error('Unexpected model call.'))),
  });
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('firstAvailable', () => {
  it('selects the first available model without calling it or changing its identity', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    vi.stubEnv(SECONDARY, 'secondary-value');
    const primary = model();
    const secondary = model('secondary');
    const selected = firstAvailable([
      { env: PRIMARY, model: primary },
      { env: SECONDARY, model: secondary },
    ]);
    expect(selected).toBe(primary);
    expect(primary.doGenerate).not.toHaveBeenCalled();
    expect(secondary.doGenerate).not.toHaveBeenCalled();
    vi.stubEnv(PRIMARY, undefined);
    expect(selected).toBe(primary);
    expect(resolveAgentConfig({ model: selected }).model).toMatchObject({
      provider: 'fixture', id: 'primary', cacheByModel: true,
    });
  });

  it.each([undefined, '', ' \t\n '])('skips an unavailable credential: %j', (credential) => {
    vi.stubEnv(PRIMARY, credential);
    vi.stubEnv(SECONDARY, 'secondary-value');
    const secondary = model('secondary');
    expect(firstAvailable([
      { env: PRIMARY, model: model() },
      { env: SECONDARY, model: secondary },
    ])).toBe(secondary);
  });

  it('raises MODEL_UNAVAILABLE with every checked variable name', () => {
    vi.stubEnv(PRIMARY, undefined);
    vi.stubEnv(SECONDARY, '');
    expect(() => firstAvailable([
      { env: PRIMARY, model: model() },
      { env: SECONDARY, model: model('secondary') },
    ])).toThrow(expect.objectContaining({
      code: 'MODEL_UNAVAILABLE',
      category: 'configuration',
      message: expect.stringContaining(`${PRIMARY}, ${SECONDARY}`),
    }));
    expect(() => firstAvailable([])).toThrow(expect.objectContaining({ code: 'MODEL_UNAVAILABLE' }));
  });

  it.each([
    null,
    [{ env: '', model: model() }],
    [{ env: 1, model: model() }],
    [{ env: PRIMARY, model: 'fixture/model' }],
    [null],
  ])('rejects invalid input without serializing it', (candidates) => {
    vi.stubEnv(PRIMARY, 'private-credential');
    expect(() => firstAvailable(candidates as never)).toThrow(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: expect.not.stringContaining('private-credential'),
    }));
  });

  it.each([' MY_KEY', 'MY_KEY ', 'MY KEY', 'sk-live-credential-value', 'a.b.c'])(
    'rejects the env name %j, so a credential passed by mistake never reaches an error message',
    (name) => {
      vi.stubEnv(name, 'present');
      expect(() => firstAvailable([{ env: name, model: model() }])).toThrow(expect.objectContaining({
        code: 'INVALID_CONFIG',
        message: expect.not.stringContaining(name),
      }));
    },
  );

  it('selects the first of duplicate names and ignores extra entry keys', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const first = model();
    expect(firstAvailable([
      { env: PRIMARY, model: first },
      { env: PRIMARY, model: model('second') },
    ])).toBe(first);
    expect(firstAvailable([{ env: PRIMARY, model: first, label: 'extra' } as never])).toBe(first);
  });

  it('preserves model-specific replay across copies of e2e', async () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const selected = firstAvailable([{ env: PRIMARY, model: model() }]);
    vi.resetModules();
    const other = await import('../../src/config/agent.ts');
    expect(other.firstAvailable).not.toBe(firstAvailable);
    expect(other.resolveAgentConfig({ model: selected }).model?.cacheByModel).toBe(true);
    const selectedByOther = other.firstAvailable([{ env: PRIMARY, model: model('secondary') }]);
    expect(resolveAgentConfig({ model: selectedByOther }).model?.cacheByModel).toBe(true);
  });

  it('keeps ordinary model configurations independent of the model for replay', () => {
    expect(resolveAgentConfig({ model: model() }).model?.cacheByModel).toBeUndefined();
  });

  it('retains model-specific replay when an executor supplies the matching model', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const selected = firstAvailable([{ env: PRIMARY, model: model() }]);
    const executorModel = model();
    const config = resolveAgentConfig({
      model: selected,
      executor: { name: 'fixture', model: executorModel, runStep: async () => ({ status: 'passed', summary: 'Done.' }) },
    });
    expect(config.model?.model).toBe(executorModel);
    expect(config.model?.cacheByModel).toBe(true);
  });

  it('marks the executor own model when it is the selected instance', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const selected = firstAvailable([{ env: PRIMARY, model: model() }]);
    const config = resolveAgentConfig({
      executor: { name: 'fixture', model: selected, runStep: async () => ({ status: 'passed', summary: 'Done.' }) },
    });
    expect(config.model?.model).toBe(selected);
    expect(config.model?.cacheByModel).toBe(true);
  });

  it('pins a selected judge as model-specific without touching the acting model key', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const judge = firstAvailable([{ env: PRIMARY, model: model('judge') }]);
    const config = resolveAgentConfig({ model: model(), judge });
    expect(config.judge?.cacheByModel).toBe(true);
    expect(config.model?.cacheByModel).toBeUndefined();
  });

  it('marks one selected instance shared by two agents', () => {
    vi.stubEnv(PRIMARY, 'primary-value');
    const selected = firstAvailable([{ env: PRIMARY, model: model() }]);
    expect(resolveAgentConfig({ model: selected }).model?.cacheByModel).toBe(true);
    expect(resolveAgentConfig({ model: selected }, 'agents.other').model?.cacheByModel).toBe(true);
  });
});
