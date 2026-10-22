import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import type { ExecutorObservation, StepExecutorContext, StepVerdict } from '../../src/agent/executor.ts';
import type { OcrBox, OcrOptions, OcrProvider, OcrWorkflow } from '../../src/ocr/types.ts';
import { ocrExecutor } from '../../src/ocr/workflow.ts';
import { ocrTools } from '../../src/ocr/tools.ts';
import { projectTools } from '../../src/agent/default-agent.ts';

const line: OcrBox = { text: 'Continue', confidence: 0.96, rect: { x: 20, y: 40, width: 100, height: 30 } };
const passed: StepVerdict = { status: 'passed', summary: 'verified' };

/** Builds a real PNG but no real platform; logical coordinates deliberately differ from image pixels. */
function observation(scale = 2, tint = 255): ExecutorObservation {
  const width = Math.round(100 * scale);
  const height = Math.round(200 * scale);
  const png = new PNG({ width, height });
  png.data.fill(tint);
  return {
    revision: 'r1', text: '#root region', truncated: false, tree: { id: 'root' },
    viewport: { width: 100, height: 200 },
    pixels: { data: PNG.sync.write(png), mediaType: 'image/png', width, height, scale, maskedRegionCount: 0 },
  };
}

/** Minimum scripted harness context; actions are spies, never a device driver. */
function harness(screens: ExecutorObservation[] = [observation()], boxes: readonly OcrBox[] = [line]) {
  const controller = new AbortController();
  let next = 0;
  const observe = vi.fn(async () => screens[Math.min(next++, screens.length - 1)]!);
  const tapAt = vi.fn(async (point: { x: number; y: number }) => ({ point, summary: 'Tapped' }));
  const provider: OcrProvider = { name: 'fixture', recognize: vi.fn(async () => boxes) };
  const context = {
    step: { kind: 'act' }, signal: controller.signal, observe,
    target: { platform: 'fixture', verbs: new Set(['tapAt']) }, actions: { tapAt },
    budgets: { runTool: vi.fn(async (_call, body: () => Promise<unknown>) => body()) },
  } as unknown as StepExecutorContext;
  const run = (body: (ocr: OcrWorkflow) => Promise<unknown>, options: Partial<OcrOptions> = {}) =>
    ocrExecutor({ provider, ...options, runStep: async (_context, ocr) => { await body(ocr); return passed; } }).runStep(context);
  return { context, controller, observe, tapAt, provider, run };
}

