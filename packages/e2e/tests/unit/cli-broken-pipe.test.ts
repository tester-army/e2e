import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ignoreBrokenPipes } from '../../src/cli/broken-pipe.ts';

/** An errno error as a failed write reports it. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code });
}

describe('ignoreBrokenPipes', () => {
  it('drops EPIPE', () => {
    const stream = new PassThrough();
    ignoreBrokenPipes([stream]);
    expect(() => stream.emit('error', errno('EPIPE'))).not.toThrow();
  });

  it('throws any other error nothing else handles', () => {
    const stream = new PassThrough();
    ignoreBrokenPipes([stream]);
    expect(() => stream.emit('error', errno('EIO'))).toThrow('write EIO');
  });

  it('leaves any other error to a listener of its own, as the MCP server has', () => {
    const stream = new PassThrough();
    const seen: unknown[] = [];
    ignoreBrokenPipes([stream]);
    stream.on('error', (error) => seen.push(error));
    const error = errno('EIO');
    expect(() => stream.emit('error', error)).not.toThrow();
    expect(seen).toEqual([error]);
  });
});
