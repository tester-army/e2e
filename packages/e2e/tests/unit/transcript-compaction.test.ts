/**
 * Transcript elision: superseded full screens and screenshots become notices
 * in one batch once they outgrow their budget; change updates and every text
 * survive verbatim.
 */

import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactScreenHistory, compactScreenshotHistory } from '../../src/agent/transcript-compaction.ts';

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
});

describe('compactScreenshotHistory', () => {
  const png = Buffer.from('not really a png').toString('base64');
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

  it('honours a caller-supplied preserve count and batch size', () => {
    const messages = [shot('t1'), shot('t2'), shot('t3')];
    expect(images(compactScreenshotHistory(messages, { preserve: 1, batch: 1 }))).toBe(1);
  });
});
