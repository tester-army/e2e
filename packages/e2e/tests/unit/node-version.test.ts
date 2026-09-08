import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION, unsupportedNodeMessage } from '../../src/internal/node-version.ts';

describe('unsupportedNodeMessage', () => {
  it('mirrors the engines field of package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };
    expect(manifest.engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`);
  });

  it('accepts the floor and anything newer', () => {
    expect(unsupportedNodeMessage('22.12.0')).toBeUndefined();
    expect(unsupportedNodeMessage('v22.12.1')).toBeUndefined();
    expect(unsupportedNodeMessage('24.0.0')).toBeUndefined();
    expect(unsupportedNodeMessage('26.4.0')).toBeUndefined();
  });

  it('names both versions and how to switch for anything older', () => {
    const message = unsupportedNodeMessage('v18.20.4');
    expect(message).toContain('requires Node.js 22.12.0 or newer');
    expect(message).toContain('this is Node.js 18.20.4');
    expect(message).toContain('nvm use 22');
    expect(unsupportedNodeMessage('22.11.9')).toBeDefined();
    expect(unsupportedNodeMessage('20.19.0')).toBeDefined();
  });
});
