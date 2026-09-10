import { describe, expect, it } from 'vitest';
import { boundToolOutput, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from '../../src/agent/tool-output.ts';

/** The whole returned text, notice included, must fit the advertised limits. */
function expectWithinLimits(text: string, maxLines = MAX_TOOL_OUTPUT_LINES, maxBytes = MAX_TOOL_OUTPUT_BYTES): void {
  expect(text.split('\n').length).toBeLessThanOrEqual(maxLines);
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(maxBytes);
}

describe('boundToolOutput', () => {
  it('passes a result within both limits through untouched', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${String(i)}`).join('\n');
    expect(boundToolOutput(text)).toEqual({ text, truncated: false, totalLines: 10, totalBytes: text.length });
  });

  it('cuts on the line limit without splitting a line and says what is missing', () => {
    const text = Array.from({ length: MAX_TOOL_OUTPUT_LINES + 100 }, (_, i) => `line ${String(i)}`).join('\n');
    const bound = boundToolOutput(text);
    expect(bound.truncated).toBe(true);
    expect(bound.by).toBe('lines');
    expectWithinLimits(bound.text);
    const lines = bound.text.split('\n');
    expect(lines).toHaveLength(MAX_TOOL_OUTPUT_LINES);
    expect(lines[MAX_TOOL_OUTPUT_LINES - 2]).toBe(`line ${String(MAX_TOOL_OUTPUT_LINES - 2)}`);
    expect(lines.at(-1)).toMatch(/^\[tool output truncated: showing 399 of 500 lines, .* the lines limit was reached\./);
  });

  it('cuts on the byte limit first when the lines are long', () => {
    const text = Array.from({ length: 50 }, () => 'y'.repeat(1000)).join('\n');
    const bound = boundToolOutput(text);
    expect(bound.by).toBe('bytes');
    expectWithinLimits(bound.text);
    const lines = bound.text.split('\n');
    expect(lines).toHaveLength(17);
    expect(lines.slice(0, 16).every((line) => line === 'y'.repeat(1000))).toBe(true);
    expect(lines.at(-1)).toContain('showing 16 of 50 lines');
  });

  it('keeps the head of a single line that is longer than the whole budget', () => {
    const bound = boundToolOutput('z'.repeat(40_000), { maxLines: 10, maxBytes: 1024 });
    expect(bound.truncated).toBe(true);
    expectWithinLimits(bound.text, 10, 1024);
    expect(bound.text.startsWith('z'.repeat(768))).toBe(true);
    expect(bound.text).toContain('showing 1 of 1 lines, 768 B of 39.1 KB');
  });

  it('counts bytes, not characters, for multi-byte text and never cuts inside a character', () => {
    const bound = boundToolOutput('ż'.repeat(600), { maxLines: 10, maxBytes: 1024 });
    expect(bound.truncated).toBe(true);
    expect(bound.totalBytes).toBe(1200);
    expectWithinLimits(bound.text, 10, 1024);
    expect(bound.text).not.toContain('�');
  });
});
