/**
 * Transcript elision: superseded full screens and screenshots become notices
 * in one batch once they outgrow their budget; change updates and every text
 * survive verbatim.
 */

import type { ModelMessage, ToolResultPart } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactScreenHistory, compactScreenshotHistory } from '../../src/agent/transcript-compaction.ts';

const png = Buffer.from('not really a png').toString('base64');
const image = { type: 'file', data: { type: 'data', data: png }, mediaType: 'image/png' } as const;

function fullScreenResult(id: string, revision: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'tap',
        output: { type: 'text', value: `Tapped #n3.\n\nThe screen changed substantially since revision b0. Current screen (revision ${revision}, 2 nodes):\n#n1 document\n #n2 heading "X"` },
      },
    ],
  };
}

/** A grammar result once the step shows pixels: the full screen, `rows` deep, and the screenshot note as one text item, then the image. */
function pixelScreenResult(id: string, revision: string, rows = 1): ModelMessage {
  const tree = Array.from({ length: rows }, (_, index) => ` #n${String(index + 2)} heading "X${String(index)}"`).join('\n');
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'tap',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: `Tapped #n3.\n\nThe screen changed substantially since revision b0. Current screen (revision ${revision}, ${String(rows + 1)} nodes):\n#n1 document\n${tree}\n\nScreenshot attached: 640 by 360 pixels.` },
            image,
          ],
        },
      },
    ],
  };
}

/** The output of a tool message's one result. */
function toolOutput(message: ModelMessage): ToolResultPart['output'] {
  const [part] = message.content as ToolResultPart[];
  return part!.output;
}

/** Characters of text a transcript carries, the text beside a screenshot included; the overflow retry's measure. */
function textChars(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length;
    return message.content.reduce((inner, part) => {
      if (part.type === 'text') return inner + part.text.length;
      if (part.type !== 'tool-result') return inner;
      if (part.output.type === 'text') return inner + part.output.value.length;
      if (part.output.type !== 'content') return inner;
      return inner + part.output.value.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0);
    }, total);
  }, 0);
}

function changesResult(id: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'type',
        output: { type: 'text', value: 'Typed into #n6.\n\nScreen changes since revision b1 (now revision b2, 6 nodes): 1 changed. Every node not listed as removed is still on screen under the id you have.\nchanged #n6 textbox "Email" value="a" (was: #n6 textbox "Email")' },
      },
    ],
  };
}

