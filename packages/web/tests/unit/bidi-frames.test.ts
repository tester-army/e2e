/**
 * Nested documents on the BiDi driver: the frame chain a locate resolves,
 * the expression a frame's document answers, and boxes placed in the
 * top-level viewport.
 */

import { describe, expect, it } from 'vitest';
import type { LocatorExpression, SemanticNode } from 'e2e/engine';
import { FrameRegistry, inViewport, resolveFrames, selectorLocator, withinFrame } from '../../src/bidi/frames.ts';
import { chainParts } from '../../src/bidi/selector-tokens.ts';
import { project, type Projection } from '../../src/bidi/projection.ts';
import { ElementRef } from '../../src/bidi/script.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

/** An exact string pattern. */
const text = (value: string) => ({ kind: 'string' as const, value, exact: true });
const note: LocatorExpression = { kind: 'query', query: { kind: 'label', value: text('Note') } };

/** Scripts the CSS lookup per context and each iframe's `contentWindow`. */
function frames(iframes: Record<string, string[]>, windows: Record<string, string>): FakeBidi {
  return new FakeBidi().on('script.callFunction', (params) => {
    const [first] = params['arguments'] as ({ type: 'string'; value: string } | { sharedId: string })[];
    if (first !== undefined && 'type' in first) {
      const found = iframes[String((params['target'] as { context: string }).context)] ?? [];
      const value = found.map((sharedId) => ({ type: 'object', value: [['element', { type: 'node', sharedId }], ['localName', { type: 'string', value: 'iframe' }]] }));
      return { result: { type: 'success', realm: 'r', result: { type: 'array', value } } };
    }
    return { result: { type: 'success', realm: 'r', result: { type: 'window', value: { context: windows[(first as { sharedId: string }).sharedId] } } } };
  });
}

describe('resolveFrames', () => {
  it('walks each selector into the document of the frame before it and records the chain', async () => {
    const fake = frames({ top: ['outer'], 'outer-doc': ['inner'] }, { outer: 'outer-doc', inner: 'inner-doc' });
    const registry = new FrameRegistry();
    await expect(resolveFrames(fake.connection, 'top', ['#outer', '#inner'], registry)).resolves.toBe('inner-doc');
    expect(registry.chain('inner-doc')).toEqual([
      { element: new ElementRef('outer'), context: 'top' },
      { element: new ElementRef('inner'), context: 'outer-doc' },
    ]);
    expect(registry.chain('top')).toEqual([]);
  });

  it('is retryable FRAME_NOT_FOUND for no match and FRAME_AMBIGUOUS for two', async () => {
    await expect(resolveFrames(frames({}, {}).connection, 'top', ['#editor'], new FrameRegistry())).rejects.toMatchObject({ code: 'FRAME_NOT_FOUND', retryable: true });
    await expect(resolveFrames(frames({ top: ['a', 'b'] }, {}).connection, 'top', ['iframe'], new FrameRegistry())).rejects.toMatchObject({ code: 'FRAME_AMBIGUOUS' });
  });
});

/** A peer whose `FRAME_BOX` reads answer each iframe's content box and scale by its shared id. */
function measured(steps: Record<string, { content: Record<string, number>; scale?: Record<string, number> }>): FakeBidi {
  const object = (values: Record<string, number>) => ({ type: 'object', value: Object.entries(values).map(([key, value]) => [key, { type: 'number', value }]) });
  return new FakeBidi().on('script.callFunction', (params) => {
    const element = (params['arguments'] as { sharedId: string }[])[0]!;
    const step = steps[element.sharedId]!;
    return { result: { type: 'success', realm: 'r', result: { type: 'object', value: [['content', object(step.content)], ['scale', object(step.scale ?? { x: 1, y: 1 })]] } } };
  });
}

/** A registry holding `inner-doc` in `inner`, held by `outer` in the top document. */
function nested(): FrameRegistry {
  const registry = new FrameRegistry();
  registry.enter('outer-doc', { element: new ElementRef('outer'), context: 'top' });
  registry.enter('inner-doc', { element: new ElementRef('inner'), context: 'outer-doc' });
  return registry;
}

