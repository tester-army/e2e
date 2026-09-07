import { describe, expect, it } from 'vitest';
import { defineEngine } from '../../src/engine/index.ts';
import { createProject, runExisting } from '../helpers/run-project.ts';

const SENTINEL = 'synthetic-serial-secret-2718';

const suite = `import { test, credentials } from '@e2edev/e2e';
test.describe('shared', { serial: true, retries: 1 }, () => {
  test('fill', async ({ screen, agent }) => {
    await agent.act('before fill');
    await screen.getByRole('textbox').fill(credentials.user('audit').password);
    await agent.act('after fill');
  });
  test('inspect', async ({ agent }) => { await agent.act('next member'); });
});`;

describe('serial session secrecy', () => {
  it.each(['static', 'provider'] as const)('retains %s secret redaction and pixel taint across members, resetting on retry', async (source) => {
    let echo = '';
    let launches = 0;
    const observations: { step: string; secretVisible: boolean; pixels: boolean; withheld: string | undefined }[] = [];
    let pixelCaptures = 0;
    const engine = defineEngine({
      name: 'fake', version: '1', spiVersion: 1,
      startAttempt: async () => { echo = ''; launches += 1; },
      observe: async (_operation, options) => {
        if (options?.pixels) pixelCaptures += 1;
        return {
          nodes: [{ ref: { id: 'echo', revision: '' }, role: 'status', text: echo }],
          ...(options?.pixels ? { pixels: { data: new Uint8Array([1]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 } : {}),
        };
      },
      locate: async () => [{ ref: { id: 'field', revision: '' }, role: 'textbox' }],
      perform: async (_ref, action) => { if (action.kind === 'fill') echo = action.value; },
    });
    const project = createProject({ 'tests/serial.e2e.ts': suite });
    try {
      const outcome = await runExisting(project, { appUrl: 'http://127.0.0.1:4599', config: {
        targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off',
        credentials: { audit: { username: 'audit', password: source === 'static' ? SENTINEL : () => SENTINEL } },
        agent: { executor: { name: 'probe', async runStep(context) {
          const observation = await context.observe({ pixels: true });
          observations.push({ step: context.step.instruction, secretVisible: observation.text.includes(SENTINEL),
            pixels: observation.pixels !== undefined, withheld: observation.pixelsWithheld });
          return context.step.instruction === 'next member' && launches === 1
            ? { status: 'failed', summary: 'retry once' }
            : { status: 'passed', summary: 'observed' };
        } } },
      } });
      expect(outcome.status).toBe('passed');
      expect(launches).toBe(2);
      expect(observations).toEqual(Array.from({ length: 2 }, () => [
        { step: 'before fill', secretVisible: false, pixels: true, withheld: undefined },
        { step: 'after fill', secretVisible: false, pixels: false, withheld: 'PIXEL_TAINTED' },
        { step: 'next member', secretVisible: false, pixels: false, withheld: 'PIXEL_TAINTED' },
      ]).flat());
      // Settling captures twice per observation; only the two pre-fill observations request pixels.
      expect(pixelCaptures).toBe(4);
      expect(JSON.stringify(outcome.report)).not.toContain(SENTINEL);
    } finally {
      project.cleanup();
    }
  });
});
