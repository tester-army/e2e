/**
 * `@e2e-dev/mobile/agent-device` is a public surface, so its runtime values
 * are pinned here, and every export map entry must point at a module that
 * the build emits.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as subpath from '../../src/agent-device.ts';

const PACKAGE = new URL('../../', import.meta.url);

describe('@e2e-dev/mobile/agent-device', () => {
  it('exports the chosen values, with no client factory or daemon lifecycle', () => {
    expect(Object.keys(subpath).toSorted()).toEqual([
      'AppError',
      'centerOfRect',
      'isAgentDeviceError',
      'normalizeAgentDeviceError',
    ]);
  });

  it('maps every export entry to a source module', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', PACKAGE), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
    for (const [entry, { types, default: js }] of Object.entries(manifest.exports)) {
      const source = js.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(types, entry).toBe(js.replace(/\.js$/, '.d.ts'));
      expect(existsSync(new URL(source, PACKAGE)), `${entry} -> ${source}`).toBe(true);
    }
  });
});
