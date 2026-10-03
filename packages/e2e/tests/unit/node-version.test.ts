import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importedCommonJsRequireRunsHooks, SUPPORTED_NODE_RANGE, unsupportedNodeMessage } from '../../src/internal/node-version.ts';

describe('unsupportedNodeMessage', () => {
  it('mirrors the engines field of every published package', () => {
    expect(SUPPORTED_NODE_RANGE).toBe('^22.22.3 || >=24.8.0');
    const packages = new URL('../../../', import.meta.url);
    for (const dir of readdirSync(packages).filter((name) => existsSync(new URL(`${name}/package.json`, packages)))) {
      const manifest = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packages), 'utf8')) as { name: string; engines: { node: string } };
      expect({ name: manifest.name, node: manifest.engines.node }).toEqual({ name: manifest.name, node: SUPPORTED_NODE_RANGE });
    }
  });

  it.each(['22.22.3', 'v22.23.3', '24.8.0', '24.19.0', '25.0.0', '26.4.0'])('accepts %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeUndefined();
  });

  it.each(['18.20.4', '20.19.0', '22.12.0', '22.22.2', '23.11.1', '24.7.0'])('refuses %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeDefined();
  });

  it('names both floors, the running version, and how to switch', () => {
    const message = unsupportedNodeMessage('v22.18.0');
    expect(message).toBe(
      'e2e requires Node.js 22.22.3 or newer on Node.js 22, or 24.8.0 or newer; this is Node.js 22.18.0. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).',
    );
  });

  it.each([
    ['22.23.3', false],
    ['24.17.0', false],
    ['24.18.0', true],
    ['25.9.0', false],
    ['26.1.0', false],
    ['26.2.0', true],
    ['27.0.0', true],
  ])('on Node.js %s, the require of a CommonJS module an ES module imported runs hooks: %s', (version, expected) => {
    expect(importedCommonJsRequireRunsHooks(version)).toBe(expected);
  });
});