describe('optional OCR workflow', () => {
  it('disables only its executor cache and imports no model or engine', () => {
    const h = harness();
    const executor = ocrExecutor({ provider: h.provider, runStep: async () => passed });
    expect(executor.cache).toBe('off');
    expect(executor.model).toBeUndefined();
  });

  it('does not expose direct UI operations that can bypass its freshness queue', async () => {
    const h = harness();
    await ocrExecutor({ provider: h.provider, runStep: async (context, ocr) => {
      expect('actions' in context).toBe(false);
      expect('observe' in context).toBe(false);
      expect('budgets' in context).toBe(false);
      await ocr.tapText({ text: 'Continue' });
      return passed;
    } }).runStep(h.context);
    expect(h.tapAt).toHaveBeenCalledTimes(1);
  });

  it.each([['ios', 3], ['android', 2], ['other', 1], ['downscaled', 0.75]])('uses image scale on %s', async (_platform, scale) => {
    const h = harness([observation(scale)], [{ ...line, rect: { x: 10 * scale, y: 20 * scale, width: 40 * scale, height: 10 * scale } }]);
    await h.run(async (ocr) => {
      const reading = await ocr.read();
      expect(reading.matches[0]).toMatchObject({ rect: { x: 10, y: 20, width: 40, height: 10 }, point: { x: 30, y: 25 } });
      await ocr.tapText({ text: 'Continue' });
    });
    expect(h.tapAt).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 25 });
    expect(h.observe).toHaveBeenCalledWith({ tree: true, pixels: true });
  });

  it('normalizes whitespace and case, with opt-in substring matching', async () => {
    const h = harness([observation()], [{ ...line, text: '  Continue   now ' }]);
    await h.run(async (ocr) => {
      await ocr.assertText({ text: 'CONTINUE now' });
      await ocr.locate({ text: 'Continue', exact: false });
      await expect(ocr.locate({ text: 'Continue' })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
      await expect(ocr.locate({ text: 'CONTINUE now', caseSensitive: true })).rejects.toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('requires a unique confident match or a narrower region', async () => {
    const h = harness([observation()], [line, { ...line, rect: { ...line.rect, y: 150 } }]);
    await h.run(async (ocr) => {
      await expect(ocr.tapText({ text: 'Continue' })).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
      await ocr.tapText({ text: 'Continue', region: { x: 0, y: 0, width: 100, height: 50 } });
    });
    expect(h.tapAt).toHaveBeenCalledTimes(1);
  });

  it('does not treat low confidence or an empty result as a positive assertion', async () => {
    const h = harness([observation()], [{ ...line, confidence: 0.6 }]);
    await h.run(async (ocr) => {
      await expect(ocr.assertText({ text: 'Continue' })).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
      await ocr.locate({ text: 'Continue', minConfidence: 0.5 });
    });
    const empty = harness([observation()], []);
    await empty.run(async (ocr) => {
      expect((await ocr.read()).matches).toEqual([]);
      await expect(ocr.assertText({ text: 'Continue' })).rejects.toMatchObject({ code: 'ASSERTION_FAILED' });
    });
  });

  it('does not recognize withheld or missing pixels', async () => {
    const screen = observation();
    const { pixels: _pixels, ...withoutPixels } = screen;
    for (const candidate of [withoutPixels, { ...screen, pixelsWithheld: 'secret-filled' as const }]) {
      const h = harness([candidate as ExecutorObservation]);
      await expect(h.run((ocr) => ocr.read())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(h.provider.recognize).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['crop', { width: 99, height: 200, scale: 3 }],
    ['rotation', { width: 200, height: 100, scale: 3 }],
    ['invalid width', { width: Number.NaN, height: 200, scale: 3 }],
  ])('refuses %s geometry', async (_name, viewport) => {
    const h = harness([{ ...observation(), viewport }]);
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }))).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('validates the PNG header against declared dimensions', async () => {
    const screen = observation();
    const data = Buffer.from(screen.pixels!.data);
    data.writeUInt32BE(199, 16);
    const h = harness([{ ...screen, pixels: { ...screen.pixels!, data } }]);
    await expect(h.run((ocr) => ocr.read())).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
  });

  it.each([
    { ...line, confidence: Number.NaN }, { ...line, confidence: 2 },
    { ...line, rect: { ...line.rect, x: -1 } }, { ...line, rect: { ...line.rect, x: 199 } },
    { ...line, rect: { ...line.rect, width: 0 } },
  ])('refuses invalid provider output %#', async (box) => {
    const h = harness([observation()], [box]);
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }))).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('refuses changed pixels even when the semantic tree and revision are unchanged', async () => {
    const h = harness([observation(), observation(2, 128)]);
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }))).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('accepts a fresh revision with identical capture and fails changed location', async () => {
    const screen = observation();
    const h = harness([screen, { ...screen, revision: 'r2' }]);
    await h.run((ocr) => ocr.tapText({ text: 'Continue' }));
    expect(h.tapAt).toHaveBeenCalledTimes(1);
    const moved = harness([screen, { ...screen, path: '/other' }]);
    await expect(moved.run((ocr) => ocr.tapText({ text: 'Continue' }))).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('rejects expired captures even if their pixels are unchanged', async () => {
    const h = harness();
    const delayed = { name: 'slow', recognize: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return [line]; } };
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }), { provider: delayed, maxAgeMs: 1 })).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it.each([{ disabled: true }, { secure: true }])('never overrides protected semantic states %j', async (states) => {
    const screen = observation();
    const h = harness([screen, { ...screen, tree: { id: 'root', children: [
      { id: 'button', states, rect: { x: 0, y: 0, width: 100, height: 100 } },
    ] } }]);
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('denies mutation in assert steps before capture', async () => {
    const h = harness();
    const context = { ...h.context, step: { ...h.context.step, kind: 'assert' as const } };
    await expect(ocrExecutor({ provider: h.provider, runStep: async (_ctx, ocr) => {
      await ocr.tapText({ text: 'Continue' }); return passed;
    } }).runStep(context)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(h.observe).not.toHaveBeenCalled();
  });

  it('cancels promptly even if the provider ignores its signal, with no late tap', async () => {
    const h = harness();
    let finish: ((boxes: readonly OcrBox[]) => void) | undefined;
    const provider = { name: 'ignores-abort', recognize: () => new Promise<readonly OcrBox[]>((resolve) => { finish = resolve; }) };
    const promise = h.run((ocr) => ocr.tapText({ text: 'Continue' }), { provider });
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.controller.abort(new Error('cancelled by user'));
    await expect(promise).rejects.toThrow('cancelled by user');
    finish!([line]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('does not recognize or tap after a timed-out capture resolves late', async () => {
    const h = harness();
    let finish: ((screen: ExecutorObservation) => void) | undefined;
    Object.assign(h.context, { observe: () => new Promise<ExecutorObservation>((resolve) => { finish = resolve; }) });
    await expect(h.run((ocr) => ocr.tapText({ text: 'Continue' }), { timeoutMs: 5 })).rejects.toThrow('timed out');
    finish!(observation());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.provider.recognize).not.toHaveBeenCalled();
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('supports permitted pixel-only observations without inventing semantic nodes', async () => {
    const { tree: _tree, ...screen } = observation();
    const h = harness([{ ...screen, treeUnavailable: true }]);
    await h.run((ocr) => ocr.tapText({ text: 'Continue' }));
    expect(h.tapAt).toHaveBeenCalledExactlyOnceWith({ x: 35, y: 27.5 });
  });

  it('bounds a hanging provider and hides its raw error text', async () => {
    const h = harness();
    await expect(h.run((ocr) => ocr.read(), { timeoutMs: 5,
      provider: { name: 'hangs', recognize: () => new Promise(() => undefined) },
    })).rejects.toThrow('timed out');
    const failed = h.run((ocr) => ocr.read(), { provider: { name: 'fails', recognize: async () => { throw new Error('sensitive provider output'); } } });
    await expect(failed).rejects.toMatchObject({ code: 'AUTOMATION_UNSUPPORTED' });
    await expect(failed).rejects.not.toThrow('sensitive');
  });

  it('serializes concurrent OCR calls', async () => {
    const h = harness();
    await h.run(async (ocr) => { await Promise.all([ocr.tapText({ text: 'Continue' }), ocr.read()]); });
    expect(h.observe.mock.invocationCallOrder[1]).toBeLessThan(h.tapAt.mock.invocationCallOrder[0]!);
    expect(h.tapAt.mock.invocationCallOrder[0]).toBeLessThan(h.observe.mock.invocationCallOrder[2]!);
  });

  it('offers a read-only evidence tool through the existing tool context', async () => {
    const h = harness();
    const tools = ocrTools({ provider: h.provider });
    expect(tools['screenshot_ocr']?.annotations.mutates).toBe(false);
    const wrapped = projectTools(h.context, tools)['screenshot_ocr']!;
    const result = await wrapped.execute!({} as never, { toolCallId: 'ocr', messages: [], context: undefined });
    expect(result).toContain('Continue');
    expect(result).toContain('logical viewport');
    expect(h.tapAt).not.toHaveBeenCalled();
  });

  it('rejects invalid configuration and query', async () => {
    const h = harness();
    expect(() => ocrExecutor({ provider: h.provider, timeoutMs: 0, runStep: async () => passed })).toThrow('positive');
    await expect(h.run((ocr) => ocr.locate({ text: '' }))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
