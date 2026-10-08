import { describe, expect, it } from 'vitest';
import { decisionExecutor } from '../src/index.ts';
import { PNG } from 'pngjs';
import { BUTTONS, context, invalidConfig, scriptedDecision, scriptedOutputs, whitePixels } from './helpers.ts';


describe('vision', () => {
  const PIXELS = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 };
  it('with vision, asks for pixels, sends the screenshot, and taps the point two score questions locate', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'done' };
      if (id === 'verdict') return { choice: 'holds' };
      if (id === 'x') return { choice: '2', score: 2.5 };
      if (id === 'y') return { choice: '3', score: 3 };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    const executor = decisionExecutor({ model, vision: true });
    expect(executor.vision).toBe(true);
    const verdict = await executor.runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: true });
    // (2.5 + 0.5) * 80 wide cells, (3 + 0.5) * 75 tall cells.
    expect(fixture.actions.tapAt).toHaveBeenCalledWith({ x: 240, y: 263 });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).toContain('tap_at');
    expect(Object.keys(requests[0]?.questions ?? {})).not.toContain('tap_at_target');
    // The operation question reads the tree alone; the point looks get the pixels.
    expect(requests[0]?.files).toEqual([]);
    expect(requests[1]?.questions['x']).toMatchObject({ type: 'score' });
    const rows = requests[1]?.questions['y']?.criteria as unknown[] | undefined;
    expect(rows?.length).toBe(8);
    expect(requests[1]?.files).toHaveLength(1);
    expect(requests[1]?.files[0]).toMatchObject({ mediaType: 'image/png' });
    // Undecodable pixels go through untouched.
    expect([...(requests[1]?.files[0]?.data as Uint8Array ?? [])]).toEqual([1, 2, 3]);
    expect(fixture.transcripts[0]).toContain('"screenshot":"800x600"');
    expect(fixture.turns[0]?.calls[0]).toBe('tap at (240, 263)');
  });
  it('never offers tap_at to a model that does not score', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('without vision never asks for pixels nor offers tap_at', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: PIXELS } });
    expect(decisionExecutor({ model }).vision).toBeUndefined();
    await decisionExecutor({ model }).runStep(fixture.ctx);
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: false });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('judges an assert with vision only on the pixels alone', async () => {
    const { model, requests } = scriptedDecision(() => ({ choice: 'holds' }));
    const fixture = context({ kind: 'assert', tree: BUTTONS, observation: { pixels: PIXELS }, vision: 'only' });
    const verdict = await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(requests[0]?.state).toMatchObject({ elements: [], page: { text: '' } });
    expect(requests[0]?.files.map((file) => file.mediaType)).toEqual(['image/png']);
  });
  it('rejects a non-boolean vision option', () => {
    const { model } = scriptedDecision(() => ({ choice: 'done' }));
    expect(() => decisionExecutor({ model, vision: 'only' as never })).toThrow(invalidConfig('vision'));
  });
});

