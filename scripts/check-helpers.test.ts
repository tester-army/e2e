import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { collectEngineImports } from './check-helpers.ts';

describe('collectEngineImports', () => {
  it('names the file that fails to parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-check-helpers-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg' }));
      writeFileSync(join(dir, 'src', 'broken.ts'), 'export const = ;\n');
      assert.throws(
        () => collectEngineImports(join(dir, 'package.json')),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /broken\.ts/);
          assert.match(error.message, /failed to parse/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
