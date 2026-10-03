import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_NODE_RANGE, unsupportedNodeMessage } from '../../src/internal/node-version.ts';

describe('unsupportedNodeMessage', () => {
  it('mirrors the engines field of package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };
    expect(SUPPORTED_NODE_RANGE).toBe('^22.22.3 || >=24.11.0');
    expect(manifest.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it.each(['22.22.3', 'v22.23.3', '24.11.0', '24.19.0', '25.0.0', '26.4.0'])('accepts %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeUndefined();
  });

  it.each(['18.20.4', '20.19.0', '22.12.0', '22.22.2', '23.11.1', '24.10.0'])('refuses %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeDefined();
  });

  it('names both floors, the running version, and how to switch', () => {
    const message = unsupportedNodeMessage('v22.18.0');
    expect(message).toContain('requires Node.js 22.22.3 or newer on its release line, or 24.11.0 or newer');
    expect(message).toContain('this is Node.js 22.18.0');
    expect(message).toContain('nvm use 24');
  });
});