describe('FrameRegistry.viewportBox', () => {
  it('nests each holding frame’s content box into the top-level viewport', async () => {
    const fake = measured({ outer: { content: { x: 102, y: 52, width: 396, height: 296 } }, inner: { content: { x: 10, y: 20, width: 100, height: 100 } } });
    const registry = nested();
    await expect(registry.viewportBox(fake.connection, 'inner-doc')).resolves.toEqual({ origin: { x: 112, y: 72 }, scale: { x: 1, y: 1 }, clip: { x: 112, y: 72, width: 100, height: 100 } });
    await expect(registry.viewportBox(fake.connection, 'top')).resolves.toBeUndefined();
  });

  it('keeps an inner frame’s origin where it lies when its parent clips it', async () => {
    const fake = measured({ outer: { content: { x: 100, y: 0, width: 400, height: 300 } }, inner: { content: { x: -50, y: 10, width: 200, height: 100 } } });
    await expect(nested().viewportBox(fake.connection, 'inner-doc')).resolves.toEqual({ origin: { x: 50, y: 10 }, scale: { x: 1, y: 1 }, clip: { x: 100, y: 10, width: 150, height: 100 } });
  });

  it('scales an inner frame’s coordinates by the outer frame’s transform', async () => {
    const fake = measured({ outer: { content: { x: 0, y: 0, width: 200, height: 200 }, scale: { x: 0.5, y: 0.5 } }, inner: { content: { x: 100, y: 40, width: 100, height: 100 } } });
    await expect(nested().viewportBox(fake.connection, 'inner-doc')).resolves.toEqual({ origin: { x: 50, y: 20 }, scale: { x: 0.5, y: 0.5 }, clip: { x: 50, y: 20, width: 50, height: 50 } });
  });
});

/** The corners of the axis-aligned quad at `x`, `y` sized `width` by `height`, flattened as CDP's `DOM.getContentQuads` reports them. */
function flatQuad(x: number, y: number, width: number, height: number): number[] {
  return [x, y, x + width, y, x + width, y + height, x, y + height];
}

/**
 * A Chromium peer where both frames are turned: each reports its 100 by 100
 * border box and no inset, CDP places `outer` at (100, 50) and `inner` at
 * `innerQuad`, and `sessions` names each document's CDP session.
 */
function turnedChromium(innerQuad: number[], sessions: Record<string, string>): FakeBidi {
  const number = (value: number) => ({ type: 'number', value });
  const box = { type: 'object', value: [['width', number(100)], ['height', number(100)], ['inset', { type: 'object', value: [['x', number(0)], ['y', number(0)], ['width', number(100)], ['height', number(100)]] }], ['quad', { type: 'null' }]] };
  return new FakeBidi()
    .on('script.callFunction', (params) => {
      const measuresBorder = String(params['functionDeclaration']).includes('getBoxQuads');
      return { result: { type: 'success', realm: 'r', result: measuresBorder ? box : { type: 'string', value: 'turned' } } };
    })
    .on('goog:cdp.getSession', (params) => ({ result: { session: sessions[String(params['context'])] } }))
    .on('goog:cdp.sendCommand', (params) => {
      const { backendNodeId } = params['params'] as { backendNodeId: number };
      return { result: { result: { quads: [backendNodeId === 11 ? flatQuad(100, 50, 100, 100) : innerQuad] }, session: params['session'] } };
    });
}

/** `nested()` with element ids that carry CDP backend node ids, as chromium-bidi mints them. */
function nestedChromium(): FrameRegistry {
  const registry = new FrameRegistry();
  registry.enter('outer-doc', { element: new ElementRef('f.A.d.B.e.11'), context: 'top' });
  registry.enter('inner-doc', { element: new ElementRef('f.C.d.D.e.22'), context: 'outer-doc' });
  return registry;
}

/** Where `maps`, innermost last, take `point` in the top-level viewport. */
function toTop(maps: readonly Projection[], point: { x: number; y: number }): { x: number; y: number } {
  return maps.reduceRight((at, map) => project(map, at), point);
}

