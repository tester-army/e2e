import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runtimeOf, SUPPORTED_BUN_RANGE, SUPPORTED_NODE_RANGE, unsupportedRuntimeMessage } from '../../src/internal/runtime.ts';

const unsupportedNodeMessage = (node: string): string | undefined => unsupportedRuntimeMessage({ node }, true);

describe('unsupportedRuntimeMessage', () => {
  it('mirrors the engines field of every published package', () => {
    expect(SUPPORTED_NODE_RANGE).toBe('^22.22.3 || >=24.8.0');
    const packages = new URL('../../../', import.meta.url);
    for (const dir of readdirSync(packages).filter((name) => existsSync(new URL(`${name}/package.json`, packages)))) {
      const manifest = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packages), 'utf8')) as { name: string; engines: { node: string } };
      expect({ name: manifest.name, node: manifest.engines.node }).toEqual({ name: manifest.name, node: SUPPORTED_NODE_RANGE });
    }
  });

  it.each(['22.22.3', 'v22.23.3', '24.8.0', '24.19.0', '25.0.0', '26.4.0'])('accepts Node.js %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeUndefined();
  });

  it.each(['18.20.4', '20.19.0', '22.12.0', '22.22.2', '23.11.1', '24.7.0'])('refuses Node.js %s', (version) => {
    expect(unsupportedNodeMessage(version)).toBeDefined();
  });

  it('names both floors, the running version, and how to switch', () => {
    const message = unsupportedNodeMessage('v22.18.0');
    expect(message).toBe(
      'e2e requires Node.js 22.22.3 or newer on Node.js 22, or 24.8.0 or newer; this is Node.js 22.18.0. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).',
    );
  });

  it('asks an old Node.js to upgrade even though it has no module.registerHooks', () => {
    expect(unsupportedRuntimeMessage({ node: '22.12.0' }, false)).toContain('e2e requires Node.js 22.22.3 or newer');
  });

  it('refuses a runtime that reports a supported Node.js without module.registerHooks', () => {
    expect(unsupportedRuntimeMessage({ node: '24.19.0' }, false)).toBe(
      "e2e runs on Node.js and Bun: this runtime reports Node.js 24.19.0 but has no module.registerHooks, which e2e's TypeScript loader needs. Run the CLI with Node.js (npx e2e) or Bun (bunx --bun e2e).",
    );
    expect(unsupportedRuntimeMessage({ node: '24.19.0' }, true)).toBeUndefined();
  });

  it.each(['1.4.3', '1.4.4', '1.5.0', '2.0.0'])('accepts Bun %s, whatever Node.js it reports and without module.registerHooks', (bun) => {
    expect(SUPPORTED_BUN_RANGE).toBe('>=1.4.3');
    expect(unsupportedRuntimeMessage({ node: '26.3.0', bun }, false)).toBeUndefined();
    expect(unsupportedRuntimeMessage({ node: '22.12.0', bun }, false)).toBeUndefined();
  });

  it.each(['1.4.2', '1.3.14', '1.0.0'])('refuses Bun %s, naming the floor and the way back', (bun) => {
    expect(unsupportedRuntimeMessage({ node: '26.3.0', bun }, false)).toBe(
      `e2e requires Bun 1.4.3 or newer; this is Bun ${bun}. Upgrade Bun (bun upgrade), or run the CLI with Node.js (npx e2e).`,
    );
  });

  it('refuses Deno', () => {
    expect(unsupportedRuntimeMessage({ node: '26.3.0', deno: '2.9.4' }, true)).toBe(
      'e2e runs on Node.js and Bun, not Deno 2.9.4: run the CLI with Node.js (npx e2e) or Bun (bunx --bun e2e).',
    );
  });
});

describe('runtimeOf', () => {
  it('names the runtime by its own version', () => {
    expect(runtimeOf({ node: '24.19.0' })).toEqual({ name: 'node', version: '24.19.0' });
    expect(runtimeOf({ node: '26.3.0', bun: '1.4.4' })).toEqual({ name: 'bun', version: '1.4.4' });
    expect(runtimeOf({ node: '26.3.0', deno: '2.9.4' })).toEqual({ name: 'deno', version: '2.9.4' });
  });
});