describe('vision details', () => {
  it('sends the plain screenshot to the first look and draws the grid only on the zoomed look', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '4' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    const sent = (index: number) => {
      const png = PNG.sync.read(Buffer.from(requests[index]?.files[0]?.data as Uint8Array));
      return { png, at: (x: number, y: number) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)] };
    };
    const full = sent(1);
    expect([full.png.width, full.png.height]).toEqual([800, 600]);
    expect(full.at(159, 300)).toEqual([255, 255, 255]);
    expect(full.at(2, 2)).toEqual([255, 255, 255]);
    expect(requests[1]?.questions['x']?.instructions).toContain('no grid is drawn on it');
    const zoomed = sent(2);
    expect([zoomed.png.width, zoomed.png.height]).toEqual([800, 800]);
    expect(zoomed.at(100, 300)).toEqual([255, 0, 255]);
    expect(zoomed.at(2, 2)).toEqual([255, 255, 255]);
    expect(zoomed.at(250, 250)).toEqual([255, 255, 255]);
    // Column 4 of 10 over 800px and row 4 of 8 over 600px is (360, 338); the 400px zoom around it starts at (160, 138)
    // and settles on its cell 4 center (385, 363).
    expect(requests[1]?.questions['x']?.instructions).toContain('The image is 800 pixels wide and 600 pixels tall');
    expect(requests[2]?.questions['x']?.instructions).toContain('2x zoom of a 400 by 400 pixel region');
    expect(fixture.actions.tapAt).toHaveBeenCalledWith({ x: 160 + 225, y: 138 + 225 });
  });
  it('never asks for pixels once a secret was filled, and offers no tap_at', async () => {
    const { model, requests } = scriptedDecision((id, keys) => ({ choice: id === 'operation' ? 'blocked' : (keys[0] ?? '') }));
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() }, pixelsTainted: true });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(fixture.observe).toHaveBeenCalledWith({ tree: true, pixels: false });
    expect(Object.keys(requests[0]?.questions['operation']?.criteria as object)).not.toContain('tap_at');
  });
  it('judges a vision-only assert from the pixels when the tree is unavailable', async () => {
    const { model, requests } = scriptedDecision(() => ({ choice: 'holds' }));
    const fixture = context({ kind: 'assert', observation: { treeUnavailable: true, pixels: whitePixels() }, vision: 'only' });
    const verdict = await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'passed' });
    expect(requests[0]?.state).toMatchObject({ elements: [], page: { text: '' } });
    const noPixels = context({ kind: 'assert', observation: { treeUnavailable: true }, vision: 'only' });
    expect(await decisionExecutor({ model, vision: true }).runStep(noPixels.ctx)).toMatchObject({ status: 'failed', errorCode: 'ASSERTION_INCONCLUSIVE' });
  });
  it('tells the model where a point tap landed', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '0' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    fixture.actions.tapAt.mockResolvedValue({ point: { x: 80, y: 80 }, target: { id: 'n9' }, summary: 'tapped button "Add"' });
    await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    // Operation, coarse point, zoomed point, then the next operation.
    expect(requests.slice(0, 4).map((request) => Object.keys(request.questions))).toEqual([['operation'], ['x', 'y'], ['x', 'y'], ['operation']]);
    expect(requests[2]?.questions['x']?.instructions).toContain('2x zoom of a 400 by 400 pixel region');
    const state = requests[3]?.state as { recentActions: { note?: string }[] } | undefined;
    expect(state?.recentActions.at(-1)?.note).toBe('landed on listed control n9');
    expect(requests[3]?.questions['operation']?.instructions).toContain('(landed on listed control n9)');
  });
  it('lets the text model name the drawn control the point looks locate', async () => {
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call === 0 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '0' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const text = scriptedOutputs([{ target: 'the 3 key on the keypad' }]);
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() }, model: text.model });
    await decisionExecutor({ model, textModel: text.model, vision: true }).runStep(fixture.ctx);
    expect(text.prompts).toHaveLength(1);
    expect(JSON.stringify(text.prompts[0])).toContain('Do the thing');
    expect(requests[1]?.questions['x']?.instructions).toContain('The control to tap now: the 3 key on the keypad');
    expect(requests[1]?.state).toMatchObject({ target: 'the 3 key on the keypad' });
    expect(fixture.turns[0]?.calls[0]).toMatch(/^tap the 3 key on the keypad at \(\d+, \d+\)$/);
    // Operation, sub-target, two looks, next operation: five model calls recorded.
    expect(fixture.usage).toHaveLength(5);
  });
  it('replays a landed point for the same control on the same page, and relocates one that missed', async () => {
    /** Two screenshots that differ only inside the tapped region. */
    const frame = (dot: boolean) => {
      const png = new PNG({ width: 800, height: 600 });
      png.data.fill(255);
      if (dot) for (let i = 0; i < 4; i += 1) png.data[(100 * 800 + 100) * 4 + i] = 0;
      return { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 };
    };
    const { model, requests } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call < 12 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '1' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const text = scriptedOutputs(Array.from({ length: 12 }, () => ({ target: 'the 1 key' })));
    const fixture = context({ tree: BUTTONS, observation: { pixels: frame(false) }, model: text.model });
    let look = 0;
    fixture.observe.mockImplementation(async () => ({
      revision: String(look += 1), text: 'x', truncated: false, viewport: { width: 800, height: 600 }, tree: BUTTONS,
      // The first tap changes the pixels under it for good; the second changes nothing.
      pixels: frame(look >= 2),
    }));
    await decisionExecutor({ model, textModel: text.model, vision: true }).runStep(fixture.ctx);
    const kinds = requests.map((request) => Object.keys(request.questions).join('+'));
    // Tap 1 locates (two looks) and lands; tap 2 replays the point with no looks; tap 2 misses, so tap 3 locates again.
    expect(kinds.slice(0, 8)).toEqual(['operation', 'x+y', 'x+y', 'operation', 'operation', 'x+y', 'x+y', 'operation']);
    // Level 1 of 10 over 800px and of 8 over 600px is (120, 113); the 400px zoom around it clamps to the corner,
    // and level 1 of its 8 cells is (150, 150) at 2x, so (75, 75).
    expect(fixture.actions.tapAt).toHaveBeenNthCalledWith(1, { x: 75, y: 75 });
    expect(fixture.actions.tapAt).toHaveBeenNthCalledWith(2, { x: 75, y: 75 });
  });
  it('counts a pixel change as a page change under vision, so a drawn control is progress', async () => {
    const { model } = scriptedDecision((id, keys, call) => {
      if (id === 'operation') return { choice: call < 9 ? 'tap_at' : 'blocked' };
      if (id === 'x' || id === 'y') return { choice: '1' };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS });
    let look = 0;
    fixture.observe.mockImplementation(async () => {
      look += 1;
      const png = new PNG({ width: 800, height: 600 });
      png.data.fill(255);
      png.data[look] = 0;
      return { revision: String(look), text: 'x', truncated: false, viewport: { width: 800, height: 600 }, tree: BUTTONS, pixels: { data: new Uint8Array(PNG.sync.write(png)), mediaType: 'image/png' as const, width: 800, height: 600, scale: 1, maskedRegionCount: 0 } };
    });
    const verdict = await decisionExecutor({ model, vision: true }).runStep(fixture.ctx);
    expect(verdict).toMatchObject({ status: 'blocked', summary: 'The decision model cannot make progress.' });
    expect(fixture.actions.tapAt).toHaveBeenCalledTimes(3);
    const noVision = context({ tree: BUTTONS });
    noVision.observe.mockImplementation(fixture.observe.getMockImplementation()!);
    const { model: plain } = scriptedDecision((id, keys, call) => ({ choice: id === 'operation' ? (call < 9 ? 'tap' : 'blocked') : (keys[0] ?? '') }));
    expect(await decisionExecutor({ model: plain }).runStep(noVision.ctx)).toMatchObject({ summary: 'Three actions in a row changed nothing on screen.' });
  });
  it('gates a point on the mass around the scored position, not the top level', async () => {
    const { model } = scriptedDecision((id, keys) => {
      if (id === 'operation') return { choice: 'tap_at' };
      // Half the mass on level 2 and half on level 3: a precise position between them.
      if (id === 'x' || id === 'y') return { choice: '2', score: 2.5, probabilities: Object.fromEntries(keys.map((key) => [key, key === '2' || key === '3' ? 0.5 : 0])) };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const fixture = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    await decisionExecutor({ model, vision: true, minProbability: 0.9 }).runStep(fixture.ctx);
    expect(fixture.actions.tapAt).toHaveBeenCalled();
    const { model: spread } = scriptedDecision((id, keys) => {
      if (id === 'operation') return { choice: 'tap_at' };
      // Mass split far apart: the weighted mean is 4, with nothing near it.
      if (id === 'x' || id === 'y') return { choice: '2', score: 4, probabilities: Object.fromEntries(keys.map((key) => [key, key === '2' || key === '6' ? 0.5 : 0])) };
      return { choice: keys[0] ?? '' };
    }, { supported: ['choice', 'score'] });
    const wide = context({ tree: BUTTONS, observation: { pixels: whitePixels() } });
    expect(await decisionExecutor({ model: spread, vision: true, minProbability: 0.5 }).runStep(wide.ctx)).toMatchObject({ status: 'blocked', summary: expect.stringContaining('tap point is uncertain') });
    expect(wide.actions.tapAt).not.toHaveBeenCalled();
  });
});