describe('FrameRegistry.frameMaps', () => {
  it('reads a turned frame’s quad in the viewport of its process’s outermost document', async () => {
    const fake = turnedChromium(flatQuad(110, 70, 100, 100), { top: 'page', 'outer-doc': 'page' });
    const maps = await nestedChromium().frameMaps(fake.connection, 'inner-doc', 'chromium');
    expect(toTop(maps!, { x: 5, y: 5 })).toEqual({ x: 115, y: 75 });
  });

  it('reads it in the frame’s own document when another process renders that document', async () => {
    const fake = turnedChromium(flatQuad(10, 20, 100, 100), { top: 'page', 'outer-doc': 'oopif' });
    const maps = await nestedChromium().frameMaps(fake.connection, 'inner-doc', 'chromium');
    expect(toTop(maps!, { x: 5, y: 5 })).toEqual({ x: 115, y: 75 });
  });

  it('maps an unturned chain by each frame’s content box and scale, without CDP', async () => {
    const fake = measured({ outer: { content: { x: 100, y: 50, width: 200, height: 200 }, scale: { x: 0.5, y: 0.5 } }, inner: { content: { x: 10, y: 20, width: 100, height: 100 } } });
    const maps = await nested().frameMaps(fake.connection, 'inner-doc', 'chromium');
    expect(toTop(maps!, { x: 4, y: 4 })).toEqual({ x: 107, y: 62 });
    expect(fake.commands('goog:cdp.getSession')).toEqual([]);
  });
});

describe('withinFrame', () => {
  it('drops the frame steps wherever they sit in the expression', () => {
    const framed: LocatorExpression = { kind: 'frame', selector: '#editor', source: note };
    expect(withinFrame(framed)).toEqual(note);
    expect(withinFrame({ kind: 'index', index: 'first', source: framed })).toEqual({ kind: 'index', index: 'first', source: note });
    expect(withinFrame({ kind: 'filter', source: framed, has: framed })).toEqual({ kind: 'filter', source: note, has: note });
  });
});

describe('inViewport', () => {
  const node: SemanticNode = { ref: { id: 'n1', revision: '' }, states: {}, attributes: {}, inputPurpose: 'none', rect: { x: 10, y: 10, width: 50, height: 20 } };

  it('shifts a box into the frame, clips it, and sets the frame path', () => {
    expect(inViewport(node, { origin: { x: 100, y: 200 }, scale: { x: 1, y: 1 }, clip: { x: 100, y: 200, width: 40, height: 400 } }, ['#editor'])).toMatchObject({
      rect: { x: 110, y: 210, width: 30, height: 20 },
      framePath: ['#editor'],
    });
  });

  it('drops the box of a node outside its frame or in a frame with no box', () => {
    expect(inViewport(node, { origin: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, clip: { x: 0, y: 0, width: 5, height: 5 } }, ['#f']).rect).toBeUndefined();
    expect(inViewport(node, null, ['#f']).rect).toBeUndefined();
    expect(inViewport(node, undefined, [])).toBe(node);
  });
});

describe('selectorLocator', () => {
  /** The locator of `selector`'s only chain part. */
  const locator = (selector: string): unknown => selectorLocator(chainParts(selector)[0]!, selector);

  it('reads a selector as Playwright does: a prefix names the engine, a path is XPath, the rest CSS', () => {
    expect(locator('xpath=//iframe')).toEqual({ type: 'xpath', value: '//iframe' });
    expect(locator('css=#a > b')).toEqual({ type: 'css', value: '#a > b' });
    expect(locator('//li')).toEqual({ type: 'xpath', value: '//li' });
    expect(locator('(//li)[2]')).toEqual({ type: 'xpath', value: '(//li)[2]' });
    expect(locator('../a')).toEqual({ type: 'xpath', value: '../a' });
    expect(locator('iframe[name="pay"]')).toEqual({ type: 'css', value: 'iframe[name="pay"]' });
    expect(locator('* > button')).toEqual({ type: 'css', value: '* > button' });
  });

  it('rejects an engine other than CSS and XPath', () => {
    expect(() => locator('text=Hello')).toThrow('the text= engine is not supported');
  });
});