describe('compactScreenHistory', () => {
  const opening: ModelMessage = {
    role: 'user',
    content: 'Execute this test step: do the thing\n\nCurrent screen (revision b0, 2 nodes):\n#n1 document\n #n2 heading "Home"',
  };

  it('leaves the transcript alone while only one full screen is present', () => {
    const messages = [opening, changesResult('c1'), changesResult('c3')];
    expect(compactScreenHistory(messages)).toBe(messages);
  });

  it('keeps small superseded screens verbatim so the request prefix stays cacheable', () => {
    const messages = [opening, changesResult('c1'), fullScreenResult('c2', 'b2'), fullScreenResult('c4', 'b4')];
    expect(compactScreenHistory(messages)).toBe(messages);
    expect(compactScreenHistory(messages, { keepStaleBytes: 1024 })).toBe(messages);
  });

  it('elides the older full screens in one batch once they outgrow the budget, and never a change update', () => {
    const messages = [
      opening,
      changesResult('c1'),
      fullScreenResult('c2', 'b2'),
      changesResult('c3'),
      fullScreenResult('c4', 'b4'),
    ];
    expect(compactScreenHistory(messages, { keepStaleBytes: 1024 })).toBe(messages);
    const compacted = compactScreenHistory(messages, { keepStaleBytes: 0 });
    expect(compacted).not.toBe(messages);
    expect(compacted[0]!.content).toBe(
      'Execute this test step: do the thing\n[earlier screen elided; the newest "Current screen" plus the changes after it describe the screen]',
    );
    // The middle full screen is elided down to its lead; the newest full
    // screen and every change update survive verbatim.
    const middle = compacted[2]!.content as Extract<ModelMessage, { role: 'tool' }>['content'];
    expect(middle[0]).toMatchObject({
      output: { type: 'text', value: expect.stringMatching(/^Tapped #n3\.\n\nThe screen changed substantially since revision b0\.\n\[earlier screen elided/) },
    });
    expect(compacted[1]).toEqual(messages[1]);
    expect(compacted.slice(3)).toEqual(messages.slice(3));
  });

  it('elides full screens that arrived with a screenshot, keeping the lead and the image', () => {
    const messages = [opening, pixelScreenResult('c1', 'b1'), pixelScreenResult('c2', 'b2'), pixelScreenResult('c3', 'b3'), pixelScreenResult('c4', 'b4')];
    expect(compactScreenHistory(messages, { keepStaleBytes: 1024 })).toBe(messages);
    const compacted = compactScreenHistory(messages, { keepStaleBytes: 0 });
    expect(compacted).not.toBe(messages);
    expect(compacted[0]!.content).toContain('[earlier screen elided');
    for (const index of [1, 2, 3]) {
      expect(toolOutput(compacted[index]!)).toEqual({
        type: 'content',
        value: [
          { type: 'text', text: 'Tapped #n3.\n\nThe screen changed substantially since revision b0.\n[earlier screen elided; the newest "Current screen" plus the changes after it describe the screen]' },
          image,
        ],
      });
    }
    expect(compacted[4]).toEqual(messages[4]);
  });

  it('keeps the notice that replaced a screenshot when the screen beside it is elided', () => {
    const messages = [opening, pixelScreenResult('c1', 'b1'), pixelScreenResult('c2', 'b2')];
    const compacted = compactScreenHistory(compactScreenshotHistory(messages, { preserve: 1, batch: 1 }), { keepStaleBytes: 0 });
    expect(toolOutput(compacted[1]!)).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: expect.stringContaining('[earlier screen elided') },
        { type: 'text', text: '[earlier screenshot elided; the newest screenshots show the current screen]' },
      ],
    });
    expect(compacted[2]).toEqual(messages[2]);
  });

  it('shrinks a pixel-mode history on the budget-free pass the overflow retry runs after the cache-friendly pass kept it', () => {
    const messages = [opening, pixelScreenResult('c1', 'b1', 40), changesResult('c2'), fullScreenResult('c3', 'b3'), pixelScreenResult('c4', 'b4', 40)];
    const kept = compactScreenHistory(messages);
    expect(kept).toBe(messages);
    const shrunk = compactScreenHistory(kept, { keepStaleBytes: 0 });
    expect(textChars(shrunk)).toBeLessThan(textChars(kept));
    // Text and pixel screens elide alike; the change update and the newest screen survive whole.
    expect(toolOutput(shrunk[3]!)).toMatchObject({ type: 'text', value: expect.stringContaining('[earlier screen elided') });
    expect(shrunk[2]).toEqual(messages[2]);
    expect(shrunk[4]).toEqual(messages[4]);
  });
});

describe('compactScreenshotHistory', () => {
  const shot = (id: string): ModelMessage => ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'tap_at',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: `Tapped the point (1, 1). Screen changes (${id}).` },
            { type: 'file', data: { type: 'data', data: png }, mediaType: 'image/png' },
          ],
        },
      },
    ],
  });
  const opening: ModelMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'Execute this test step: tap the pin\n\nCurrent screen (revision b1, 3 nodes):\n#n1 document' },
      { type: 'file', data: png, mediaType: 'image/png' },
    ],
  };
  const images = (messages: readonly ModelMessage[]): number =>
    messages.reduce((count, message) => {
      if (message.role === 'user' && typeof message.content !== 'string') {
        return count + message.content.filter((part) => part.type === 'file').length;
      }
      if (message.role !== 'tool') return count;
      return (
        count +
        message.content.reduce(
          (inner, part) =>
            part.type === 'tool-result' && part.output.type === 'content'
              ? inner + part.output.value.filter((item) => item.type === 'file').length
              : inner,
          0,
        )
      );
    }, 0);

  it('keeps every screenshot while few are stale, so the request prefix stays cacheable', () => {
    const messages = [opening, shot('t1'), shot('t2'), shot('t3')];
    expect(compactScreenshotHistory(messages)).toBe(messages);
    expect(images(messages)).toBe(4);
  });

  it('elides the older screenshots in one batch, keeping the newest two and every text', () => {
    const messages = [opening, shot('t1'), shot('t2'), shot('t3'), shot('t4')];
    const compacted = compactScreenshotHistory(messages);
    expect(compacted).not.toBe(messages);
    expect(images(compacted)).toBe(2);
    const first = compacted[0]!;
    expect(first.role).toBe('user');
    expect(JSON.stringify(first)).toContain('[earlier screenshot elided');
    expect(JSON.stringify(first)).toContain('Current screen (revision b1');
    const t1 = compacted[1]!;
    expect(JSON.stringify(t1)).toContain('Tapped the point (1, 1). Screen changes (t1).');
    expect(JSON.stringify(t1)).not.toContain('"type":"file"');
    expect(JSON.stringify(compacted[4]!)).toContain('"type":"file"');
  });
});
