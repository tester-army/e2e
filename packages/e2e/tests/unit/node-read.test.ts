import { describe, expect, it } from 'vitest';
import { validateNodeReadOptions, type NodeReadOptions } from '../../src/engine/node-read.ts';

describe('node read options', () => {
  it.each([undefined, null, [], {}, { style: [] }, { style: ['content'] }, { style: ['background-image'] },
    { style: ['--token'] }, { style: ['COLOR'] }, { style: ['color'], evaluate: 'document.cookie' },
    { style: Array(1) }, { style: Array(11).fill('color') },
  ])('refuses invalid or unbounded requests before engine access: %j', (options) => {
    expect(() => validateNodeReadOptions(options as NodeReadOptions)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('copies and deduplicates the property list', () => {
    const style = ['color', 'color'] as const;
    const checked = validateNodeReadOptions({ style });
    expect(checked).toEqual({ style: ['color'] });
    expect(checked.style).not.toBe(style);
  });
});
